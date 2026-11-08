import type { Translator } from '../../i18n';
import type { InfoFormulaLabels, Severity, Tone } from '../../ui';
import { rowCodeKey } from './feed-model';
import type { Channel, GeneratorAction, GeneratorBlock, HealthStatus, Kind, MappingStatus, Outcome, PendingItem, PreviewRow, Problem, ResolutionKind, RowStatus } from './feed-model';

type T = Translator['t'];

/** The words of the five screens. Every key is written out in a call of `t`, so the i18n check sees each one in use. */

export function channelLabel(t: T, channel: Channel): string {
  switch (channel) {
    case 'FILE':
      return t('feed.common.channel.file');
    case 'API_PUSH':
      return t('feed.common.channel.apiPush');
    case 'GENERATOR':
      return t('feed.common.channel.generator');
  }
}

export function kindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'PROJECT':
      return t('feed.common.kind.project');
    case 'PLAN':
      return t('feed.common.kind.plan');
    case 'DISBURSEMENT':
      return t('feed.common.kind.disbursement');
    case 'MILESTONE':
      return t('feed.common.kind.milestone');
    default:
      return kind;
  }
}

export function adapterStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'VERIFIED':
      return t('feed.connection.adapter.verified');
    case 'PROPOSED':
      return t('feed.connection.adapter.proposed');
    case 'MOCK':
      return t('feed.connection.adapter.mock');
    case 'MISSING':
      return t('feed.connection.adapter.missing');
    default:
      return status;
  }
}

export const adapterTone = (status: string): Tone => (status === 'VERIFIED' ? 'success' : status === 'MISSING' ? 'warning' : 'info');

/** Why a channel is not available: the reason the server names, in words; any other reason is shown as it came. */
export function channelReasonLabel(t: T, reason: string | null): string | null {
  if (reason === null) return null;
  return reason === 'MACHINE_ACCOUNT_PENDING' ? t('feed.connection.channel.reason.machineAccount') : reason;
}

export function channelNote(t: T, channel: Channel): string {
  switch (channel) {
    case 'FILE':
      return t('feed.connection.channel.note.file');
    case 'API_PUSH':
      return t('feed.connection.channel.note.apiPush');
    case 'GENERATOR':
      return t('feed.connection.channel.note.generator');
  }
}

export function healthLabel(t: T, status: HealthStatus): string {
  switch (status) {
    case 'FRESH':
      return t('feed.connection.health.status.fresh');
    case 'AGING':
      return t('feed.connection.health.status.aging');
    case 'STALE':
      return t('feed.connection.health.status.stale');
    case 'NEVER_RECEIVED':
      return t('feed.connection.health.status.never');
  }
}

export function healthExplain(t: T, status: HealthStatus): string {
  switch (status) {
    case 'FRESH':
      return t('feed.connection.health.explain.fresh');
    case 'AGING':
      return t('feed.connection.health.explain.aging');
    case 'STALE':
      return t('feed.connection.health.explain.stale');
    case 'NEVER_RECEIVED':
      return t('feed.connection.health.explain.never');
  }
}

export function severityLabel(t: T, severity: Severity): string {
  switch (severity) {
    case 'URGENT':
      return t('feed.common.severity.urgent');
    case 'ACTION':
      return t('feed.common.severity.action');
    case 'WATCH':
      return t('feed.common.severity.watch');
  }
}

export function alertLabel(t: T, code: string, subject: string): string {
  switch (code) {
    case 'FEED_STALE':
      return t('feed.connection.alert.stale.text', { subject });
    case 'FEED_UNIT_LATE':
      return t('feed.connection.alert.unitLate.text', { subject });
    case 'FEED_DISCREPANCY_LARGE':
      return t('feed.connection.alert.discrepancy.text', { subject });
    default:
      return t('feed.connection.alert.other.text', { code, subject });
  }
}

export function unitStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'REPORTED_ON_TIME':
      return t('feed.connection.unit.status.onTime');
    case 'REPORTED_LATE':
      return t('feed.connection.unit.status.reportedLate');
    case 'LATE':
      return t('feed.connection.unit.status.late');
    case 'PENDING':
      return t('feed.connection.unit.status.pending');
    default:
      return status;
  }
}

