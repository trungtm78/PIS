import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { PermitActions } from './PermitActions';
import { toPermitDetail } from './dossier-model';
import type { PermitDetailView } from './dossier-model';
import { DOCUMENT, OFFICER, TODAY, client, mount, permitDetail, permitId, world } from './dossier-test-support';

afterEach(cleanup);

const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const OK = { operation_id: 'o', status: 'OK', resource_version: 2, resource_id: permitId(9) };
const permit = (overrides: Record<string, unknown> = {}): PermitDetailView => toPermitDetail(permitDetail(1, { version: 3, ...overrides })) as PermitDetailView;
const show = (view: PermitDetailView, options: { mayManage?: boolean; mayRecord?: boolean; mayExempt?: boolean; command?: (operation: string, input: unknown) => unknown } = {}) => {
  const h = client(world(), options.command ?? (() => OK));
  mount(<PermitActions permit={view} today={TODAY} mayManage={options.mayManage ?? true} mayRecord={options.mayRecord ?? true} mayExempt={options.mayExempt ?? true} />, h, { permissions: OFFICER });
  return h;
};
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
/** The same inside one form: the scan field has the same label in several of them. */
const setIn = (form: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
};
const click = (form: HTMLElement, name: string) => userEvent.setup().click(within(form).getByRole('button', { name }));
const milestoneForm = () => screen.getByRole('form', { name: vi_['pmt.permit.milestone.aria'] });
const decisionForm = () => screen.getByRole('form', { name: vi_['pmt.permit.decision.aria'] });
const renewForm = () => screen.getByRole('form', { name: vi_['pmt.permit.renew.aria'] });
const exemptForm = () => screen.getByRole('form', { name: vi_['pmt.permit.exempt.aria'] });
const revokeForm = () => screen.getByRole('form', { name: vi_['pmt.permit.revoke.aria'] });
const forms = (): string[] => screen.queryAllByRole('form').map((form) => form.getAttribute('aria-label') ?? '');

