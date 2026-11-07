import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../../routes/web-routes';
import { useTranslation } from '../../i18n';
import { pathOfAlert, sourceLabel } from '../../ui/alerts/AlertRow';
import { WORK_SOURCES } from '../../ui/alerts/types';
import { WORK_KINDS, pathOf, toWorkPage } from './work-model';

afterEach(() => cleanup());

const ID = '00000000-0000-4000-8000-000000000a01';
const NEW_KINDS = ['TREASURY_RECON_ITEM_OVERDUE', 'CROSS_TOTAL_MISMATCH', 'SOD_EXCEPTION_EXPIRING', 'SOD_EXCEPTION_USED', 'PAYMENT_INTEGRITY_BLOCKED', 'PAYMENT_INTEGRITY_SIGNAL', 'DISBURSEMENT_EXCEPTION_EXPIRING', 'RESCHEDULE_COUNT'];
const NEW_SOURCES = ['TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'PROCUREMENT_WORKFLOW'];

function Label({ source }: { source: string }) {
  const { t } = useTranslation();
  return <span data-testid="label">{sourceLabel(t, source)}</span>;
}

/** The integrity of the money and of the duties and the alert of the baseline (lanes D and B1, integration GOV-INT) in the work list and the alert centre of the web. */
describe('the integrity alerts in the alert centre of the web', () => {
  it('knows every kind the sources give, and the native clocks that were missing from the list', () => {
    expect(WORK_KINDS).toEqual(expect.arrayContaining([...NEW_KINDS, 'CLOCK_DEADLINE']));
  });

  it('reads an item of each new kind as a task with its target, and does not drop it as an unknown kind', () => {
    const page = toWorkPage({
      items: [...NEW_KINDS, 'CLOCK_DEADLINE'].map((kind, index) => ({ id: `${ID}-${index}`, kind, title: kind, subtitle: null, status: 'OPEN', due_on: null, original_due_on: null, bucket: 'LATER', days_late: 0, target: { screen: 'PAY-20', id: ID } })),
      counts: {},
    });
    expect(page.items.map((item) => item.kind)).toEqual([...NEW_KINDS, 'CLOCK_DEADLINE']);
  });

  it('opens the record each item names: the request, the snapshot and the project by their id, and the registers on their own page', () => {
    expect(pathOf({ target: { screen: 'PAY-03', id: ID } })).toBe(`/pay/pay-03?request=${ID}`);
    expect(pathOf({ target: { screen: 'DIS-26', id: ID } })).toBe(`/dis/dis-26?snapshot=${ID}`);
    expect(pathOf({ target: { screen: 'PRJ-26', id: ID } })).toBe(`/prj/prj-26?project=${ID}`);
    // The screens that take no id in the address are opened on their own page by the alert row, never left without a link.
    for (const screen of ['PAY-20', 'PAY-21', 'ADM-24', 'AUD-13']) {
      expect(pathOf({ target: { screen, id: ID } })).toBeUndefined();
      const route = WEB_ROUTES.find((candidate) => candidate.id === screen);
      expect(route, screen).toBeDefined();
      expect(pathOfAlert({ target: { screen, id: ID } })).toBe(route?.path);
    }
  });

  it('knows the new sources, in the list of the sources and in words in both languages (a source without words is shown as it came, which is what this must not be)', () => {
    for (const source of NEW_SOURCES) {
      expect(WORK_SOURCES).toContain(source);
      render(<Label source={source} />);
      expect(screen.getByTestId('label').textContent, source).not.toBe(source);
      expect(screen.getByTestId('label').textContent, source).not.toBe('');
      cleanup();
    }
  });
});
