import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import { CoverageStrip } from './CoverageStrip';

afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({ source_system: 'ORACLE_EBS', projects: 22, mapped: 18, direct_only: 4, unmapped: 0, proposed: 2, shadows: 0, direct_fallback: true, ...over });

/** The reach of the project codes of each system (ENT-3e, R25): what is mapped, what only the fallback serves, what waits, what is in conflict. */
describe('CoverageStrip (INT-03): the reach of the project codes by system', () => {
  it('shows nothing when the server sent no coverage or no project to cover', () => {
    const { container, rerender } = render(<CoverageStrip coverage={undefined} />);
    expect(container.textContent).toBe('');
    rerender(<CoverageStrip coverage={[row({ projects: 0, mapped: 0, direct_only: 0 })]} />);
    expect(container.textContent).toBe('');
  });

  it('says how many projects have a code, which go under their own code, and how many proposals wait', () => {
    render(<CoverageStrip coverage={[row()]} />);
    const line = within(screen.getByTestId('coverage')).getByText('ORACLE_EBS').closest('li') as HTMLElement;
    expect(within(line).getByTestId('coverage-mapped').textContent).toBe(t('int.codes.coverage.mapped', { mapped: 18, projects: 22 }));
    expect(within(line).getByTestId('coverage-direct').textContent).toBe(t('int.codes.coverage.direct', { count: 4 }));
    expect(within(line).getByTestId('coverage-proposed').textContent).toBe(t('int.codes.coverage.proposed', { count: 2 }));
    expect(within(line).queryByTestId('coverage-unmapped')).toBeNull();
    expect(within(line).queryByTestId('coverage-shadows')).toBeNull();
    expect(line.getAttribute('data-complete')).toBe('false');
  });

  it('flags a code that is the code of another project, and says the system is complete when every project has a code', () => {
    render(<CoverageStrip coverage={[row({ shadows: 1 }), row({ source_system: 'HPM', mapped: 22, direct_only: 0, proposed: 0 })]} />);
    expect(screen.getByTestId('coverage-shadows').textContent).toBe(t('int.codes.coverage.shadows', { count: 1 }));
    const hpm = screen.getByText('HPM').closest('li') as HTMLElement;
    expect(hpm.getAttribute('data-complete')).toBe('true');
    expect(within(hpm).queryByTestId('coverage-direct')).toBeNull();
  });

  it('once the fallback is gone the rest are called unmapped', () => {
    render(<CoverageStrip coverage={[row({ direct_only: 0, unmapped: 4, direct_fallback: false })]} />);
    expect(screen.getByTestId('coverage-unmapped').textContent).toBe(t('int.codes.coverage.unmapped', { count: 4 }));
    expect(screen.queryByTestId('coverage-direct')).toBeNull();
  });
});
