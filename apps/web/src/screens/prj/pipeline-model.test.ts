import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STAGE_FORM,
  ENDED_STAGES,
  OPEN_STAGES,
  STAGE_OPERATIONS,
  STAGE_PERMISSIONS,
  canOpenMoves,
  cardsOf,
  describeStageProblem,
  documentFieldOf,
  inputGuards,
  offeredMoves,
  stageBody,
  toBoardCard,
  toBoardPage,
  toLifecycle,
  unmetGuards,
  validateStageForm,
  warningGuards,
} from './pipeline-model';
import type { NextMove } from './pipeline-model';
import { card, lifecycle, move } from './pipeline-test-support';

const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });
const nextMove = (operation: NextMove['operation'], guards: NextMove['guards'] = [], allowed = true): NextMove => ({ operation, to: 'IMPLEMENTATION', allowed, guards });
const DOCUMENT_ID = '00000000-0000-4000-8000-000000000900';

describe('the columns of the project bank', () => {
  it('opens with the eight stages a project is in and keeps the three that end its life apart', () => {
    expect(OPEN_STAGES).toEqual(['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED']);
    expect(ENDED_STAGES).toEqual(['CLOSED', 'REJECTED', 'CANCELLED']);
  });
});

describe('the readers of the project bank', () => {
  it('reads a card with its figures, and nothing that is not a card', () => {
    expect(toBoardCard(card(1, { leader_in_charge: { membership_id: 'm', display_name: 'Nguyễn Văn An' }, capital_ready: false }))).toEqual({
      id: card(1).id,
      code: 'DA-2026-001',
      name: 'Dự án số 1',
      status: 'PIPELINE',
      projectGroup: 'B',
      appraisalScore: '72.50',
      totalInvestmentVnd: '500000000000',
      nationalProjectCode: '7654321',
      capitalReady: false,
      leaderName: 'Nguyễn Văn An',
      version: 1,
    });
    expect(toBoardCard(card(2, { project_group: null, appraisal_score: null, national_project_code: null, capital_ready: null }))).toMatchObject({ projectGroup: null, appraisalScore: null, nationalProjectCode: null, capitalReady: null, leaderName: null });
    for (const broken of [null, 'x', [], { ...card(3), status: 'LIMBO' }, { ...card(3), version: '1' }, { ...card(3), id: undefined }, { ...card(3), total_investment_vnd: 5 }]) expect(toBoardCard(broken)).toBeUndefined();
  });

  it('reads a page: the cards that are cards, the total and the cursor', () => {
    const page = toBoardPage({ items: [card(1), { broken: true }, card(2)], total: 7, next_cursor: 'abc' });
    expect(page.cards.map((entry) => entry.code)).toEqual(['DA-2026-001', 'DA-2026-002']);
    expect([page.total, page.nextCursor]).toEqual([7, 'abc']);
    expect(toBoardPage({ items: [card(1)], total: 1, next_cursor: null }).nextCursor).toBeNull();
    expect(toBoardPage(undefined)).toEqual({ cards: [], total: 0, nextCursor: null });
    expect(cardsOf([page, toBoardPage({ items: [card(3)] })]).map((entry) => entry.code)).toEqual(['DA-2026-001', 'DA-2026-002', 'DA-2026-003']);
  });

  it('reads the lifecycle with its history and the moves, dropping what it does not know', () => {
    const read = toLifecycle(
      lifecycle(
        4,
        'BUDGETED',
        [
          move('startProjectImplementation', 'IMPLEMENTATION', [['INVESTMENT_DECISION_DOCUMENT', 'INPUT_REQUIRED'], ['NATIONAL_CODE', 'UNMET'], ['SOMETHING_NEW', 'MET'], ['NATIONAL_CODE', 'ODD']]),
          move('submitProjectForAppraisal', 'APPRAISAL'),
          { operation: 'cancelProject', to: 'LIMBO' },
          move('cancelProject', 'CANCELLED', [], false),
        ],
        [
          { from: 'PIPELINE', to: 'BUDGETED', actor_kind: 'SYSTEM', actor_name: null, reason: null, occurred_at: '2026-10-20T03:00:00.000Z' },
          { from: 'PIPELINE', to: 'BUDGETED', actor_kind: 'ROBOT' },
        ],
      ),
    );
    expect(read).toMatchObject({ code: 'DA-2026-004', status: 'BUDGETED', version: 3, nationalProjectCode: null });
    expect(read?.history).toEqual([{ from: 'PIPELINE', to: 'BUDGETED', actorKind: 'SYSTEM', actorName: null, reason: null, occurredAt: '2026-10-20T03:00:00.000Z' }]);
    expect(read?.next).toEqual([
      { operation: 'startProjectImplementation', to: 'IMPLEMENTATION', allowed: true, guards: [{ key: 'INVESTMENT_DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }, { key: 'NATIONAL_CODE', state: 'UNMET' }] },
      { operation: 'cancelProject', to: 'CANCELLED', allowed: false, guards: [] },
    ]);
    expect(toLifecycle({ ...lifecycle(4, 'BUDGETED', []), history: undefined, next: undefined })).toMatchObject({ history: [], next: [] });
    for (const broken of [null, {}, { ...lifecycle(4, 'BUDGETED', []), status: 'LIMBO' }, { ...lifecycle(4, 'BUDGETED', []), version: 'x' }]) expect(toLifecycle(broken)).toBeUndefined();
  });
});

describe('the confirmation of a move', () => {
  it('offers only the moves the caller may make, and tells the guards apart', () => {
    const read = toLifecycle(
      lifecycle(5, 'BUDGETED', [
        move('startProjectImplementation', 'IMPLEMENTATION', [['INVESTMENT_DECISION_DOCUMENT', 'INPUT_REQUIRED'], ['NATIONAL_CODE', 'UNMET']]),
        move('cancelProject', 'CANCELLED', [['OPEN_OBLIGATIONS', 'WARNING']], false),
      ]),
    );
    if (read === undefined) throw new Error('expected a lifecycle');
    expect(offeredMoves(read).map((entry) => entry.operation)).toEqual(['startProjectImplementation']);
    const start = read.next[0] as NextMove;
    expect(unmetGuards(start).map((guard) => guard.key)).toEqual(['NATIONAL_CODE']);
    expect(inputGuards(start).map((guard) => guard.key)).toEqual(['INVESTMENT_DECISION_DOCUMENT']);
    expect(warningGuards(read.next[1] as NextMove).map((guard) => guard.key)).toEqual(['OPEN_OBLIGATIONS']);
  });

  it('opens the confirmation for a caller who holds a stage permission, never for a read-only session or one without any', () => {
    expect(canOpenMoves(undefined, undefined)).toBe(true);
    expect(canOpenMoves(['project.read', 'project.stage.cancel'], 'FULL')).toBe(true);
    expect(canOpenMoves(['project.read'], 'FULL')).toBe(false);
    expect(canOpenMoves(['project.stage.cancel'], 'READ_ONLY')).toBe(false);
    expect(Object.keys(STAGE_PERMISSIONS)).toEqual([...STAGE_OPERATIONS]);
  });

  it('checks the reason, the document and the date before anything is sent', () => {
    const start = nextMove('startProjectImplementation', [{ key: 'INVESTMENT_DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }]);
    expect(validateStageForm(start, EMPTY_STAGE_FORM)).toEqual({ reason: 'reasonRequired', documentId: 'documentRequired' });
    expect(validateStageForm(start, { reason: 'abcd', documentId: 'nope', effectiveDate: '2026-13-45' })).toEqual({ reason: 'reasonShort', documentId: 'documentInvalid', effectiveDate: 'dateInvalid' });
    expect(validateStageForm(start, { reason: 'x'.repeat(2001), documentId: DOCUMENT_ID, effectiveDate: '26-01-01' })).toEqual({ reason: 'reasonLong', effectiveDate: 'dateInvalid' });
    expect(validateStageForm(start, { reason: ' A reason ', documentId: DOCUMENT_ID.toUpperCase(), effectiveDate: '2026-11-01' })).toEqual({});
    // A move that takes no document needs none; one that is typed anyway must still be a document id.
    const resume = nextMove('resumeProject');
    expect(validateStageForm(resume, { reason: 'Back to work', documentId: '', effectiveDate: '' })).toEqual({});
    expect(validateStageForm(resume, { reason: 'Back to work', documentId: 'nope', effectiveDate: '' })).toEqual({ documentId: 'documentInvalid' });
  });

  it('builds the body of the command from the guard that asks for the document, trimmed and in lower case, leaving out what was not filled', () => {
    const start = nextMove('startProjectImplementation', [{ key: 'INVESTMENT_DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }]);
    expect(stageBody(start, { reason: '  Ready to build  ', documentId: ` ${DOCUMENT_ID.toUpperCase()} `, effectiveDate: '2026-11-01' })).toEqual({
      reason: 'Ready to build',
      investment_decision_document_id: DOCUMENT_ID,
      effective_date: '2026-11-01',
    });
    const suspend = nextMove('suspendProject', [{ key: 'DECISION_DOCUMENT', state: 'INPUT_REQUIRED' }]);
    expect(stageBody(suspend, { reason: 'Flood season', documentId: DOCUMENT_ID, effectiveDate: '' })).toEqual({ reason: 'Flood season', decision_document_id: DOCUMENT_ID });
    expect(stageBody(nextMove('resumeProject'), { reason: 'Back to work', documentId: '', effectiveDate: '' })).toEqual({ reason: 'Back to work' });
    expect(documentFieldOf('NATIONAL_CODE')).toBeUndefined();
    expect(documentFieldOf('OPEN_OBLIGATIONS')).toBeUndefined();
  });

  it('maps the refusals of a stage command to what the confirmation says', () => {
    const reasons = Object.fromEntries(
      ['STAGE_TRANSITION_DENIED', 'DECISION_REQUIRED', 'NATIONAL_CODE_REQUIRED', 'NATIONAL_CODE_FORMAT_INVALID', 'OPEN_OBLIGATIONS_EXIST', 'VERSION_CONFLICT', 'VALIDATION_FAILED', 'FIELD_NOT_ALLOWED', 'RESOURCE_NOT_FOUND', 'SCOPE_DENIED', 'SOMETHING_ELSE'].map((code) => [code, describeStageProblem(problem(code))]),
    );
    expect(reasons).toEqual({
      STAGE_TRANSITION_DENIED: 'transitionDenied',
      DECISION_REQUIRED: 'decisionRequired',
      NATIONAL_CODE_REQUIRED: 'nationalCodeRequired',
      NATIONAL_CODE_FORMAT_INVALID: 'nationalCodeFormat',
      OPEN_OBLIGATIONS_EXIST: 'openObligations',
      VERSION_CONFLICT: 'versionConflict',
      VALIDATION_FAILED: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
      SOMETHING_ELSE: 'general',
    });
    expect(describeStageProblem(new Error('network'))).toBe('general');
  });
});
