import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { UUID_A, UUID_B, closure, completion, noActions, readiness, summary } from './test-support';
import {
  MAX_TEXT,
  activateBody,
  checksOf,
  closeBody,
  closureChecksOf,
  completeBody,
  completionChecksOf,
  describeProblem,
  emptyActivate,
  emptyClose,
  emptyComplete,
  emptySign,
  evidenceIds,
  isDate,
  signBody,
  toSummary,
  validateActivate,
  validateClose,
  validateComplete,
  validateNote,
  validateSign,
  vietnamToday,
} from './model';

const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 409, code, correlationId: 'c', extensions });

describe('toSummary', () => {
  it('reads the contract, the people behind the signature, the readiness and the actions', () => {
    const read = toSummary(summary('SIGNED', { signed_on: '2026-10-20', signed_by: UUID_A, effective_from: '2026-11-01', actions: { ...noActions, activate: true } }));
    expect(read?.contract.status).toBe('SIGNED');
    expect(read?.signedBy).toBe(UUID_A);
    expect(read?.signedOn).toBe('2026-10-20');
    expect(read?.effectiveFrom).toBe('2026-11-01');
    expect(read?.actions).toEqual({ ...noActions, activate: true });
    expect(read?.readiness?.boq).toEqual({ totalVnd: '10200000000', balanced: true });
    expect(read?.readiness?.permitGate).toEqual({ required: true, status: 'PASSED', blocking: [] });
  });

  it('leaves out what the caller may not see, and refuses what is not a contract', () => {
    const guest: Record<string, unknown> = { ...summary('SIGNED') };
    delete guest.readiness;
    delete guest.actions;
    const read = toSummary(guest);
    expect(read?.readiness).toBeUndefined();
    expect(read?.actions).toBeUndefined();
    expect(read?.createdBy).not.toBeUndefined();
    expect(toSummary({ nothing: true })).toBeUndefined();
    expect(toSummary(null)).toBeUndefined();
    expect(toSummary('x')).toBeUndefined();
  });

  it('drops a readiness that is malformed, and the gate blockers that are not text', () => {
    expect(toSummary(summary('DRAFT', { readiness: { boq: {} } }))?.readiness).toBeUndefined();
    expect(toSummary(summary('DRAFT', { readiness: readiness({ permit_gate: { required: true, status: 'WEIRD', blocking: [] } }) }))?.readiness).toBeUndefined();
    expect(toSummary(summary('DRAFT', { readiness: 'x' }))?.readiness).toBeUndefined();
    const odd = toSummary(summary('DRAFT', { readiness: readiness({ permit_gate: { required: true, status: 'BLOCKED', blocking: ['GPXD', 4] } }) }));
    expect(odd?.readiness?.permitGate.blocking).toEqual(['GPXD']);
    const sparse = toSummary(summary('DRAFT', { readiness: readiness({ permit_gate: { required: true, status: 'BLOCKED' }, capital: {}, project: {}, guarantee: {}, boq: { total_vnd: '1' } }) }));
    expect(sparse?.readiness).toEqual({
      boq: { totalVnd: '1', balanced: false },
      guarantee: { required: false, held: false },
      permitGate: { required: true, status: 'BLOCKED', blocking: [] },
      capital: { allocationLineId: null },
      project: { status: '', inImplementation: false },
    });
  });

  it('reads what the caller may do to stop, resume or end the contract', () => {
    expect(toSummary(summary('ACTIVE', { actions: { ...noActions, suspend: true, terminate: true } }))?.halts).toEqual({ suspend: true, resume: false, terminate: true });
    expect(toSummary(summary('ACTIVE', { actions: noActions }))?.halts).toEqual({ suspend: false, resume: false, terminate: false });
    expect(toSummary(summary('ACTIVE', { actions: 'x' }))?.halts).toBeUndefined();
  });

  it('reads an action that is not true as false', () => {
    expect(toSummary(summary('DRAFT', { actions: { submit: 'yes' } }))?.actions).toEqual(noActions);
    expect(toSummary(summary('DRAFT', { actions: 'x' }))?.actions).toBeUndefined();
  });
});

