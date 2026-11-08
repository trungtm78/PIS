import type { Translator } from '../../../i18n';
import type { Severity } from '../../../ui';
import { failureCode, failureDetail, failureStatus, sampleKind } from './connection-model';
import type { HealthStatus, ImportRun, PendingItem } from './connection-model';

type T = Translator['t'];

export function healthLabel(t: T, status: HealthStatus): string {
  switch (status) {
    case 'FRESH':
      return t('egp.connection.freshness.state.fresh');
    case 'AGING':
      return t('egp.connection.freshness.state.aging');
    case 'STALE':
      return t('egp.connection.freshness.state.stale');
    case 'NEVER_IMPORTED':
      return t('egp.connection.freshness.state.never');
  }
}

export function healthExplain(t: T, status: HealthStatus): string {
  switch (status) {
    case 'FRESH':
      return t('egp.connection.freshness.explain.fresh');
    case 'AGING':
      return t('egp.connection.freshness.explain.aging');
    case 'STALE':
      return t('egp.connection.freshness.explain.stale');
    case 'NEVER_IMPORTED':
      return t('egp.connection.freshness.explain.never');
  }
}

export function severityLabel(t: T, severity: Severity): string {
  switch (severity) {
    case 'URGENT':
      return t('egp.connection.severity.urgent.name');
    case 'ACTION':
      return t('egp.connection.severity.action.name');
    case 'WATCH':
      return t('egp.connection.severity.watch.name');
  }
}

/** The name of a kind of file; a kind this screen does not know is shown as the server wrote it. */
export function kindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'KHLCNT':
      return t('egp.connection.kind.khlcnt.name');
    case 'TBMT':
      return t('egp.connection.kind.tbmt.name');
    case 'RESULT':
      return t('egp.connection.kind.result.name');
    case 'CONTRACTOR':
      return t('egp.connection.kind.contractor.name');
    case 'RESTRICTION':
      return t('egp.connection.kind.restriction.name');
    default:
      return kind;
  }
}

export function cursorLabel(t: T, status: string | null): string {
  switch (status) {
    case 'ACTIVE':
      return t('egp.connection.cursor.active.name');
    case 'PAUSED':
      return t('egp.connection.cursor.paused.name');
    case 'FAILED':
      return t('egp.connection.cursor.failed.name');
    case null:
      return t('egp.connection.cursor.none.name');
    default:
      return status;
  }
}

export function columnKindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'code':
      return t('egp.connection.colkind.code.name');
    case 'text':
      return t('egp.connection.colkind.text.name');
    case 'day':
      return t('egp.connection.colkind.day.name');
    case 'moment':
      return t('egp.connection.colkind.moment.name');
    case 'money':
      return t('egp.connection.colkind.money.name');
    case 'int':
      return t('egp.connection.colkind.int.name');
    case 'enum':
      return t('egp.connection.colkind.enum.name');
    case 'taxCode':
      return t('egp.connection.colkind.taxCode.name');
    default:
      return kind;
  }
}

export function runStatusLabel(t: T, status: ImportRun['status']): string {
  switch (status) {
    case 'IMPORTING':
      return t('egp.connection.runs.importing.name');
    case 'APPLIED':
      return t('egp.connection.runs.applied.name');
    case 'FAILED':
      return t('egp.connection.runs.failed.name');
  }
}

export function historyActionLabel(t: T, action: string): string {
  switch (action) {
    case 'CREATED':
      return t('egp.connection.history.created.name');
    case 'ENABLED':
      return t('egp.connection.history.enabled.name');
    case 'DISABLED':
      return t('egp.connection.history.disabled.name');
    default:
      return action;
  }
}

export function mappingLabel(t: T, status: 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'RETIRED'): string {
  switch (status) {
    case 'PROPOSED':
      return t('egp.connection.counts.mapping.proposed');
    case 'ACTIVE':
      return t('egp.connection.counts.mapping.active');
    case 'REJECTED':
      return t('egp.connection.counts.mapping.rejected');
    case 'RETIRED':
      return t('egp.connection.counts.mapping.retired');
  }
}

/**
 * What a pending item says, in the words of the screen: the eight items the server knows are written in our language, an item it adds later falls back to the words the server sent. The working assumption of
 * a sample is the layout the connection runs on, named by `layoutVersion`.
 */
export function pendingWords(t: T, item: PendingItem, layoutVersion: string): { what: string; owner: string; assumption: string; switches: string } {
  const sample = sampleKind(item.code);
  if (sample !== null) {
    return {
      what: t('egp.connection.pending.what.sample', { kind: kindLabel(t, sample) }),
      owner: t('egp.connection.pending.owner.operator'),
      assumption: t('egp.connection.pending.assumption.layout', { kind: sample, version: layoutVersion }),
      switches: t('egp.connection.pending.switches.layout'),
    };
  }
  switch (item.code) {
    case 'API_SPECIFICATION':
      return { what: t('egp.connection.pending.what.api'), owner: t('egp.connection.pending.owner.operator'), assumption: t('egp.connection.pending.assumption.api'), switches: t('egp.connection.pending.switches.api') };
    case 'POSTING_RECEIPT_FORMAT':
      return { what: t('egp.connection.pending.what.receipt'), owner: t('egp.connection.pending.owner.operator'), assumption: t('egp.connection.pending.assumption.receipt'), switches: t('egp.connection.pending.switches.receipt') };
    case 'LEGAL_TEXT_DEADLINES':
      return { what: t('egp.connection.pending.what.legal'), owner: t('egp.connection.pending.owner.legal'), assumption: t('egp.connection.pending.assumption.legal'), switches: t('egp.connection.pending.switches.legal') };
    default:
      return { what: item.what, owner: item.owner, assumption: item.working_assumption, switches: item.switches_when_it_arrives };
  }
}

/** Why a switch was refused, said in place: a changed version asks for a reload, a bad field names itself, a refusal of the right says so. */
export function errorText(t: T, error: unknown): string {
  const code = failureCode(error);
  if (code === 'VERSION_CONFLICT') return t('egp.connection.error.conflict.text');
  if (code === 'VALIDATION_FAILED') {
    const detail = failureDetail(error);
    return detail === undefined ? t('egp.connection.error.validationBare.text') : t('egp.connection.error.validation.text', { detail });
  }
  if (failureStatus(error) === 403) return t('egp.connection.error.forbidden.text');
  return t('egp.connection.error.unknown.text');
}
