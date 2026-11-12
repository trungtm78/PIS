import { outcomeOf, planOf, syncRequestHashOf } from '../src/sync-command';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};

describe('the operations that queued commands stand for (ST-MOB-005)', () => {
  it('sends a report to the operation that submits it, at the version the phone saw, and a draft to the one that revises it', () => {
    expect(planOf('report.submit', { report_id: ID })).toEqual({ path: `/reports/${ID}/submit`, body: {}, versioned: true });
    expect(planOf('report.draft.save', { report_id: ID.toUpperCase(), quantity: 3 })).toEqual({ path: `/reports/${ID}/revisions`, body: { quantity: 3 }, versioned: true });
  });

  it('sends an issue, a measurement and a diary to their operations, a revision of a diary draft to the one that revises it', () => {
    expect(planOf('issue.create', { title: 'Blocked road' })).toEqual({ path: '/issues', body: { title: 'Blocked road' }, versioned: false });
    expect(planOf('measurement.record', { contract_id: ID, quantity_period: '4' })).toEqual({ path: `/contracts/${ID}/measurements`, body: { quantity_period: '4' }, versioned: false });
    expect(planOf('site_diary.append', { work_date: '2026-10-30' }, 4)).toEqual({ path: '/site-diaries', body: { work_date: '2026-10-30', base_server_version: 4 }, versioned: false });
    // The version of the envelope is the one the phone read: a copy of it in the payload does not override it.
    expect(planOf('site_diary.append', { work_date: '2026-10-30', base_server_version: 99 }, 4).body).toMatchObject({ base_server_version: 4 });
    expect(planOf('site_diary.append', { diary_id: ID, note: 'x' })).toEqual({ path: `/site-diaries/${ID}/draft`, body: { note: 'x' }, versioned: true });
  });

  it('sends the result of an inspection to the operation that records it, over the version the phone read (ST-MOB-021)', () => {
    const result = { result: 'CONDITIONAL', result_note: 'replace the steel', checklist: [{ code: 'K1', outcome: 'FAIL', note: 'x' }] };
    expect(planOf('inspection.result', { inspection_id: ID.toUpperCase(), ...result }, 3)).toEqual({ path: `/inspections/${ID}/result`, body: result, versioned: true });
    expect(refusal(() => planOf('inspection.result', { inspection_id: '../../admin', ...result }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'inspection_id' });
    expect(refusal(() => planOf('inspection.result', result))).toEqual({ code: 'VALIDATION_FAILED', detail: 'inspection_id' });
  });

  it('sends the work on a task of a project to the operations of the workflow, over the version the phone read, and never carries a decision (PWF, MOB-79)', () => {
    expect(planOf('pwf.task.start', { task_id: ID.toUpperCase(), note: 'on site' }, 5)).toEqual({ path: `/project-tasks/${ID}/start`, body: { note: 'on site' }, versioned: true });
    expect(planOf('pwf.task.checklist.complete', { task_id: ID, item_code: 'C-1.a', note: 'done' })).toEqual({ path: `/project-tasks/${ID}/checklist/C-1.a/complete`, body: { note: 'done' }, versioned: true });
    expect(planOf('pwf.task.complete', { task_id: ID, note: 'all in' })).toEqual({ path: `/project-tasks/${ID}/complete`, body: { note: 'all in' }, versioned: true });
    // Evidence and a request for an exception do not move the version of the task: no If-Match.
    expect(planOf('pwf.task.evidence.attach', { task_id: ID, evidence_kind: 'DOCUMENT', external_ref: 'QD-12' })).toEqual({ path: `/project-tasks/${ID}/evidence`, body: { evidence_kind: 'DOCUMENT', external_ref: 'QD-12' }, versioned: false });
    expect(planOf('pwf.task.exception.request', { task_id: ID, kind: 'PAUSE', reason: 'the site is flooded for a week' })).toEqual({ path: `/project-tasks/${ID}/exceptions`, body: { kind: 'PAUSE', reason: 'the site is flooded for a week' }, versioned: false });
    for (const decision of ['pwf.task.approve', 'pwf.task.return', 'pwf.exception.decide']) expect(refusal(() => planOf(decision, { task_id: ID }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'command_type' });
  });

  it('puts only a task id that is a UUID and an item code that is a code into the path of a task command', () => {
    for (const type of ['pwf.task.start', 'pwf.task.complete', 'pwf.task.evidence.attach', 'pwf.task.exception.request']) {
      expect(refusal(() => planOf(type, { task_id: '../../admin' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'task_id' });
    }
    for (const bad of ['../x', 'a/b', '', 'a b', 7, undefined, 'x'.repeat(61)]) {
      expect(refusal(() => planOf('pwf.task.checklist.complete', { task_id: ID, item_code: bad }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'item_code' });
    }
  });

  it('never puts anything but a UUID into a path, and refuses a type it does not carry and a payload that is not an object', () => {
    for (const bad of ['../../admin', `${ID}/extra`, '', 7, undefined]) {
      expect(refusal(() => planOf('report.submit', { report_id: bad }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'report_id' });
    }
    expect(refusal(() => planOf('contract.terminate', {}))).toEqual({ code: 'VALIDATION_FAILED', detail: 'command_type' });
    for (const bad of [null, [], 'x', 3]) expect(refusal(() => planOf('issue.create', bad))).toEqual({ code: 'VALIDATION_FAILED', detail: 'payload' });
    expect(refusal(() => planOf('site_diary.append', { diary_id: 'nope' })).detail).toBe('diary_id');
  });

  it('tells the same command from another one sent with the same key: the type, the version and the payload all count, the order of the fields does not', () => {
    const base = { command_type: 'issue.create', base_server_version: 0, payload: { a: 1, b: { c: 2 } } };
    expect(syncRequestHashOf(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(syncRequestHashOf({ ...base, payload: { b: { c: 2 }, a: 1 } })).toBe(syncRequestHashOf(base));
    expect(syncRequestHashOf({ ...base, payload: { a: 1, b: { c: 3 } } })).not.toBe(syncRequestHashOf(base));
    expect(syncRequestHashOf({ ...base, base_server_version: 1 })).not.toBe(syncRequestHashOf(base));
    expect(syncRequestHashOf({ ...base, command_type: 'report.submit' })).not.toBe(syncRequestHashOf(base));
  });
});

describe('what the operation answered, in the words of the sync endpoint', () => {
  it('takes any 2xx as done, with the version and the id the operation gave', () => {
    expect(outcomeOf(201, { resource_version: 4, resource_id: ID })).toEqual({ kind: 'accepted', serverVersion: 4, resultRef: ID });
    expect(outcomeOf(202, {})).toEqual({ kind: 'accepted', serverVersion: undefined, resultRef: undefined });
  });

  it('takes a version conflict as a conflict for the person to settle, with the version the server holds, and any other 409 as a refusal', () => {
    expect(outcomeOf(409, { code: 'VERSION_CONFLICT', current_version: 7 })).toEqual({ kind: 'conflict', code: 'VERSION_CONFLICT', serverVersion: 7 });
    expect(outcomeOf(409, { code: 'DRAFT_VERSION_CONFLICT' })).toEqual({ kind: 'conflict', code: 'DRAFT_VERSION_CONFLICT', serverVersion: undefined });
    // The site diary keeps the copy of the phone beside the diary of the day and says which version it holds.
    expect(outcomeOf(409, { code: 'DIARY_SYNC_CONFLICT', server_version: 5, diary_id: null })).toEqual({ kind: 'conflict', code: 'DIARY_SYNC_CONFLICT', serverVersion: 5 });
    expect(outcomeOf(409, { code: 'IDEMPOTENCY_CONFLICT' })).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_CONFLICT' });
    expect(outcomeOf(422, { code: 'PERIOD_LOCKED' })).toEqual({ kind: 'rejected', code: 'PERIOD_LOCKED' });
    expect(outcomeOf(403, { code: 'SCOPE_DENIED' })).toEqual({ kind: 'rejected', code: 'SCOPE_DENIED' });
    expect(outcomeOf(404, 'not json')).toEqual({ kind: 'rejected', code: 'COMMAND_REFUSED' });
  });

  it('does not settle what may go away: a failure of the server, a rate limit, a lapsed session, no answer', () => {
    expect(outcomeOf(500, { code: 'INTERNAL_ERROR' })).toEqual({ kind: 'transient', code: 'INTERNAL_ERROR' });
    expect(outcomeOf(503, null)).toEqual({ kind: 'transient', code: 'UNAVAILABLE' });
    expect(outcomeOf(429, { code: 'RATE_LIMITED' })).toEqual({ kind: 'transient', code: 'RATE_LIMITED' });
    expect(outcomeOf(401, { code: 'SESSION_EXPIRED' })).toEqual({ kind: 'transient', code: 'SESSION_EXPIRED' });
    // Still being carried out by another request: not settled, so not remembered as a refusal.
    expect(outcomeOf(409, { code: 'IDEMPOTENCY_IN_PROGRESS' })).toEqual({ kind: 'transient', code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(outcomeOf(0, undefined)).toEqual({ kind: 'transient', code: 'UNAVAILABLE' });
  });
});
