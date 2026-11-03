import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  STEPS,
  canAbort,
  canApprove,
  clockOf,
  describeProblem,
  freezeRemainingMs,
  isBusy,
  isInteresting,
  isMinutesValid,
  isOpen,
  isReasonValid,
  isWindowValid,
  moneyTotals,
  startedByMe,
  stepState,
  toDetail,
  toMigration,
  toMigrationPage,
  toPlacements,
  toReconciliation,
} from './model';
import type { MigrationStatus, TableView } from './model';

const row = (overrides: Record<string, unknown> = {}) => ({ id: 'm-1', tenant_id: 't', from_placement_id: 'a', to_placement_id: 'b', status: 'Planned', write_freeze_max_minutes: 30, planned_window_start: '2026-11-03T03:00:00Z', reason: 'why', requested_by: 'u', created_at: '2026-11-03T02:00:00Z', version: 2, ...overrides });
const tableRow = (overrides: Record<string, unknown> = {}) => ({ table: 'allocation_line', source_rows: 2, target_rows: 2, rows_match: true, source_checksum: '1', target_checksum: '1', checksum_match: true, money: [{ column: 'amount_vnd', source: '5', target: '5', match: true }], money_match: true, match: true, ...overrides });
const problem = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status: 409, code, correlationId: 'corr', extensions, ...(detail === undefined ? {} : { detail }) });

