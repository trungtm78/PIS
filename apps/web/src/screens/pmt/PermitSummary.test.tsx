import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { MilestoneTimeline } from './MilestoneTimeline';
import { PermitSummary } from './PermitSummary';
import { toPermitDetail } from './dossier-model';
import type { PermitDetailView } from './dossier-model';
import { DOCUMENT, milestone, permitDetail } from './dossier-test-support';

afterEach(cleanup);

const detail = (overrides: Record<string, unknown> = {}): PermitDetailView => toPermitDetail(permitDetail(1, overrides)) as PermitDetailView;
const fact = (label: string): string => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
};

describe('PermitSummary (PMT-02): what a permit is', () => {
  it('shows the permit with the version of its type, its status as a word, its number, its days in force and its scan (UI-PMT-02, AC-ST-PMT-002-1)', () => {
    render(
      <MemoryRouter>
        <PermitSummary
          permit={detail({
            status: 'ISSUED',
            permit_no: 'GP-0001',
            permit_type_revision: 2,
            issued_on: '2026-10-20',
            valid_from: '2026-10-20',
            valid_until: '2027-10-19',
            document_version_id: DOCUMENT,
            responsible_membership: { membership_id: 'm', display_name: 'Trần B' },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(vi_['pmt.permit.summary.title'].replace('{code}', 'PERMIT_1'));
    expect(screen.getByTestId('permit-status').textContent).toBe(vi_['pmt.permit.status.issued.text']);
    expect(fact(vi_['pmt.permit.fact.project.label'])).toBe('DA-2026-001 · Dự án số 1');
    expect(fact(vi_['pmt.permit.fact.type.label'])).toBe(vi_['pmt.permit.fact.type.text'].replace('{name}', 'Giấy phép 1').replace('{revision}', '2'));
    expect(fact(vi_['pmt.permit.fact.number.label'])).toBe('GP-0001');
    expect(fact(vi_['pmt.permit.fact.validity.label'])).toBe('2026-10-20 → 2027-10-19');
    expect(fact(vi_['pmt.permit.fact.scan.label'])).toBe(DOCUMENT);
    expect(fact(vi_['pmt.permit.fact.responsible.label'])).toBe('Trần B');
    expect(screen.queryByText(vi_['pmt.permit.fact.revoked.label'])).toBeNull();
    expect(screen.queryByTestId('unconfirmed')).toBeNull();
  });

  it('says what is not there yet, flags a type that waits for its confirmation, and shows the reason of a revocation and the basis of an exemption', () => {
    render(
      <MemoryRouter>
        <PermitSummary permit={detail({ cxn_ref: 'CXN-EXE-03', revoke_reason: 'Issued by mistake', exemption_basis: 'Exempt by law', is_required: false })} />
      </MemoryRouter>,
    );
    expect(fact(vi_['pmt.permit.fact.number.label'])).toBe(vi_['pmt.permit.fact.none.text']);
    expect(fact(vi_['pmt.permit.fact.validity.label'])).toBe(vi_['pmt.permit.fact.none.text']);
    expect(screen.getByTestId('unconfirmed').textContent).toBe(vi_['pmt.type.unconfirmed.text'].replace('{cxn}', 'CXN-EXE-03'));
    expect(fact(vi_['pmt.permit.fact.revoked.label'])).toBe('Issued by mistake');
    expect(fact(vi_['pmt.permit.fact.exempted.label'])).toBe('Exempt by law');
    expect(fact(vi_['pmt.permit.fact.required.label'])).toBe(vi_['pmt.dossier.optional.text']);
  });

  it('says a permit has no expiry', () => {
    render(
      <MemoryRouter>
        <PermitSummary permit={detail({ status: 'ISSUED', valid_from: '2026-10-20', no_expiry: true })} />
      </MemoryRouter>,
    );
    expect(fact(vi_['pmt.permit.fact.validity.label'])).toBe(`2026-10-20 → ${vi_['pmt.permit.fact.noExpiry.text']}`);
  });
});

describe('MilestoneTimeline (PMT-02): the milestones of a permit', () => {
  it('lists the milestones in the order they were recorded, a step that happened by its day and one that is only planned by its planned day', () => {
    const milestones = detail({
      milestones: [
        milestone(1),
        milestone(2, { step_code: 'APPRAISAL_MEETING', actual_on: null, planned_on: '2026-11-05', note: 'Meeting at the department', document_version_id: DOCUMENT }),
      ],
    }).milestones;
    render(<MilestoneTimeline milestones={milestones} />);
    const items = within(screen.getByRole('list', { name: vi_['pmt.permit.timeline.aria'] })).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-step'))).toEqual(['SUBMITTED', 'APPRAISAL_MEETING']);
    expect(within(items[0] as HTMLElement).getByText(vi_['pmt.permit.step.submitted.text'])).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText(vi_['pmt.permit.timeline.actual.text'].replace('{date}', '2026-10-01'))).toBeTruthy();
    expect(items[0]?.className).toBe('done');
    expect(within(items[1] as HTMLElement).getByText(vi_['pmt.permit.timeline.planned.text'].replace('{date}', '2026-11-05'))).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('Meeting at the department')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(vi_['pmt.permit.timeline.scan.text'])).toBeTruthy();
    expect(items[1]?.className).toBe('');
  });

  it('says that nothing was recorded yet', () => {
    render(<MilestoneTimeline milestones={[]} />);
    expect(screen.getByTestId('no-milestones').textContent).toBe(vi_['pmt.permit.timeline.empty.text']);
  });
});