describe('checksOf', () => {
  it('judges the conditions in the order the activation does, and marks the ones that do not apply', () => {
    const none = checksOf(
      toSummary(summary('DRAFT', { readiness: readiness({ guarantee: { required: false, held: false }, permit_gate: { required: false, status: 'NOT_REQUIRED', blocking: [] } }) }))!.readiness!,
    );
    expect(none.map((check) => [check.key, check.ok])).toEqual([
      ['boq', true],
      ['guarantee', undefined],
      ['permitGate', undefined],
      ['capital', true],
      ['project', true],
    ]);
    const unmet = checksOf(
      toSummary(
        summary('DRAFT', {
          readiness: readiness({
            boq: { total_vnd: '5', balanced: false },
            guarantee: { required: true, held: false },
            permit_gate: { required: true, status: 'BLOCKED', blocking: ['GPXD'] },
            capital: { allocation_line_id: null },
            project: { status: 'PIPELINE', in_implementation: false },
          }),
        }),
      )!.readiness!,
    );
    expect(unmet.map((check) => check.ok)).toEqual([false, false, false, false, false]);
    expect(unmet[2]?.detail).toEqual(['GPXD']);
    expect(unmet[4]?.detail).toEqual(['PIPELINE']);
    const waived = checksOf(toSummary(summary('DRAFT', { readiness: readiness({ permit_gate: { required: true, status: 'PASSED_WITH_WAIVER', blocking: [] } }) }))!.readiness!);
    expect(waived[2]?.ok).toBe(true);
  });
});

describe('the dates', () => {
  it('accepts a real day and refuses a rollover, a shape that is not a date and a blank', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate(' 2026-02-28 ')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-2-3')).toBe(false);
    expect(isDate('')).toBe(false);
  });

  it('counts the day in Vietnam, seven hours ahead', () => {
    expect(vietnamToday(new Date('2026-10-24T18:00:00.000Z'))).toBe('2026-10-25');
    expect(vietnamToday(new Date('2026-10-24T16:59:00.000Z'))).toBe('2026-10-24');
  });
});

describe('the forms', () => {
  it('lets a submission go without a note, and asks for the reason of a return', () => {
    expect(validateNote({ text: '  ' }, false)).toEqual({});
    expect(validateNote({ text: '  ' }, true)).toEqual({ text: 'required' });
    expect(validateNote({ text: 'x'.repeat(MAX_TEXT + 1) }, false)).toEqual({ text: 'tooLong' });
    expect(validateNote({ text: 'x'.repeat(MAX_TEXT) }, true)).toEqual({});
  });

  it('judges the signing: the day, the file and the length of the decision', () => {
    const today = '2026-10-25';
    expect(validateSign(emptySign(today), today)).toEqual({ documentVersionId: 'required' });
    expect(validateSign({ signedOn: '', documentVersionId: UUID_A, decisionRef: '' }, today)).toEqual({ signedOn: 'required' });
    expect(validateSign({ signedOn: '2026-13-01', documentVersionId: UUID_A, decisionRef: '' }, today)).toEqual({ signedOn: 'date' });
    expect(validateSign({ signedOn: '2026-10-26', documentVersionId: UUID_A, decisionRef: '' }, today)).toEqual({ signedOn: 'future' });
    expect(validateSign({ signedOn: today, documentVersionId: 'nope', decisionRef: 'x'.repeat(MAX_TEXT + 1) }, today)).toEqual({ documentVersionId: 'uuid', decisionRef: 'tooLong' });
  });

  it('builds the body of a signing, trimmed and lowercase, with the decision only when there is one', () => {
    expect(signBody({ signedOn: ' 2026-10-20 ', documentVersionId: ` ${UUID_A.toUpperCase()} `, decisionRef: '' })).toEqual({ signed_on: '2026-10-20', signed_document_version_id: UUID_A });
    expect(signBody({ signedOn: '2026-10-20', documentVersionId: UUID_A, decisionRef: ' QD-1 ' }).conflict_decision_ref).toBe('QD-1');
  });

  it('judges the activation: the day against the signing, the reason, and every identifier of the evidence', () => {
    const base = { ...emptyActivate('2026-10-25'), reason: 'Yes.' };
    expect(validateActivate(base, '2026-10-20')).toEqual({});
    expect(validateActivate(base, null)).toEqual({});
    expect(validateActivate({ ...base, effectiveFrom: '' }, null)).toEqual({ effectiveFrom: 'required' });
    expect(validateActivate({ ...base, effectiveFrom: 'x' }, null)).toEqual({ effectiveFrom: 'date' });
    expect(validateActivate({ ...base, effectiveFrom: '2026-10-19' }, '2026-10-20')).toEqual({ effectiveFrom: 'beforeSigning' });
    expect(validateActivate({ ...base, reason: ' ' }, null)).toEqual({ reason: 'required' });
    expect(validateActivate({ ...base, reason: 'x'.repeat(MAX_TEXT + 1) }, null)).toEqual({ reason: 'tooLong' });
    expect(validateActivate({ ...base, evidence: `${UUID_A}, bad` }, null)).toEqual({ evidence: 'evidence' });
  });

  it('splits the evidence on lines, commas and semicolons, and sends each document once', () => {
    const form = { effectiveFrom: '2026-11-01', reason: ' Yes. ', evidence: `${UUID_A}\n${UUID_A.toUpperCase()};${UUID_B}, ` };
    expect(evidenceIds(form)).toEqual([UUID_A, UUID_A, UUID_B]);
    expect(activateBody(form)).toEqual({ decision: 'approve', reason: 'Yes.', evidence_ids: [UUID_A, UUID_B], effective_from: '2026-11-01' });
    expect(evidenceIds({ ...form, evidence: '' })).toEqual([]);
  });
});