export function findingLabel(t: T, code: string): string {
  switch (code) {
    case 'UNKNOWN_PROJECT':
      return t('feed.connection.finding.unknownProject');
    case 'RESTATED':
      return t('feed.connection.finding.restated');
    case 'CUMULATIVE_MISMATCH':
      return t('feed.connection.finding.cumulative');
    case 'OVER_PLAN':
      return t('feed.connection.finding.overPlan');
    default:
      return code;
  }
}

export function cursorLabel(t: T, status: string | null): string {
  switch (status) {
    case null:
      return t('feed.connection.cursor.never');
    case 'ACTIVE':
      return t('feed.connection.cursor.active');
    case 'FAILED':
      return t('feed.connection.cursor.failed');
    default:
      return status;
  }
}

export function columnKindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'code':
      return t('feed.connection.columnKind.code');
    case 'text':
      return t('feed.connection.columnKind.text');
    case 'enum':
      return t('feed.connection.columnKind.enum');
    case 'money':
      return t('feed.connection.columnKind.money');
    case 'day':
      return t('feed.connection.columnKind.day');
    case 'integer':
      return t('feed.connection.columnKind.integer');
    default:
      return kind;
  }
}

export function historyActionLabel(t: T, action: string): string {
  switch (action) {
    case 'CREATED':
      return t('feed.connection.history.action.created');
    case 'ENABLED':
      return t('feed.connection.history.action.enabled');
    case 'DISABLED':
      return t('feed.connection.history.action.disabled');
    case 'GENERATOR_STARTED':
      return t('feed.connection.history.action.generatorStarted');
    case 'GENERATOR_STOPPED':
      return t('feed.connection.history.action.generatorStopped');
    case 'GENERATOR_RESEEDED':
      return t('feed.connection.history.action.generatorReseeded');
    case 'GENERATOR_TICKED':
      return t('feed.connection.history.action.generatorTicked');
    default:
      return action;
  }
}

/** What a pending external item says, in the words of the screen: a sample is the layout the connection runs on, named by `layoutVersion`; any other item keeps the words of the server. */
export function pendingWords(t: T, item: PendingItem, layoutVersion: string): { what: string; owner: string; assumption: string; switches: string } {
  const sample = item.code.startsWith('FEED_SAMPLE_') ? item.code.slice('FEED_SAMPLE_'.length) : null;
  if (sample !== null) {
    return {
      what: t('feed.connection.pending.what.sample', { kind: kindLabel(t, sample) }),
      owner: t('feed.connection.pending.owner.finance'),
      assumption: t('feed.connection.pending.assumption.layout', { kind: sample, version: layoutVersion }),
      switches: t('feed.connection.pending.switches.layout'),
    };
  }
  switch (item.code) {
    case 'FEED_API_SPECIFICATION':
      return { what: t('feed.connection.pending.what.api'), owner: t('feed.connection.pending.owner.finance'), assumption: t('feed.connection.pending.assumption.api'), switches: t('feed.connection.pending.switches.api') };
    case 'FEED_MACHINE_ACCOUNT':
      return { what: t('feed.connection.pending.what.account'), owner: t('feed.connection.pending.owner.integration'), assumption: t('feed.connection.pending.assumption.account'), switches: t('feed.connection.pending.switches.account') };
    case 'FEED_LEGAL_THRESHOLDS':
      return { what: t('feed.connection.pending.what.thresholds'), owner: t('feed.connection.pending.owner.customer'), assumption: t('feed.connection.pending.assumption.thresholds'), switches: t('feed.connection.pending.switches.thresholds') };
    default:
      return { what: item.what, owner: item.owner, assumption: item.workingAssumption, switches: item.switchesWhenItArrives };
  }
}

// ---- runs and files ---------------------------------------------------------------------------------------------------------------------------------------------------