describe('PermitActions (PMT-02): what can be done with a permit now', () => {
  it('offers the milestone that follows a planned permit, asks for the day it happened and sends it with the version that was read (UI-PMT-02)', async () => {
    const h = show(permit({ status: 'PLANNED' }));
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria']]);
    expect(within(milestoneForm()).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pmt.permit.step.submitted.text']]);
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    expect(within(milestoneForm()).getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['pmt.permit.milestone.actual.label'], '2026-10-25');
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    expect(within(milestoneForm()).getByText(vi_['pmt.permit.field.future.error'])).toBeTruthy();
    set(vi_['pmt.permit.milestone.actual.label'], '2026-10-01');
    set(vi_['pmt.permit.milestone.note.label'], 'Filed at the one-stop office');
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    expect((await screen.findByTestId('milestone-saved')).textContent).toBe(vi_['pmt.permit.milestone.saved.notice']);
    expect(h.command).toHaveBeenCalledWith(
      'recordPermitMilestone',
      expect.objectContaining({ path: { id: permitId(1) }, ifMatchVersion: 3, body: { step_code: 'SUBMITTED', actual_on: '2026-10-01', note: 'Filed at the one-stop office' } }),
    );
    expect((screen.getByLabelText(vi_['pmt.permit.milestone.note.label']) as HTMLTextAreaElement).value).toBe('');
  });

  it('offers the three steps of an application in appraisal, takes a planned day for a meeting, and the decision form beside it', async () => {
    const h = show(permit({ status: 'IN_APPRAISAL' }));
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria'], vi_['pmt.permit.decision.aria']]);
    const select = within(milestoneForm()).getByLabelText(vi_['pmt.permit.milestone.step.label']);
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      vi_['pmt.permit.step.appraisalMeeting.text'],
      vi_['pmt.permit.step.supplementRequested.text'],
      vi_['pmt.permit.step.decision.text'],
    ]);
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    expect(within(milestoneForm()).getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    set(vi_['pmt.permit.milestone.planned.label'], '2026-11-05');
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    await screen.findByTestId('milestone-saved');
    expect(h.command).toHaveBeenCalledWith('recordPermitMilestone', expect.objectContaining({ body: { step_code: 'APPRAISAL_MEETING', planned_on: '2026-11-05' } }));
    // Changing the step keeps the form and takes away the notice of the one before.
    await userEvent.setup().selectOptions(select, vi_['pmt.permit.step.supplementRequested.text']);
    expect(screen.queryByTestId('milestone-saved')).toBeNull();
    set(vi_['pmt.permit.milestone.actual.label'], '2026-10-10');
    setIn(milestoneForm(), vi_['pmt.permit.scan.label'], DOCUMENT);
    await click(milestoneForm(), vi_['pmt.permit.milestone.save.action']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('recordPermitMilestone', expect.objectContaining({ body: { step_code: 'SUPPLEMENT_REQUESTED', actual_on: '2026-10-10', document_version_id: DOCUMENT } }));
  });

  it('says the scan is needed before it asks the server, issues the permit with its number, days and scan, and refuses a number in use (AC-ST-PMT-002-1)', async () => {
    let answer: unknown = problem('PERMIT_NO_DUPLICATE');
    const h = show(permit({ status: 'IN_APPRAISAL' }), { command: () => answer });
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    expect(within(decisionForm()).getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    expect(within(decisionForm()).getByText(vi_['pmt.permit.field.scanRequired.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['pmt.permit.decision.number.label'], 'GP-0001');
    set(vi_['pmt.permit.decision.validFrom.label'], '2026-10-20');
    set(vi_['pmt.permit.decision.validUntil.label'], '2027-10-19');
    setIn(decisionForm(), vi_['pmt.permit.scan.label'], DOCUMENT);
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    expect((await within(decisionForm()).findByRole('alert')).textContent).toBe(vi_['pmt.permit.problem.numberDuplicate.error']);
    expect(h.command).toHaveBeenCalledWith(
      'recordPermitDecision',
      expect.objectContaining({ ifMatchVersion: 3, body: { outcome: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-10-20', valid_until: '2027-10-19', document_version_id: DOCUMENT } }),
    );
    answer = OK;
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    expect((await screen.findByTestId('decision-saved')).textContent).toBe(vi_['pmt.permit.decision.saved.notice']);
  });

  it('clears the last day when the permit has no expiry, and sends no_expiry instead', async () => {
    const h = show(permit({ status: 'IN_APPRAISAL' }));
    set(vi_['pmt.permit.decision.number.label'], 'GP-0002');
    set(vi_['pmt.permit.decision.validUntil.label'], '2027-10-19');
    setIn(decisionForm(), vi_['pmt.permit.scan.label'], DOCUMENT);
    await userEvent.setup().click(screen.getByLabelText(vi_['pmt.permit.decision.noExpiry.label']));
    expect((screen.getByLabelText(vi_['pmt.permit.decision.validUntil.label']) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(vi_['pmt.permit.decision.validUntil.label']) as HTMLInputElement).disabled).toBe(true);
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    await screen.findByTestId('decision-saved');
    expect(h.command).toHaveBeenCalledWith('recordPermitDecision', expect.objectContaining({ body: { outcome: 'ISSUED', permit_no: 'GP-0002', no_expiry: true, document_version_id: DOCUMENT } }));
    // The form starts over after a success: the box is unchecked and the last day can be typed again.
    expect((screen.getByLabelText(vi_['pmt.permit.decision.noExpiry.label']) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(vi_['pmt.permit.decision.validUntil.label']) as HTMLInputElement).disabled).toBe(false);
  });

  it('rejects an application with the reason and no number or days', async () => {
    const h = show(permit({ status: 'IN_APPRAISAL' }));
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['pmt.permit.decision.outcome.label']), vi_['pmt.permit.decision.rejected.option']);
    expect(screen.queryByLabelText(vi_['pmt.permit.decision.number.label'])).toBeNull();
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    expect(within(decisionForm()).getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    set(vi_['pmt.permit.decision.reason.label'], 'The file is incomplete');
    await click(decisionForm(), vi_['pmt.permit.decision.save.action']);
    await screen.findByTestId('decision-saved');
    expect(h.command).toHaveBeenCalledWith('recordPermitDecision', expect.objectContaining({ body: { outcome: 'REJECTED', reason: 'The file is incomplete' } }));
  });

  it('renews an issued permit with a new number, a later last day and the new scan, and leads to the new permit', async () => {
    const h = show(permit({ status: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-01-01', valid_until: '2026-12-31' }));
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria'], vi_['pmt.permit.renew.aria'], vi_['pmt.permit.revoke.aria']]);
    await click(renewForm(), vi_['pmt.permit.renew.save.action']);
    expect(within(renewForm()).getAllByText(vi_['pmt.permit.field.required.error'])).toHaveLength(3);
    set(vi_['pmt.permit.renew.number.label'], 'GP-0002');
    set(vi_['pmt.permit.renew.until.label'], '2026-12-31');
    setIn(renewForm(), vi_['pmt.permit.scan.label'], DOCUMENT);
    await click(renewForm(), vi_['pmt.permit.renew.save.action']);
    expect(within(renewForm()).getByText(vi_['pmt.permit.field.dateOrder.error'])).toBeTruthy();
    set(vi_['pmt.permit.renew.until.label'], '2027-12-31');
    await click(renewForm(), vi_['pmt.permit.renew.save.action']);
    const notice = await screen.findByTestId('renew-saved');
    expect(within(notice).getByRole('link', { name: vi_['pmt.permit.renew.open.action'] }).getAttribute('href')).toBe(`/pmt/pmt-02?permit=${permitId(9)}`);
    expect(h.command).toHaveBeenCalledWith('renewPermit', expect.objectContaining({ ifMatchVersion: 3, body: { new_permit_no: 'GP-0002', new_valid_until: '2027-12-31', document_version_id: DOCUMENT } }));
  });

  it('keeps telling what was done, and leads to the new permit, after the command moved the permit out of the status that offered the form', async () => {
    const issued = permit({ status: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-01-01', valid_until: '2026-12-31' });
    const superseded = permit({ status: 'SUPERSEDED', version: 4, permit_no: 'GP-0001', valid_from: '2026-01-01', valid_until: '2026-12-31' });
    let move: () => void = () => undefined;
    function Moving() {
      const [view, setView] = useState(issued);
      move = () => setView(superseded);
      return <PermitActions permit={view} today={TODAY} mayManage mayRecord mayExempt />;
    }
    const h = client(world(), () => {
      move();
      return OK;
    });
    mount(<Moving />, h, { permissions: OFFICER });
    set(vi_['pmt.permit.renew.number.label'], 'GP-0002');
    set(vi_['pmt.permit.renew.until.label'], '2027-12-31');
    setIn(renewForm(), vi_['pmt.permit.scan.label'], DOCUMENT);
    await click(renewForm(), vi_['pmt.permit.renew.save.action']);
    const notice = await screen.findByTestId('renew-saved');
    expect(screen.getByTestId('no-actions')).toBeTruthy();
    expect(forms()).toEqual([]);
    expect(within(notice).getByRole('link', { name: vi_['pmt.permit.renew.open.action'] }).getAttribute('href')).toBe(`/pmt/pmt-02?permit=${permitId(9)}`);
  });

  it('renews an expired permit and offers nothing else, and offers no renewal of a permit without an end', () => {
    show(permit({ status: 'EXPIRED', valid_from: '2025-01-01', valid_until: '2025-12-31' }));
    expect(forms()).toEqual([vi_['pmt.permit.renew.aria']]);
    cleanup();
    show(permit({ status: 'ISSUED', valid_from: '2026-01-01', no_expiry: true }));
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria'], vi_['pmt.permit.revoke.aria']]);
  });

  it('revokes an issued permit with the reason and the decision, and says when the permit moved meanwhile', async () => {
    let answer: unknown = problem('VERSION_CONFLICT');
    const h = show(permit({ status: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-01-01', valid_until: '2026-12-31' }), { command: () => answer });
    await click(revokeForm(), vi_['pmt.permit.revoke.save.action']);
    expect(within(revokeForm()).getAllByText(vi_['pmt.permit.field.required.error'])).toHaveLength(2);
    set(vi_['pmt.permit.revoke.reason.label'], 'Issued by mistake');
    set(vi_['pmt.permit.revoke.scan.label'], DOCUMENT);
    await click(revokeForm(), vi_['pmt.permit.revoke.save.action']);
    expect((await within(revokeForm()).findByRole('alert')).textContent).toBe(vi_['pmt.permit.problem.versionConflict.error']);
    answer = OK;
    await click(revokeForm(), vi_['pmt.permit.revoke.save.action']);
    expect((await screen.findByTestId('revoke-saved')).textContent).toBe(vi_['pmt.permit.revoke.saved.notice']);
    expect(h.command).toHaveBeenLastCalledWith('revokePermit', expect.objectContaining({ ifMatchVersion: 3, body: { reason: 'Issued by mistake', decision_document_version_id: DOCUMENT } }));
  });

  it('offers only what the permissions allow: the milestone to the one who manages, the decisions to the one who records', () => {
    show(permit({ status: 'IN_APPRAISAL' }), { mayRecord: false });
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria']]);
    cleanup();
    show(permit({ status: 'IN_APPRAISAL' }), { mayManage: false });
    expect(forms()).toEqual([vi_['pmt.permit.decision.aria']]);
    cleanup();
    show(permit({ status: 'IN_APPRAISAL' }), { mayManage: false, mayRecord: false });
    expect(forms()).toEqual([]);
    expect(screen.getByTestId('actions-readonly').textContent).toBe(vi_['pmt.permit.actions.readonly.text']);
  });

  it.each(['REJECTED', 'REVOKED', 'SUPERSEDED', 'EXEMPTED'])('offers nothing for a permit that is %s, whoever asks', (status) => {
    show(permit({ status }));
    expect(forms()).toEqual([]);
    expect(screen.getByTestId('no-actions').textContent).toBe(vi_['pmt.permit.actions.none.text']);
  });

  describe('the exemption of a permit (AC-ST-PMT-003-1, UAT-AC372)', () => {
    const exemptable = (overrides: Record<string, unknown> = {}): PermitDetailView => permit({ status: 'PLANNED', exemption_allowed: true, ...overrides });

    it('is offered for a planned or submitted permit of a type that allows it, to someone who may approve, next to the other forms they may use', () => {
      show(exemptable());
      expect(forms()).toEqual([vi_['pmt.permit.milestone.aria'], vi_['pmt.permit.exempt.aria']]);
      expect(screen.getByText(vi_['pmt.permit.exempt.hint.text'])).toBeTruthy();
      cleanup();
      show(exemptable({ status: 'SUBMITTED' }), { mayManage: false, mayRecord: false });
      expect(forms()).toEqual([vi_['pmt.permit.exempt.aria']]);
    });

    it('is not offered when the type does not allow it, when the permit is past that stage, or to someone who may not approve', () => {
      show(permit({ status: 'PLANNED', exemption_allowed: false }));
      expect(forms()).toEqual([vi_['pmt.permit.milestone.aria']]);
      cleanup();
      show(exemptable({ status: 'IN_APPRAISAL' }));
      expect(forms()).not.toContain(vi_['pmt.permit.exempt.aria']);
      cleanup();
      show(exemptable(), { mayExempt: false });
      expect(forms()).toEqual([vi_['pmt.permit.milestone.aria']]);
      cleanup();
      show(exemptable(), { mayManage: false, mayRecord: false, mayExempt: false });
      expect(screen.getByTestId('actions-readonly')).toBeTruthy();
    });

    it('asks for the basis and the decision document, then sends both with the version that was read and tells what was done', async () => {
      const h = show(exemptable({ version: 3 }));
      await click(exemptForm(), vi_['pmt.permit.exempt.save.action']);
      expect(within(exemptForm()).getAllByText(vi_['pmt.permit.field.required.error'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      set(vi_['pmt.permit.exempt.basis.label'], '  Exempt under the construction law, article 89  ');
      set(vi_['pmt.permit.exempt.scan.label'], DOCUMENT);
      await click(exemptForm(), vi_['pmt.permit.exempt.save.action']);
      expect((await screen.findByTestId('exempt-saved')).textContent).toBe(vi_['pmt.permit.exempt.saved.notice']);
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command.mock.calls[0]?.[0]).toBe('declarePermitExemption');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: permitId(1) },
        ifMatchVersion: 3,
        body: { exemption_basis: 'Exempt under the construction law, article 89', exemption_decision_document_version_id: DOCUMENT },
      });
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'pmt.permit.problem.selfApproval.error'],
      ['EXEMPTION_NOT_ALLOWED', 422, 'pmt.permit.problem.exemptionNotAllowed.error'],
      ['PERMIT_STATE_INVALID', 409, 'pmt.permit.problem.stateInvalid.error'],
    ] as const)('says in words why the server refused: %s', async (code, status, key) => {
      show(exemptable(), { command: () => problem(code, status) });
      set(vi_['pmt.permit.exempt.basis.label'], 'Article 89');
      set(vi_['pmt.permit.exempt.scan.label'], DOCUMENT);
      await click(exemptForm(), vi_['pmt.permit.exempt.save.action']);
      expect((await within(exemptForm()).findByRole('alert')).textContent).toBe(vi_[key]);
    });
  });
});