describe('describeProblem', () => {
  it('names the conflict by whose it is', () => {
    expect(describeProblem(problem('CONFLICT_OF_INTEREST_BLOCKED', { conflict_of: 'REVIEWER' })).problem).toBe('conflictReviewer');
    expect(describeProblem(problem('CONFLICT_OF_INTEREST_BLOCKED', { conflict_of: 'ACTOR' })).problem).toBe('conflictActor');
    expect(describeProblem(problem('CONFLICT_OF_INTEREST_BLOCKED')).problem).toBe('conflictActor');
  });

  it('tells a delegation limit from a plain denial', () => {
    expect(describeProblem(problem('SCOPE_DENIED', { approver_role_id: UUID_A })).problem).toBe('delegation');
    expect(describeProblem(problem('SCOPE_DENIED')).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED')).problem).toBe('denied');
  });

  it('carries the permit types that block the gate and the cause the capital gave', () => {
    expect(describeProblem(problem('PERMIT_GATE_BLOCKED', { blocking: [{ permit_type_code: 'GPXD' }, { other: 1 }, 'x', { permit_type_code: 'PCCC' }] }))).toEqual({
      problem: 'gateBlocked',
      detail: ['GPXD', 'PCCC'],
    });
    expect(describeProblem(problem('PERMIT_GATE_BLOCKED'))).toEqual({ problem: 'gateBlocked', detail: [] });
    expect(describeProblem(problem('FUND_COMMIT_FAILED', { cause: 'AVC_BLOCKED' }))).toEqual({ problem: 'fundFailed', detail: ['AVC_BLOCKED'] });
    expect(describeProblem(problem('FUND_COMMIT_FAILED'))).toEqual({ problem: 'fundFailed', detail: [] });
  });

  it('names the decision document that is missing and the guarantee that is not there to call', () => {
    expect(describeProblem(problem('DECISION_DOCUMENT_REQUIRED')).problem).toBe('decisionDocument');
    expect(describeProblem(problem('VALIDATION_FAILED', { reason: 'NO_ACTIVE_GUARANTEE' })).problem).toBe('noGuarantee');
    expect(describeProblem(problem('VALIDATION_FAILED', { reason: 'OTHER' })).problem).toBe('validation');
    expect(describeProblem(problem('VALIDATION_FAILED')).problem).toBe('validation');
  });

  it('maps every other code of the commands to its sentence, and the rest to the general one', () => {
    const codes: Record<string, string> = {
      SELF_APPROVAL_DENIED: 'selfApproval',
      DOA_RULE_NOT_FOUND: 'noRule',
      PERFORMANCE_GUARANTEE_MISSING: 'guaranteeMissing',
      PROJECT_STAGE_INVALID: 'projectStage',
      BOQ_TOTAL_MISMATCH: 'boqMismatch',
      JV_SHARE_NOT_100: 'jvShares',
      CAPITAL_PLAN_NOT_APPROVED: 'capitalPlan',
      CONTRACT_VALUE_EXCEEDS_CEILING: 'ceiling',
      CONTRACTOR_NOT_VERIFIED: 'contractor',
      CONTRACTOR_RESTRICTED: 'contractor',
      DOCUMENT_NOT_CLEAN: 'documentNotClean',
      CONTRACT_STATE_INVALID: 'stateInvalid',
      VERSION_CONFLICT: 'versionConflict',
      VALIDATION_FAILED: 'validation',
      INVALID_REQUEST: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SESSION_EXPIRED: 'session',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, expected] of Object.entries(codes)) expect(describeProblem(problem(code)).problem).toBe(expected);
    expect(describeProblem(new Error('x'))).toEqual({ problem: 'general', detail: [] });
  });
});