export function runActionLabel(t: T, action: string): string {
  switch (action) {
    case 'APPLY':
      return t('feed.runs.action.apply');
    case 'GENERATOR_START':
      return t('feed.runs.action.generatorStart');
    case 'GENERATOR_RESEED':
      return t('feed.runs.action.generatorReseed');
    case 'GENERATOR_TICK':
      return t('feed.runs.action.generatorTick');
    default:
      return action;
  }
}

export function rowStatusLabel(t: T, status: RowStatus): string {
  switch (status) {
    case 'VALID':
      return t('feed.runs.row.status.valid');
    case 'ERROR':
      return t('feed.runs.row.status.error');
    case 'DUPLICATE':
      return t('feed.runs.row.status.duplicate');
    case 'CONFLICT':
      return t('feed.runs.row.status.conflict');
  }
}

export const rowStatusTone = (status: RowStatus): Tone => (status === 'VALID' ? 'success' : status === 'ERROR' ? 'danger' : status === 'CONFLICT' ? 'warning' : 'neutral');

/** The reason of a row, from the code the server wrote; a code the screen has no sentence for is shown as it is. */
export function rowCodeLabel(t: T, code: string | null): string {
  switch (rowCodeKey(code)) {
    case 'fieldRequired':
      return t('feed.runs.code.fieldRequired');
    case 'fieldTooLong':
      return t('feed.runs.code.fieldTooLong');
    case 'characterInvalid':
      return t('feed.runs.code.characterInvalid');
    case 'enumInvalid':
      return t('feed.runs.code.enumInvalid');
    case 'dayInvalid':
      return t('feed.runs.code.dayInvalid');
    case 'moneyInvalid':
      return t('feed.runs.code.moneyInvalid');
    case 'monthInvalid':
      return t('feed.runs.code.monthInvalid');
    case 'yearInvalid':
      return t('feed.runs.code.yearInvalid');
    case 'yearsOrderInvalid':
      return t('feed.runs.code.yearsOrderInvalid');
    case 'taxCodeInvalid':
      return t('feed.runs.code.taxCodeInvalid');
    case 'milestoneDateRequired':
      return t('feed.runs.code.milestoneDateRequired');
    case 'rowInvalid':
      return t('feed.runs.code.rowInvalid');
    case 'rowDuplicate':
      return t('feed.runs.code.rowDuplicate');
    case 'rowConflict':
      return t('feed.runs.code.rowConflict');
    default:
      return code === null ? t('feed.runs.code.none') : t('feed.runs.code.other', { code });
  }
}

export function previewCodeLabel(t: T, row: PreviewRow): string | null {
  const code = row.code ?? (row.status === 'DUPLICATE' ? 'ROW_DUPLICATE' : row.status === 'CONFLICT' ? 'ROW_CONFLICT' : null);
  return code === null ? null : rowCodeLabel(t, code);
}

export function outcomeLabel(t: T, outcome: Outcome | null): string {
  switch (outcome) {
    case 'RECORD':
      return t('feed.runs.outcome.record');
    case 'RECORD_AND_PROPOSE':
      return t('feed.runs.outcome.recordPropose');
    case 'RECORD_AND_DIFFERENCE':
      return t('feed.runs.outcome.recordDifference');
    case null:
      return t('feed.runs.outcome.none');
  }
}

export function applyBlockLabel(t: T, block: string): string {
  switch (block) {
    case 'noPreview':
      return t('feed.runs.block.noPreview');
    case 'noValid':
      return t('feed.runs.block.noValid');
    case 'alreadyApplied':
      return t('feed.runs.block.alreadyApplied');
    case 'connectionDisabled':
      return t('feed.runs.block.connectionDisabled');
    case 'noAuthority':
      return t('feed.runs.block.noAuthority');
    case 'done':
      return t('feed.runs.block.done');
    default:
      return t('feed.runs.block.working');
  }
}

export function fitMessage(t: T, fit: 'other' | 'none', params: { kinds: string; chosen: string }): string {
  return fit === 'none' ? t('feed.runs.fit.none', params) : t('feed.runs.fit.other', params);
}

export function needLabel(t: T, required: boolean): string {
  return required ? t('feed.runs.columns.required') : t('feed.runs.columns.optional');
}

// ---- mapping ----------------------------------------------------------------------------------------------------------------------------------------------------------

