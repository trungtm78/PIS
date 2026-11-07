import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { harness, mount } from '../../sas/test-support';
import RuleTypeDetailScreen from './RuleTypeDetailScreen';
import { ALL, MANAGE, ME, OTHER, READ, THIRD, catalogueBody, defaultBody, effectiveBody, refusal, routeOf, serve, text, uuid, version } from './test/fixtures';
import type { Answer } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('ADM-20');
const CODE_PATH = '/adm/adm-20?type=ALERT_TYPE&code=EXPLANATION';

interface Setup {
  versions?: unknown[];
  effective?: Answer;
  commands?: Record<string, Answer>;
  permissions?: readonly string[];
  path?: string;
  catalogue?: unknown;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getGovernanceRuleCatalog: setup.catalogue ?? catalogueBody(),
      listGovernanceRuleVersions: { items: setup.versions ?? [] },
      getEffectiveGovernanceRule: setup.effective ?? ((input: Record<string, unknown>) => ((input.query as { as_of?: string } | undefined)?.as_of === '2000-01-01' ? defaultBody() : effectiveBody())),
    },
    setup.commands ?? {},
  );
  mount(<RuleTypeDetailScreen route={route} />, h, setup.permissions ?? ALL, setup.path ?? CODE_PATH);
  return h;
};

const submitted = (n: number, over: Record<string, unknown> = {}) => version(n, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: OTHER, submitted_by: THIRD, submitted_at: '2026-11-02T03:00:00.000Z', ...over });
const approved = (n: number, over: Record<string, unknown> = {}) =>
  version(n, { status: 'APPROVED', phase: 'IN_FORCE', created_by: OTHER, submitted_by: THIRD, submitted_at: '2026-10-02T03:00:00.000Z', approved_by: ME, approved_at: '2026-10-03T03:00:00.000Z', effective_from: '2026-10-05', ...over });