describe('the completion of a contract', () => {
  const minutes = (id: string, recordNo: string) => ({ id, record_no: recordNo, approved_on: '2026-10-20' });

  it('reads the way to completion from the summary and keeps what cannot be read out of it', () => {
    const read = toSummary(
      summary('ACTIVE', {
        completion: completion({ acceptances: [minutes(UUID_A, 'QA-C-001'), { id: 5 }, { id: UUID_B }], open_critical_ncr_ids: [UUID_A, 7], pending_measurement_ids: 'none' }),
        actions: { ...noActions, complete: true },
      }),
    );
    expect(read?.completion).toEqual({
      acceptances: [
        { id: UUID_A, recordNo: 'QA-C-001', approvedOn: '2026-10-20' },
        { id: UUID_B, recordNo: UUID_B, approvedOn: '' },
      ],
      openCriticalNcrIds: [UUID_A],
      pendingMeasurementIds: [],
    });
    expect(read?.actions?.complete).toBe(true);
    expect(toSummary(summary('ACTIVE', { completion: undefined }))?.completion).toBeUndefined();
    expect(toSummary(summary('ACTIVE', { completion: { acceptances: 'none' } }))?.completion).toEqual({ acceptances: [], openCriticalNcrIds: [], pendingMeasurementIds: [] });
  });

  it('judges the checks in the order the completion does, with how many stand in the way', () => {
    const checks = completionChecksOf({ acceptances: [], openCriticalNcrIds: [UUID_A, UUID_B], pendingMeasurementIds: [] });
    expect(checks).toEqual([
      { key: 'acceptance', ok: false, count: 0 },
      { key: 'ncr', ok: false, count: 2 },
      { key: 'measurement', ok: true, count: 0 },
    ]);
  });

  it('chooses the minutes when there is one to choose from, asks for them and the day, and sends both', () => {
    const one = { acceptances: [{ id: UUID_A, recordNo: 'QA-C-001', approvedOn: '2026-10-20' }], openCriticalNcrIds: [], pendingMeasurementIds: [] };
    expect(emptyComplete('2026-10-25', one)).toEqual({ acceptanceId: UUID_A, completedOn: '2026-10-25' });
    expect(emptyComplete('2026-10-25', { ...one, acceptances: [...one.acceptances, { id: UUID_B, recordNo: 'QA-C-002', approvedOn: '2026-10-21' }] }).acceptanceId).toBe('');
    expect(emptyComplete('2026-10-25', undefined).acceptanceId).toBe('');
    expect(validateComplete({ acceptanceId: '', completedOn: '' }, '2026-10-25')).toEqual({ acceptanceId: 'required', completedOn: 'required' });
    expect(validateComplete({ acceptanceId: UUID_A, completedOn: '2026-02-30' }, '2026-10-25')).toEqual({ completedOn: 'date' });
    expect(validateComplete({ acceptanceId: UUID_A, completedOn: '2026-10-26' }, '2026-10-25')).toEqual({ completedOn: 'future' });
    expect(validateComplete({ acceptanceId: UUID_A, completedOn: '2026-10-25' }, '2026-10-25')).toEqual({});
    expect(completeBody({ acceptanceId: UUID_A, completedOn: ' 2026-10-24 ' })).toEqual({ completion_quality_acceptance_id: UUID_A, completed_on: '2026-10-24' });
  });

  it('words the refusals of the completion', () => {
    const refusal = (code: string, extensions: Record<string, unknown> = {}) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c', extensions }));
    expect(refusal('COMPLETION_ACCEPTANCE_REQUIRED', { reason: 'MISSING' })).toEqual({ problem: 'completionAcceptance', detail: [] });
    expect(refusal('OPEN_CRITICAL_NCR', { nonconformance_ids: [UUID_A] })).toEqual({ problem: 'openCriticalNcr', detail: [UUID_A] });
    expect(refusal('MEASUREMENT_PENDING', { measurement_ids: [UUID_A, UUID_B] })).toEqual({ problem: 'measurementPending', detail: [UUID_A, UUID_B] });
    expect(refusal('OPEN_CRITICAL_NCR')).toEqual({ problem: 'openCriticalNcr', detail: [] });
  });
});