export function mappingStatusLabel(t: T, status: MappingStatus): string {
  switch (status) {
    case 'PROPOSED':
      return t('feed.mapping.status.proposed');
    case 'ACTIVE':
      return t('feed.mapping.status.active');
    case 'REJECTED':
      return t('feed.mapping.status.rejected');
    case 'RETIRED':
      return t('feed.mapping.status.retired');
  }
}

export const MAPPING_TONE: Readonly<Record<MappingStatus, Tone>> = { PROPOSED: 'info', ACTIVE: 'success', REJECTED: 'danger', RETIRED: 'neutral' };
export const MAPPING_ICON: Readonly<Record<MappingStatus, string>> = { PROPOSED: '◔', ACTIVE: '✓', REJECTED: '✕', RETIRED: '○' };

export function methodLabel(t: T, method: string): string {
  switch (method) {
    case 'MANUAL':
      return t('feed.mapping.method.manual');
    case 'EXACT_CODE':
      return t('feed.mapping.method.exactCode');
    default:
      return method;
  }
}

export function issueLabel(t: T, issue: 'required' | 'tooLong' | 'invalid' | 'order'): string {
  switch (issue) {
    case 'required':
      return t('feed.mapping.issue.required');
    case 'tooLong':
      return t('feed.mapping.issue.tooLong');
    case 'invalid':
      return t('feed.mapping.issue.invalid');
    case 'order':
      return t('feed.mapping.issue.order');
  }
}

// ---- differences ------------------------------------------------------------------------------------------------------------------------------------------------------

export function differenceFieldLabel(t: T, field: string): string {
  switch (field) {
    case 'PLAN_VS_DIS':
      return t('feed.diff.field.planVsDis');
    case 'DISBURSED_VS_DIS':
      return t('feed.diff.field.disbursedVsDis');
    case 'DISBURSED_VS_TREASURY':
      return t('feed.diff.field.disbursedVsTreasury');
    default:
      return field;
  }
}

export function resolutionLabel(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'ACCEPT_FEED':
      return t('feed.diff.resolution.acceptFeed');
    case 'KEEP_OURS':
      return t('feed.diff.resolution.keepOurs');
    case 'DISPUTE':
      return t('feed.diff.resolution.dispute');
    case 'WAIVE':
      return t('feed.diff.resolution.waive');
  }
}

export function resolutionEffect(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'ACCEPT_FEED':
      return t('feed.diff.effect.acceptFeed');
    case 'KEEP_OURS':
      return t('feed.diff.effect.keepOurs');
    case 'DISPUTE':
      return t('feed.diff.effect.dispute');
    case 'WAIVE':
      return t('feed.diff.effect.waive');
  }
}

export function resolutionIssueLabel(t: T, issue: 'required' | 'short' | 'long' | 'invalid' | 'past' | 'far', min: number): string {
  switch (issue) {
    case 'required':
      return t('feed.diff.issue.required');
    case 'short':
      return t('feed.diff.issue.short', { count: min });
    case 'long':
      return t('feed.diff.issue.long');
    case 'invalid':
      return t('feed.diff.issue.invalid');
    case 'past':
      return t('feed.diff.issue.past');
    case 'far':
      return t('feed.diff.issue.far');
  }
}

export function reconcileIssueLabel(t: T, issue: 'required' | 'range' | 'invalid'): string {
  switch (issue) {
    case 'required':
      return t('feed.diff.reconcile.issue.required');
    case 'range':
      return t('feed.diff.reconcile.issue.range');
    case 'invalid':
      return t('feed.diff.reconcile.issue.invalid');
  }
}

// ---- generator --------------------------------------------------------------------------------------------------------------------------------------------------------

export function generatorActionLabel(t: T, action: GeneratorAction): string {
  switch (action) {
    case 'START':
      return t('feed.generator.action.start');
    case 'STOP':
      return t('feed.generator.action.stop');
    case 'RESEED':
      return t('feed.generator.action.reseed');
    case 'TICK':
      return t('feed.generator.action.tick');
  }
}

