import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { ALERT_LEVELS, EMPTY_ACKNOWLEDGE, acknowledgeBody, validateAcknowledge, vietnamToday } from './model';
import {
  BASES,
  EMPTY_CANCEL,
  EMPTY_RECOVERY,
  KINDS,
  STATUSES,
  cancelBody,
  describeProblem,
  isOverdue,
  listLink,
  recoveredShare,
  recoveryBody,
  scheduleLink,
  toAdvance,
  toAnswer,
  toPlan,
  validateCancel,
  validateRecovery,
} from './model';
import { EVIDENCE, advance, advanceId, answer, contractId, plan } from './test-support';

const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

describe('the advance on the screens', () => {
  it('links the list and the schedule, with the contract and the advance in the address', () => {
    expect(listLink()).toBe('/pay/pay-07');
    expect(listLink(contractId(1))).toBe(`/pay/pay-07?contract=${contractId(1)}`);
    expect(scheduleLink(contractId(1))).toBe(`/ctr/ctr-06?contract=${contractId(1)}`);
    expect(scheduleLink(contractId(1), advanceId(2))).toBe(`/ctr/ctr-06?contract=${contractId(1)}&advance=${advanceId(2)}`);
  });

  it('names the statuses, the kinds and the bases of a recovery', () => {
    expect(STATUSES).toHaveLength(6);
    expect(KINDS).toEqual(['CONTRACT', 'GPMB']);
    expect(BASES).toEqual(['COMPENSATION_PAYMENT', 'REFUND', 'OTHER']);
  });

  it('reads an advance with exact amounts, the member it was paid to, the rule that capped it and what the caller may do', () => {
    const read = toAdvance(advance(1, { actions: { cancel: true, record_recovery: false } }));
    expect(read).toMatchObject({
      id: advanceId(1),
      status: 'RECOVERING',
      kind: 'GPMB',
      trancheNo: 1,
      contract: { id: contractId(1), code: 'HD-A-001', valueVnd: '10000000000', advanceCategory: 'CONSTRUCTION' },
      party: { role: 'LEAD', name: 'Nhà thầu A', workValueVnd: '6000000000' },
      amountVnd: '2000000000',
      capVnd: '2000000000',
      capPct: '20',
      capRuleAwaitingConfirmation: true,
      capRuleCxn: 'CXN-02',
      paidVnd: '2000000000',
      recoveredVnd: '750000000',
      outstandingVnd: '1250000000',
      thresholdPct: '80',
      recoveryDeadline: '2026-07-31',
      overdueDays: 12,
      actions: { cancel: true, recordRecovery: false },
      version: 4,
    });
    const sparse = toAdvance(advance(1, { cap_pct: null, cap_rule_cxn: null, paid_on: null, recovery_deadline: null, overdue_days: null, actions: null, party: { id: advanceId(9), role: 'SOLE', name: null, work_value_vnd: '1' } }));
    expect(sparse).toMatchObject({ capPct: null, capRuleCxn: null, paidOn: null, recoveryDeadline: null, overdueDays: null, actions: { cancel: false, recordRecovery: false }, party: { name: null } });
  });

  it('does not read an advance that is not whole, and never half an advance', () => {
    expect(toAdvance(null)).toBeUndefined();
    expect(toAdvance({ id: 'x' })).toBeUndefined();
    for (const overrides of [{ status: 'NOPE' }, { kind: 'NOPE' }, { amount_vnd: '1.5' }, { cap_vnd: 'x' }, { paid_vnd: '-1' }, { tranche_no: 'x' }, { version: 'x' }, { contract: null }, { party: null }, { recovered_vnd: null }]) {
      expect(toAdvance(advance(1, overrides))).toBeUndefined();
    }
  });

  it('reads the plan of the recovery with its milestones and the assumptions it rests on', () => {
    const read = toPlan(plan(1));
    expect(read).toMatchObject({ thresholdValueVnd: '4800000000', grossToDateVnd: '2400000000', remainingToThresholdVnd: '2400000000', targetRecoveredVnd: '1000000000', behindVnd: '250000000', warnings: ['RULE_AWAITING_CONFIRMATION'] });
    expect(read?.milestones.map((milestone) => [milestone.atPct, milestone.recoveredVnd])).toEqual([
      [25, '500000000'],
      [50, '1000000000'],
      [75, '1500000000'],
      [100, '2000000000'],
    ]);
    expect(read?.advance.id).toBe(advanceId(1));
    const sparse = toPlan(plan(1, { milestones: [{ at_pct: 'x' }, { at_pct: 50, at_gross_vnd: '1', recovered_vnd: '2' }, 'y'], warnings: 'z' }));
    expect(sparse?.milestones).toEqual([{ atPct: 50, atGrossVnd: '1', recoveredVnd: '2' }]);
    expect(sparse?.warnings).toEqual([]);
    expect(toPlan(plan(1, { milestones: 'x' }))?.milestones).toEqual([]);
    expect(toPlan(null)).toBeUndefined();
    expect(toPlan(plan(1, { threshold_value_vnd: 'x' }))).toBeUndefined();
    expect(toPlan({ ...plan(1), advance: { id: 'x' } })).toBeUndefined();
  });

  it('reads the answer of a command and nothing else', () => {
    expect(toAnswer(answer(1))).toEqual({ id: advanceId(1), status: 'RECOVERING', version: 5, recoveredVnd: '1000000000', outstandingVnd: '1000000000' });
    expect(toAnswer(answer(1, { status: undefined }))?.status).toBe('');
    expect(toAnswer(null)).toBeUndefined();
    expect(toAnswer(answer(1, { resource_version: 'x' }))).toBeUndefined();
    expect(toAnswer(answer(1, { outstanding_vnd: 'x' }))).toBeUndefined();
  });

  it('knows an advance that is late, and the share of it that has come back', () => {
    expect(isOverdue(toAdvance(advance(1))!)).toBe(true);
    expect(isOverdue(toAdvance(advance(1, { overdue_days: null }))!)).toBe(false);
    expect(isOverdue(toAdvance(advance(1, { overdue_days: 0 }))!)).toBe(false);
    expect(recoveredShare({ paidVnd: '2000000000', recoveredVnd: '750000000' })).toBe(37);
    expect(recoveredShare({ paidVnd: '2000000000', recoveredVnd: '2000000000' })).toBe(100);
    expect(recoveredShare({ paidVnd: '0', recoveredVnd: '0' })).toBe(0);
  });

  it('asks for the amount, the basis, the evidence and, when given, a source that is an identifier', () => {
    expect(validateRecovery(EMPTY_RECOVERY)).toEqual({ amount: 'required', basis: 'required', evidenceId: 'required' });
    expect(validateRecovery({ amount: '0', basis: 'REFUND', sourceRef: '', evidenceId: EVIDENCE })).toEqual({ amount: 'amount' });
    expect(validateRecovery({ amount: '1.5', basis: 'REFUND', sourceRef: '', evidenceId: EVIDENCE })).toEqual({ amount: 'amount' });
    expect(validateRecovery({ amount: '10', basis: 'REFUND', sourceRef: 'x', evidenceId: 'y' })).toEqual({ sourceRef: 'uuid', evidenceId: 'uuid' });
    expect(validateRecovery({ amount: '10', basis: 'REFUND', sourceRef: '', evidenceId: EVIDENCE })).toEqual({});
  });

  it('sends the figures as the person wrote them and leaves the source out when there is none', () => {
    expect(recoveryBody({ amount: ' 1000 ', basis: 'REFUND', sourceRef: '', evidenceId: ` ${EVIDENCE.toUpperCase()} ` })).toEqual({ amount_vnd: '1000', basis: 'REFUND', evidence_document_version_id: EVIDENCE });
    expect(recoveryBody({ amount: '1', basis: 'COMPENSATION_PAYMENT', sourceRef: EVIDENCE.toUpperCase(), evidenceId: EVIDENCE })).toMatchObject({ source_ref_id: EVIDENCE });
    expect(recoveryBody({ amount: '1', basis: '', sourceRef: '', evidenceId: EVIDENCE }).basis).toBe('OTHER');
  });

  it('asks for a reason to cancel', () => {
    expect(validateCancel(EMPTY_CANCEL)).toEqual({ reason: 'required' });
    expect(validateCancel({ reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateCancel({ reason: 'Not needed' })).toEqual({});
    expect(cancelBody({ reason: ' Not needed ' })).toEqual({ reason: 'Not needed' });
  });

  it('words every refusal of the server', () => {
    const cases: Array<[string, string]> = [
      ['ADVANCE_RECOVERY_EXCEEDED', 'recoveryExceeded'],
      ['ADVANCE_STATE_INVALID', 'stateInvalid'],
      ['DOCUMENT_NOT_CLEAN', 'documentNotClean'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(refusal(code))).toBe(problem);
    expect(describeProblem(new Error('x'))).toBe('general');
  });

  it('reads the alert of an advance: the level, the day it became overdue and the plan, and tolerates their absence', () => {
    expect(toAdvance(advance(1))).toMatchObject({ lastAlertLevel: 0, overdueSince: null, acknowledgement: null, actions: { acknowledgeAlert: false } });
    const plan = { note: 'Hoàn trả', action_plan_due_on: '2999-01-31', acknowledged_by: 'm', acknowledged_at: 't' };
    expect(toAdvance(advance(1, { last_alert_level: 3, overdue_since: '2026-08-01', acknowledgement: plan, actions: { acknowledge_alert: true } }))).toMatchObject({
      lastAlertLevel: 3,
      overdueSince: '2026-08-01',
      acknowledgement: { note: 'Hoàn trả', planDueOn: '2999-01-31', by: 'm', at: 't' },
      actions: { acknowledgeAlert: true },
    });
    expect(toAdvance(advance(1, { last_alert_level: 'x', acknowledgement: { note: 'only' } }))).toMatchObject({ lastAlertLevel: 0, acknowledgement: null });
    expect(toAdvance(advance(1, { acknowledgement: { note: 'n', action_plan_due_on: 'd' } }))?.acknowledgement).toEqual({ note: 'n', planDueOn: 'd', by: '', at: '' });
    expect(ALERT_LEVELS).toEqual([1, 2, 3, 4]);
  });

  it('validates the plan of recovery: a note and a day that is not before today', () => {
    const today = '2026-10-31';
    expect(validateAcknowledge({ note: ' Hoàn trả ', planDueOn: today }, today)).toEqual({});
    expect(validateAcknowledge(EMPTY_ACKNOWLEDGE, today)).toEqual({ note: 'required', planDueOn: 'required' });
    expect(validateAcknowledge({ note: 'x'.repeat(2001), planDueOn: '2026-10-30' }, today)).toEqual({ note: 'tooLong', planDueOn: 'date' });
    expect(validateAcknowledge({ note: 'n', planDueOn: '2026-02-30' }, today)).toEqual({ planDueOn: 'date' });
    expect(validateAcknowledge({ note: 'n', planDueOn: 'soon' }, today)).toEqual({ planDueOn: 'date' });
    expect(acknowledgeBody({ note: ' Hoàn trả ', planDueOn: '2999-01-31' })).toEqual({ note: 'Hoàn trả', action_plan_due_on: '2999-01-31' });
    expect(describeProblem(refusal('ADVANCE_NOT_OVERDUE'))).toBe('notOverdue');
    expect(vietnamToday(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10-31');
    expect(vietnamToday(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01');
  });
});