describe('the closure of a contract', () => {
  it('reads the way to closure from the summary and keeps what cannot be read out of it', () => {
    const read = toSummary(
      summary('COMPLETED', {
        closure: closure({
          settlements: [{ id: UUID_A, scope: 'PROJECT', revision: 3, excepted: true }, { id: 7 }, { id: UUID_B }],
          retention: { holds: 2, unresolved_vnd: '150000000' },
          unmet: ['RETENTION_UNRESOLVED', 'SOMETHING', 4],
        }),
        actions: { ...noActions, close: true },
      }),
    );
    expect(read?.closure).toEqual({
      settlements: [
        { id: UUID_A, scope: 'PROJECT', revision: 3, excepted: true },
        { id: UUID_B, scope: '', revision: 0, excepted: false },
      ],
      advanceOutstandingVnd: '1250000000',
      retention: { holds: 2, unresolvedVnd: '150000000' },
      unmet: ['RETENTION_UNRESOLVED'],
    });
    expect(read?.actions?.close).toBe(true);
    expect(toSummary(summary('COMPLETED', { closure: undefined }))?.closure).toBeUndefined();
    expect(toSummary(summary('COMPLETED', { closure: { settlements: 'none', retention: null } }))?.closure).toEqual({
      settlements: [],
      advanceOutstandingVnd: '0',
      retention: { holds: 0, unresolvedVnd: '0' },
      unmet: [],
    });
  });

  it('judges the checks in the order the closure does', () => {
    expect(closureChecksOf({ settlements: [], advanceOutstandingVnd: '0', retention: { holds: 0, unresolvedVnd: '0' }, unmet: ['SETTLEMENT_NOT_CLOSED', 'RETENTION_UNRESOLVED'] })).toEqual([
      { key: 'settlement', ok: false },
      { key: 'advance', ok: true },
      { key: 'retention', ok: false },
    ]);
  });

  it('chooses the settlement when there is only one to choose from, asks for it, and sends it with the note when there is one', () => {
    const one = toSummary(summary('COMPLETED', { closure: closure() }))?.closure;
    expect(emptyClose(one)).toEqual({ settlementId: UUID_A, note: '' });
    expect(emptyClose(one === undefined ? undefined : { ...one, settlements: [...one.settlements, { id: UUID_B, scope: 'PROJECT', revision: 1, excepted: false }] }).settlementId).toBe('');
    expect(emptyClose(undefined).settlementId).toBe('');
    expect(validateClose({ settlementId: '', note: '' })).toEqual({ settlementId: 'required' });
    expect(validateClose({ settlementId: UUID_A, note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(validateClose({ settlementId: UUID_A, note: ' ok ' })).toEqual({});
    expect(closeBody({ settlementId: UUID_A, note: '   ' })).toEqual({ settlement_revision_id: UUID_A });
    expect(closeBody({ settlementId: UUID_A, note: ' Done. ' })).toEqual({ settlement_revision_id: UUID_A, note: 'Done.' });
  });

  it('words the refusals of the closure', () => {
    const refusal = (code: string) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c' }));
    expect(refusal('SETTLEMENT_NOT_CLOSED')).toEqual({ problem: 'settlementNotClosed', detail: [] });
    expect(refusal('ADVANCE_OUTSTANDING')).toEqual({ problem: 'advanceOutstanding', detail: [] });
    expect(refusal('RETENTION_UNRESOLVED')).toEqual({ problem: 'retentionUnresolved', detail: [] });
  });
});