export function generatorEffect(t: T, action: GeneratorAction): string {
  switch (action) {
    case 'START':
      return t('feed.generator.effect.start');
    case 'STOP':
      return t('feed.generator.effect.stop');
    case 'RESEED':
      return t('feed.generator.effect.reseed');
    case 'TICK':
      return t('feed.generator.effect.tick');
  }
}

export function generatorBlockLabel(t: T, block: Exclude<GeneratorBlock, null>): string {
  switch (block) {
    case 'connection':
      return t('feed.generator.block.connection');
    case 'running':
      return t('feed.generator.block.running');
    case 'stopped':
      return t('feed.generator.block.stopped');
    case 'yearComplete':
      return t('feed.generator.block.yearComplete');
    case 'neverStarted':
      return t('feed.generator.block.neverStarted');
  }
}

export function generatorIssueLabel(t: T, issue: 'required' | 'integer' | 'range' | 'share', range: readonly [number, number]): string {
  switch (issue) {
    case 'required':
      return t('feed.generator.issue.required');
    case 'integer':
      return t('feed.generator.issue.integer');
    case 'range':
      return t('feed.generator.issue.range', { min: range[0], max: range[1] });
    case 'share':
      return t('feed.generator.issue.share');
  }
}

export function generatorStateRefusal(t: T, detail: string | undefined): string {
  switch (detail) {
    case 'connection':
      return t('feed.generator.refusal.connection');
    case 'year_complete':
      return t('feed.generator.refusal.yearComplete');
    default:
      return t('feed.generator.refusal.state');
  }
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The sentence for a refusal of any command of the five screens; a refusal the screen has no sentence for says so in general words. */
export function problemText(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'alreadyApplied':
      return t('feed.common.problem.alreadyApplied');
    case 'connectionDisabled':
      return t('feed.common.problem.connectionDisabled');
    case 'hasErrors':
      return t('feed.common.problem.hasErrors');
    case 'hashMismatch':
      return t('feed.common.problem.hashMismatch');
    case 'schemaInvalid':
      return problem.missingColumns.length > 0 ? t('feed.common.problem.schemaColumns', { columns: problem.missingColumns.join(', ') }) : t('feed.common.problem.schemaInvalid');
    case 'empty':
      return t('feed.common.problem.empty');
    case 'layoutUnknown':
      return t('feed.common.problem.layoutUnknown', { version: problem.layoutVersion, supported: problem.supported.join(', ') });
    case 'fileRefused':
      return t('feed.common.problem.fileRefused');
    case 'tooLarge':
      return t('feed.common.problem.tooLarge');
    case 'scanPending':
      return t('feed.common.problem.scanPending');
    case 'validation':
      return problem.field === undefined ? t('feed.common.problem.validationBare') : t('feed.common.problem.validation', { field: problem.field });
    case 'notFound':
      return t('feed.common.problem.notFound');
    case 'scopeDenied':
      return t('feed.common.problem.scopeDenied');
    case 'selfApproval':
      return t('feed.common.problem.selfApproval');
    case 'versionConflict':
      return t('feed.common.problem.versionConflict');
    case 'mappingState':
      return t('feed.common.problem.mappingState');
    case 'differenceState':
      return t('feed.common.problem.differenceState');
    case 'generatorState':
      return generatorStateRefusal(t, problem.detail);
    case 'duplicate':
      return t('feed.common.problem.duplicate');
    case 'apiUnavailable':
      return t('feed.common.problem.apiUnavailable');
    case 'forbidden':
      return t('feed.common.problem.forbidden');
    case 'general':
      return t('feed.common.problem.general');
  }
}

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('feed.common.info.open.label', { name }),
    close: t('feed.common.info.close.label'),
    formula: t('feed.common.info.formula.label'),
    numerator: t('feed.common.info.numerator.label'),
    denominator: t('feed.common.info.denominator.label'),
    exclusions: t('feed.common.info.exclusions.label'),
    source: t('feed.common.info.source.label'),
    asOf: t('feed.common.info.asOf.label'),
    owner: t('feed.common.info.owner.label'),
    version: t('feed.common.info.version.label'),
    unverified: t('feed.common.info.unverified.text'),
  };
}
