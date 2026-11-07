import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WORK_KINDS, pathOf, toWorkPage } from '../home/work-model';
import { sourceLabel } from '../../ui/alerts/AlertRow';
import { useTranslation } from '../../i18n';
import { uuid } from './test-support';

afterEach(() => cleanup());

function Label({ source }: { source: string }) {
  const { t } = useTranslation();
  return <span data-testid="label">{sourceLabel(t, source)}</span>;
}

describe('the directives in the alert centre of the web', () => {
  it('knows the two kinds the source gives and opens the directive an item names', () => {
    expect(WORK_KINDS).toEqual(expect.arrayContaining(['DIRECTIVE_DUE', 'DIRECTIVE_OVERDUE']));
    expect(pathOf({ target: { screen: 'DIR-04', id: uuid(201) } })).toBe(`/dir/dir-04?directive=${uuid(201)}`);
  });

  it('reads an item of the source as a task with its day and its target, and does not drop it as an unknown kind', () => {
    const page = toWorkPage({
      items: [{ id: uuid(201), kind: 'DIRECTIVE_OVERDUE', title: 'Chỉ đạo quá hạn · GB-2026-001/CD-01', subtitle: null, status: 'OVERDUE', due_on: '2026-11-01', original_due_on: '2026-11-01', bucket: 'OVERDUE', days_late: 7, target: { screen: 'DIR-04', id: uuid(201) } }],
      counts: {},
    });
    expect(page.items).toMatchObject([{ kind: 'DIRECTIVE_OVERDUE', daysLate: 7, target: { screen: 'DIR-04' } }]);
  });

  it('names the source in words', () => {
    render(<Label source="DIRECTIVE" />);
    // The words are in the part of the clocks lane (alerts.source.directive); a source without words is shown as it came, which is what this must not be.
    expect(screen.getByTestId('label').textContent).not.toBe('DIRECTIVE');
    expect(screen.getByTestId('label').textContent).not.toBe('');
  });
});