describe('the model of SAS-23', () => {
  it('reads a migration, a page, a comparison, a detail and the placements, and takes what is not one for nothing', () => {
    expect(toMigration(null)).toBeUndefined();
    expect(toMigration({ id: 'x' })).toBeUndefined();
    expect(toMigration(row({ status: 'Whatever' }))).toBeUndefined();
    expect(toMigration(row())).toMatchObject({ id: 'm-1', status: 'Planned', writeFreezeMaxMinutes: 30, cutoverApprovedBy: undefined, checksumMatch: undefined, version: 2 });
    expect(toMigration(row({ status: 'Switched', cutover_approved_by: 'a', checksum_match: true, last_error_code: 'X', version: 'odd' }))).toMatchObject({ cutoverApprovedBy: 'a', checksumMatch: true, lastErrorCode: 'X', version: 1 });
    expect(toMigrationPage({ items: [row(), { nope: true }], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toMigrationPage({ items: [row(), { nope: true }], next_cursor: 'c' }).items).toHaveLength(1);
    expect(toMigrationPage('x')).toEqual({ items: [], nextCursor: undefined });
    expect(toReconciliation(null)).toBeUndefined();
    expect(toReconciliation({ match: true })).toBeUndefined();
    const result = toReconciliation({ match: false, measured_at: 't', source_rows: 3, target_rows: 2, mismatched_tables: ['a', 7], unreadable_tables: 'no', tables: [tableRow(), { table: 5 }, tableRow({ table: 'b', money: [{ column: 5 }, { column: 'c', source: null, target: '', match: false }], source_rows: null })] });
    expect(result).toMatchObject({ match: false, sourceRows: 3, targetRows: 2, mismatchedTables: ['a'], unreadableTables: [] });
    expect(result?.tables).toHaveLength(2);
    expect(result?.tables[1]).toMatchObject({ table: 'b', sourceRows: undefined, money: [{ column: 'c', source: undefined, target: undefined, match: false }] });
    expect(toDetail(null)).toBeUndefined();
    expect(toDetail({ migration: { id: 1 } })).toBeUndefined();
    expect(toDetail({ migration: row(), reconciliation: null })).toMatchObject({ migration: { id: 'm-1' }, reconciliation: undefined });
    expect(toPlacements('x')).toEqual([]);
    expect(toPlacements({ items: [{ id: 'p', kind: 'POOL', region: 'vn-north', status: 'Active', max_tenants: null, tenant_count: 4, incoming_migrations: 1, available: false }, { id: 'q', available: true }, { nope: 1 }] })).toEqual([
      { id: 'p', kind: 'POOL', region: 'vn-north', status: 'Active', maxTenants: undefined, tenantCount: 4, incomingMigrations: 1, available: false },
      { id: 'q', kind: 'SILO', region: '', status: '', maxTenants: undefined, tenantCount: 0, incomingMigrations: 0, available: true },
    ]);
  });

  it('knows what each state allows', () => {
    const open: MigrationStatus[] = ['Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched'];
    const over: MigrationStatus[] = ['Completed', 'Aborted', 'RolledBack'];
    expect(open.map(isOpen)).toEqual(open.map(() => true));
    expect(over.map(isOpen)).toEqual(over.map(() => false));
    expect([...open, ...over].map(canAbort)).toEqual([true, true, true, true, true, true, false, false, false]);
    expect([...open, ...over].map((status) => canApprove({ status }))).toEqual([false, false, false, true, false, false, false, false, false]);
    expect(['Planned', 'Copying', 'Verifying', 'CutoverFrozen'].map((status) => isBusy(status as MigrationStatus))).toEqual([true, true, true, true]);
    expect(['AwaitingCutover', 'Switched', 'Completed', 'Aborted', 'RolledBack'].map((status) => isBusy(status as MigrationStatus))).toEqual([false, false, false, false, false]);
  });

  it('recognises the person who started, whatever the letter case, and nobody when it is not known who is signed in', () => {
    expect(startedByMe({ requestedBy: 'ABC-1' }, 'abc-1')).toBe(true);
    expect(startedByMe({ requestedBy: 'abc-1' }, 'abc-2')).toBe(false);
    expect(startedByMe({ requestedBy: 'abc-1' }, undefined)).toBe(false);
  });

  it('puts a migration on its way: the steps it passed are done, the one it is at is current, a completed one is done throughout, one that ended has no step current', () => {
    const states = (status: MigrationStatus) => STEPS.map((step) => stepState(status, step));
    expect(states('Planned')).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(states('AwaitingCutover')).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo', 'todo']);
    expect(states('Completed')).toEqual(STEPS.map(() => 'done'));
    expect(states('Aborted')).toEqual(STEPS.map(() => 'todo'));
    expect(states('RolledBack')).toEqual(STEPS.map(() => 'todo'));
  });

  it('counts the freeze down only while writes are frozen, never below zero', () => {
    const frozen = { status: 'CutoverFrozen' as const, writeFrozenUntil: '2026-11-03T03:40:00Z' };
    const at = Date.parse('2026-11-03T03:10:00Z');
    expect(freezeRemainingMs(frozen, at)).toBe(30 * 60_000);
    expect(freezeRemainingMs(frozen, at + 31 * 60_000)).toBe(0);
    expect(freezeRemainingMs({ status: 'Switched', writeFrozenUntil: frozen.writeFrozenUntil }, at)).toBeUndefined();
    expect(freezeRemainingMs({ status: 'CutoverFrozen', writeFrozenUntil: undefined }, at)).toBeUndefined();
    expect([clockOf(0), clockOf(59_999), clockOf(60_000), clockOf(30 * 60_000), clockOf(125 * 60_000 + 7_000)]).toEqual(['00:00', '00:59', '01:00', '30:00', '125:07']);
  });

  it('adds the money of every table exactly, column by column, however large the sums', () => {
    const tables = [
      toReconciliation({ tables: [tableRow({ money: [{ column: 'amount_vnd', source: '123456789012345678901234', target: '123456789012345678901234', match: true }] }), tableRow({ table: 'b', money: [{ column: 'amount_vnd', source: '1', target: '2', match: false }, { column: 'budget_vnd', source: '7', target: '7', match: true }] }), tableRow({ table: 'c', money: [] })] })?.tables as TableView[],
    ][0] as TableView[];
    expect(moneyTotals(tables)).toEqual([
      { column: 'amount_vnd', source: '123456789012345678901235', target: '123456789012345678901236' },
      { column: 'budget_vnd', source: '7', target: '7' },
    ]);
    expect(moneyTotals([])).toEqual([]);
  });

  it('lists the tables with data or a difference, and leaves out the empty ones that agree', () => {
    const view = (overrides: Record<string, unknown>) => toReconciliation({ tables: [tableRow(overrides)] })?.tables[0] as TableView;
    expect(isInteresting(view({}))).toBe(true);
    expect(isInteresting(view({ source_rows: 0, target_rows: 0 }))).toBe(false);
    expect(isInteresting(view({ source_rows: 0, target_rows: 3, match: false }))).toBe(true);
    expect(isInteresting(view({ source_rows: 0, target_rows: 0, match: false }))).toBe(true);
    expect(isInteresting(view({ source_rows: 0, target_rows: 2 }))).toBe(true);
  });

  it('judges the form the way the contract does', () => {
    expect([isMinutesValid(4), isMinutesValid(5), isMinutesValid(240), isMinutesValid(241), isMinutesValid(30.5), isMinutesValid(Number.NaN)]).toEqual([false, true, true, false, false, false]);
    expect([isReasonValid('short'), isReasonValid('0123456789'), isReasonValid('x'.repeat(2001)), isReasonValid('   0123456   ')]).toEqual([false, true, false, false]);
    expect([isWindowValid(''), isWindowValid('nope'), isWindowValid('2026-11-04T10:30')]).toEqual([false, false, true]);
  });

  it('names the problem by the code the server answered, with the tables, the reason and the reference', () => {
    expect(describeProblem(problem('SELF_APPROVAL_DENIED'))).toMatchObject({ reason: 'selfApproval', correlationId: 'corr' });
    expect(describeProblem(problem('MIGRATION_VERIFICATION_FAILED', { reason: 'MISMATCH', tables: ['a', 'b', 3] }))).toMatchObject({ reason: 'mismatch', tables: ['a', 'b'] });
    expect(describeProblem(problem('MIGRATION_VERIFICATION_FAILED', { reason: 'NOT_VERIFIED' })).reason).toBe('notVerified');
    expect(describeProblem(problem('MIGRATION_VERIFICATION_FAILED', { reason: 'STALE' })).reason).toBe('stale');
    expect(describeProblem(problem('MIGRATION_VERIFICATION_FAILED')).reason).toBe('mismatch');
    expect(describeProblem(problem('MIGRATION_STATE_INVALID')).reason).toBe('stateInvalid');
    expect(describeProblem(problem('MIGRATION_STATE_INVALID', {}, 'TARGET_CHANGED')).reason).toBe('targetChanged');
    expect(describeProblem(problem('PLACEMENT_UNAVAILABLE', { reason: 'NO_ROOM' }))).toMatchObject({ reason: 'placementUnavailable', why: 'NO_ROOM' });
    expect(describeProblem(problem('MIGRATION_ALREADY_OPEN')).reason).toBe('alreadyOpen');
    expect(describeProblem(problem('TENANT_STATE_INVALID')).reason).toBe('tenantState');
    expect(describeProblem(problem('VERSION_CONFLICT')).reason).toBe('conflict');
    expect(describeProblem(problem('VALIDATION_FAILED', {}, 'reason'))).toMatchObject({ reason: 'invalid', field: 'reason' });
    expect(describeProblem(problem('SCOPE_DENIED')).reason).toBe('denied');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND')).reason).toBe('notFound');
    expect(describeProblem(problem('SESSION_EXPIRED')).reason).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE')).reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined, tables: [], why: undefined, correlationId: undefined });
  });
});