describe('ADM-20: a rule type and its versions', () => {
  it('says what to open it from when the address names no type, and reads nothing', () => {
    const h = open({ path: '/adm/adm-20' });
    expect(screen.getByTestId('no-target').textContent).toBe(text('gova1.detail.noTarget'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('refuses a malformed code and an unknown type in words', async () => {
    open({ path: '/adm/adm-20?type=ALERT_TYPE&code=bad-code' });
    expect(await screen.findByTestId('bad-code')).toBeTruthy();
    cleanup();
    open({ path: '/adm/adm-20?type=NO_SUCH_TYPE' });
    expect((await screen.findByTestId('unknown-type')).textContent).toBe(text('gova1.detail.unknownType', { type: 'NO_SUCH_TYPE' }));
  });

  it('lists the codes of a type with what governs each, the source of its numbers and a way to write a rule for a new code', async () => {
    open({ path: '/adm/adm-20?type=ALERT_TYPE' });
    expect(await screen.findByTestId('about')).toBeTruthy();
    const rows = document.querySelectorAll('[data-code]');
    expect(rows.length).toBe(2);
    expect(within(document.querySelector('[data-code="EXPLANATION"]') as HTMLElement).getByText(text('gova1.detail.force.rule', { version: 2 }))).toBeTruthy();
    expect(within(document.querySelector('[data-code="APPROVAL"]') as HTMLElement).getByText(text('gova1.detail.force.default'))).toBeTruthy();
    expect(screen.getByTestId('open-EXPLANATION').getAttribute('href')).toBe('/adm/adm-20?type=ALERT_TYPE&code=EXPLANATION');
    expect(screen.getByTestId('new-code').getAttribute('href')).toBe('/adm/adm-21?type=ALERT_TYPE');
  });

  it('does not offer to write a rule to a person who may only read', async () => {
    open({ path: '/adm/adm-20?type=ALERT_TYPE', permissions: [READ] });
    await screen.findByTestId('about');
    expect(screen.queryByTestId('new-code')).toBeNull();
    expect(screen.queryByTestId('new-version')).toBeNull();
  });

  it('sets the rule in force beside the default that ships: every param on a row, the differing rows marked in words', async () => {
    open({ versions: [approved(2)] });
    const table = await screen.findByTestId('side-by-side');
    const hours = within(table).getByText('response_hours').closest('tr') as HTMLElement;
    expect(hours.dataset.same).toBe('no');
    expect(within(hours).getByText('48')).toBeTruthy();
    expect(within(hours).getByText('72')).toBeTruthy();
    expect(within(hours).getByText(text('gova1.compare.differs'))).toBeTruthy();
    // The unit is read from the name of the field.
    expect(within(hours).getAllByText(text('gova1.unit.hours')).length).toBe(2);
    const owner = within(table).getByText('owner').closest('tr') as HTMLElement;
    expect(owner.dataset.same).toBe('yes');
    expect(within(owner).getByText(text('gova1.compare.same'))).toBeTruthy();
    expect(screen.getByText(text('gova1.detail.force.rule', { version: 2 }), { selector: '.ui-pill span' })).toBeTruthy();
    expect(screen.getByTestId('provenance').textContent).toContain('Báo cáo nghiên cứu 2026');
    expect(screen.queryByTestId('unverified')).toBeNull();
  });

  it('AC-ADM-13 says "chưa kiểm chứng" next to a default that was not confirmed', async () => {
    open({
      path: '/adm/adm-20?type=RAG_THRESHOLDS&code=DISBURSEMENT',
      effective: effectiveBody({ rule_type: 'RAG_THRESHOLDS', code: 'DISBURSEMENT', source: 'DEFAULT', version: 0, unverified: true, rule_id: null, provenance: { formula: 'f', source: 'Nghiên cứu', as_of: '2026-11-08', legal_status: 'UNVERIFIED' } }),
    });
    const note = await screen.findByTestId('unverified');
    expect(within(note).getByText(text('gova1.legal.unverified'))).toBeTruthy();
    expect(note.textContent).toContain(text('gova1.legal.unverified.hint'));
  });

  it('shows a code that no rule governs as a statement, not as an empty table', async () => {
    open({ effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('no-rule')).textContent).toBe(text('gova1.detail.force.noRule'));
  });

  it('keeps the versions when only the rule in force cannot be read, and says so with a retry', async () => {
    open({ versions: [version(1)], effective: refusal('INTERNAL_ERROR', 500) });
    expect(await screen.findByTestId('force-error')).toBeTruthy();
    expect(await screen.findByTestId('timeline')).toBeTruthy();
  });

  it('lists the versions newest first with status, period, reason and who did what ("Bạn" for the person signed in)', async () => {
    open({ versions: [approved(2, { approved_by: ME }), version(1, { status: 'RETIRED', phase: 'ENDED', created_by: ME, retired_by: OTHER, retired_at: '2026-09-01T03:00:00.000Z', retire_reason: 'Thay bằng bản 2', effective_from: '2026-08-01', effective_to: '2026-10-05' })] });
    const timeline = await screen.findByTestId('timeline');
    const items = within(timeline).getAllByRole('listitem');
    expect(items.map((item) => item.dataset.version)).toEqual([uuid(102), uuid(101)]);
    const first = items[0] as HTMLElement;
    expect(within(first).getByText(text('gova1.detail.version.title', { version: 2 }))).toBeTruthy();
    expect(within(first).getByText(`${text('gova1.status.approved')} · ${text('gova1.phase.inForce')}`)).toBeTruthy();
    expect(within(first).getByTestId('reason').textContent).toBe(text('gova1.detail.version.reason', { reason: 'Lý do của phiên bản 2' }));
    expect(within(first).getByTestId('people').textContent).toContain(text('gova1.common.you'));
    expect((items[1] as HTMLElement).textContent).toContain('Thay bằng bản 2');
    expect(within(items[0] as HTMLElement).getByTestId('diff-2').getAttribute('href')).toBe(`/adm/adm-22?rule=${uuid(102)}&against=${uuid(101)}`);
    expect(within(items[1] as HTMLElement).getByTestId('diff-1').getAttribute('href')).toBe(`/adm/adm-22?rule=${uuid(101)}`);
    expect(screen.getByTestId('from-2').getAttribute('href')).toBe(`/adm/adm-21?type=ALERT_TYPE&code=EXPLANATION&from=${uuid(102)}`);
    // The chronology of the moves is a timeline of its own.
    expect(screen.getByText(text('gova1.timeline.title'))).toBeTruthy();
  });

  it('says there are no versions of the organisation yet', async () => {
    open({ versions: [] });
    expect((await screen.findByTestId('no-versions')).textContent).toBe(text('gova1.detail.versions.none'));
  });

  it('names a failed read of the versions as an error and reads again on retry', async () => {
    let calls = 0;
    const h = harness((operation) => {
      if (operation === 'getGovernanceRuleCatalog') return catalogueBody();
      if (operation === 'getEffectiveGovernanceRule') return effectiveBody();
      return calls++ === 0 ? refusal('INTERNAL_ERROR', 500) : { items: [version(1)] };
    });
    mount(<RuleTypeDetailScreen route={route} />, h, ALL, CODE_PATH);
    const retry = await screen.findByRole('button', { name: text('states.retry.action') });
    fireEvent.click(retry);
    expect(await screen.findByTestId('timeline')).toBeTruthy();
  });

  it('is denied without the permission to read and reads nothing', () => {
    const h = open({ permissions: [] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  // ---- the moves -------------------------------------------------------------------------------------------------------------------

  it('offers a draft to be submitted or discarded and asks for the context and a reason before it submits', async () => {
    const h = open({ versions: [version(3)], commands: { submitGovernanceRule: { resource_id: uuid(103), status: 'SUBMITTED', resource_version: 2 } } });
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.submit') }));
    const dialog = screen.getByRole('dialog', { name: text('gova1.dialog.submit.title', { version: 3, code: 'EXPLANATION' }) });
    // The object, the version, the period and the reason of the version, and the rule that follows.
    expect(within(dialog).getByText('ALERT_TYPE · EXPLANATION')).toBeTruthy();
    expect(within(dialog).getByText(text('gova1.dialog.versionValue', { version: 3, status: text('gova1.status.draft') }))).toBeTruthy();
    expect(within(dialog).getByText(text('gova1.period.open', { from: '01/12/2026' }))).toBeTruthy();
    expect(within(dialog).getByText('Lý do của phiên bản 3')).toBeTruthy();
    expect(within(dialog).getByText(text('gova1.dialog.rule.submit'))).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: text('gova1.move.submit') });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.submit'))), { target: { value: 'ok' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.submit'))), { target: { value: 'Đủ căn cứ để trình' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('submitGovernanceRule');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { ruleId: uuid(103) }, body: { reason: 'Đủ căn cứ để trình' }, ifMatchVersion: 1 });
    // The receipt says what was done and what comes next.
    expect((await screen.findByTestId('receipt')).textContent).toBe(text('gova1.receipt.submit', { version: 3, code: 'EXPLANATION', time: (screen.getByTestId('receipt').textContent ?? '').match(/lúc (.*?)\. Bước/)?.[1] ?? '' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('discards a draft with a reason (retire of a version that never governed)', async () => {
    const h = open({ versions: [version(3)], commands: { retireGovernanceRule: {} } });
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.discardDraft') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByTestId('end-day')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.retire'))), { target: { value: 'Soạn nhầm mã' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('gova1.move.discardDraft') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('retireGovernanceRule');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { reason: 'Soạn nhầm mã' } });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('effective_to');
  });

  it('withdraws a submission back to a draft', async () => {
    const h = open({ versions: [submitted(3)], commands: { withdrawGovernanceRule: {} } });
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.withdraw') }));
    fireEvent.change(screen.getByLabelText(new RegExp(text('gova1.dialog.reason.withdraw'))), { target: { value: 'Cần sửa số' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('gova1.move.withdraw') }));
    await waitFor(() => expect(h.command.mock.calls[0]?.[0]).toBe('withdrawGovernanceRule'));
  });

  it('AC-ADM-12 lets a third person approve: the dialog says the three-person rule first and the command carries the version seen', async () => {
    const h = open({ versions: [submitted(3, { resource_version: 4 })], commands: { approveGovernanceRule: {} } });
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.approve') }));
    const dialog = screen.getByRole('dialog', { name: text('gova1.dialog.approve.title', { version: 3, code: 'EXPLANATION' }) });
    expect(within(dialog).getByText(text('gova1.dialog.rule.approve'))).toBeTruthy();
    expect(within(dialog).getByText(text('gova1.dialog.peopleValue', { maker: OTHER.slice(0, 8), submitter: THIRD.slice(0, 8) }))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.approve'))), { target: { value: 'Đã kiểm tra số' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('gova1.move.approve') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('approveGovernanceRule');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { ruleId: uuid(103) }, body: { reason: 'Đã kiểm tra số' }, ifMatchVersion: 4 });
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('AC-ADM-12 does not let the maker or the submitter approve: the button is off and the rule is said next to it', async () => {
    open({ versions: [submitted(3, { created_by: ME })] });
    const button = await screen.findByRole('button', { name: text('gova1.move.approve') });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(new RegExp(text('gova1.block.selfApproval').slice(0, 30)));
    cleanup();
    open({ versions: [submitted(3, { submitted_by: ME })] });
    expect(await screen.findByRole('button', { name: text('gova1.move.approve') })).toBeDisabled();
    expect(screen.getByText(text('gova1.block.selfApproval'))).toBeTruthy();
  });

  it('says the refusal of the server inside the dialog and keeps the dialog open (the server judges again)', async () => {
    const h = open({ versions: [submitted(3)], commands: { approveGovernanceRule: refusal('SELF_APPROVAL_DENIED', 403) } });
    // A refusal is an error, not a value: the harness returns it as a rejection.
    h.command.mockImplementationOnce(() => Promise.reject(refusal('SELF_APPROVAL_DENIED', 403)));
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.approve') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.approve'))), { target: { value: 'Đã kiểm tra số' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('gova1.move.approve') }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(text('gova1.refusal.selfApproval'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it.each([
    ['GOVERNANCE_RULE_STATE_INVALID', 409, 'gova1.refusal.state'],
    ['GOVERNANCE_RULE_PERIOD_OVERLAP', 409, 'gova1.refusal.overlap'],
    ['VERSION_CONFLICT', 409, 'gova1.refusal.conflict'],
    ['RESOURCE_NOT_FOUND', 404, 'gova1.refusal.notFound'],
    ['SCOPE_DENIED', 403, 'gova1.refusal.denied'],
  ])('words the refusal %s in the dialog', async (code, status, key) => {
    const h = open({ versions: [submitted(3)] });
    h.command.mockImplementationOnce(() => Promise.reject(refusal(code, status)));
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.approve') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.approve'))), { target: { value: 'Đã kiểm tra số' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('gova1.move.approve') }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(text(key));
  });

  it('explains a version whose first day has passed instead of offering an approval that would be refused', async () => {
    open({ versions: [submitted(3, { effective_from: '2026-11-01' })] });
    const button = await screen.findByRole('button', { name: text('gova1.move.approve') });
    expect(button).toBeDisabled();
    expect(screen.getByText(text('gova1.block.startPassed'))).toBeTruthy();
  });

  it('retires a version in force only with both permissions, and asks for the day it stops', async () => {
    open({ versions: [approved(2)], permissions: [READ, MANAGE] });
    const blocked = await screen.findByRole('button', { name: text('gova1.move.retire') });
    expect(blocked).toBeDisabled();
    expect(screen.getByText(text('gova1.block.needsBoth'))).toBeTruthy();
    cleanup();
    const h = open({ versions: [approved(2)], commands: { retireGovernanceRule: {} } });
    fireEvent.click(await screen.findByRole('button', { name: text('gova1.move.retire') }));
    const dialog = screen.getByRole('dialog', { name: text('gova1.dialog.retire.title', { version: 2, code: 'EXPLANATION' }) });
    fireEvent.change(within(dialog).getByTestId('end-day'), { target: { value: '2026-12-31' } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(text('gova1.dialog.reason.retire'))), { target: { value: 'Luật mới thay thế' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('gova1.move.retire') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { reason: 'Luật mới thay thế', effective_to: '2026-12-31' } });
  });

  it('offers no move on a version that ended, and none to a person who may only read', async () => {
    open({ versions: [version(1, { status: 'RETIRED', phase: 'ENDED' })] });
    await screen.findByTestId('timeline');
    expect(document.querySelectorAll('[data-action]').length).toBe(0);
    cleanup();
    open({ versions: [version(3), submitted(4)], permissions: [READ] });
    await screen.findByTestId('timeline');
    expect(document.querySelectorAll('[data-action]').length).toBe(0);
  });

  it('has no serious accessibility violation, with a dialog open', async () => {
    open({ versions: [submitted(3), approved(2)] });
    await screen.findByTestId('timeline');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: text('gova1.move.approve') }));
    expect(describeViolations(await seriousViolations(screen.getByRole('dialog')))).toEqual([]);
  });
});
