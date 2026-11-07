import type { Tone } from '../../../ui';
import type { LegalStatus, Move, MoveBlock, Problem, Refusal, RulePhase, RuleStatus, UnitKind } from './model';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

// Every key is written out so that the i18n check can see it is in use.

export function statusText(t: Translate, status: RuleStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('gova1.status.draft');
    case 'SUBMITTED':
      return t('gova1.status.submitted');
    case 'APPROVED':
      return t('gova1.status.approved');
    case 'RETIRED':
      return t('gova1.status.retired');
  }
}

export function phaseText(t: Translate, phase: RulePhase): string {
  switch (phase) {
    case 'DRAFT':
      return t('gova1.phase.draft');
    case 'SUBMITTED':
      return t('gova1.phase.submitted');
    case 'NEVER_IN_FORCE':
      return t('gova1.phase.neverInForce');
    case 'SCHEDULED':
      return t('gova1.phase.scheduled');
    case 'IN_FORCE':
      return t('gova1.phase.inForce');
    case 'ENDED':
      return t('gova1.phase.ended');
  }
}

/** The tone and the glyph of a version: the word is always written, the glyph is a second cue and the tone a third. */
export function phaseLook(phase: RulePhase): { tone: Tone; icon: string } {
  switch (phase) {
    case 'DRAFT':
      return { tone: 'neutral', icon: '✎' };
    case 'SUBMITTED':
      return { tone: 'info', icon: '➤' };
    case 'SCHEDULED':
      return { tone: 'warning', icon: '◷' };
    case 'IN_FORCE':
      return { tone: 'success', icon: '✔' };
    case 'ENDED':
    case 'NEVER_IN_FORCE':
      return { tone: 'neutral', icon: '■' };
  }
}

export const legalText = (t: Translate, status: LegalStatus): string => (status === 'UNVERIFIED' ? t('gova1.legal.unverified') : t('gova1.legal.verified'));

export function unitText(t: Translate, unit: UnitKind): string {
  switch (unit) {
    case 'VND':
      return t('gova1.unit.vnd');
    case 'PCT':
      return t('gova1.unit.pct');
    case 'HOURS':
      return t('gova1.unit.hours');
    case 'DAYS':
      return t('gova1.unit.days');
  }
}

export function moveText(t: Translate, move: Move, status?: RuleStatus): string {
  switch (move) {
    case 'submit':
      return t('gova1.move.submit');
    case 'withdraw':
      return t('gova1.move.withdraw');
    case 'approve':
      return t('gova1.move.approve');
    case 'retire':
      return status === 'DRAFT' ? t('gova1.move.discardDraft') : status === 'SUBMITTED' ? t('gova1.move.discardSubmitted') : t('gova1.move.retire');
  }
}

export function moveTitle(t: Translate, move: Move, status: RuleStatus, params: { version: number; code: string }): string {
  switch (move) {
    case 'submit':
      return t('gova1.dialog.submit.title', params);
    case 'withdraw':
      return t('gova1.dialog.withdraw.title', params);
    case 'approve':
      return t('gova1.dialog.approve.title', params);
    case 'retire':
      return status === 'APPROVED' ? t('gova1.dialog.retire.title', params) : t('gova1.dialog.discard.title', params);
  }
}

/** The rule of the move said before it is made (the maker, the submitter and the approver are three people). */
export function moveRule(t: Translate, move: Move): string {
  switch (move) {
    case 'submit':
      return t('gova1.dialog.rule.submit');
    case 'withdraw':
      return t('gova1.dialog.rule.withdraw');
    case 'approve':
      return t('gova1.dialog.rule.approve');
    case 'retire':
      return t('gova1.dialog.rule.retire');
  }
}

export function reasonLabel(t: Translate, move: Move): string {
  switch (move) {
    case 'submit':
      return t('gova1.dialog.reason.submit');
    case 'withdraw':
      return t('gova1.dialog.reason.withdraw');
    case 'approve':
      return t('gova1.dialog.reason.approve');
    case 'retire':
      return t('gova1.dialog.reason.retire');
  }
}

export function receiptText(t: Translate, move: Move, params: { version: number; code: string; time: string }): string {
  switch (move) {
    case 'submit':
      return t('gova1.receipt.submit', params);
    case 'withdraw':
      return t('gova1.receipt.withdraw', params);
    case 'approve':
      return t('gova1.receipt.approve', params);
    case 'retire':
      return t('gova1.receipt.retire', params);
  }
}

export function blockText(t: Translate, block: MoveBlock): string {
  switch (block) {
    case 'selfApproval':
      return t('gova1.block.selfApproval');
    case 'needsBoth':
      return t('gova1.block.needsBoth');
    case 'startPassed':
      return t('gova1.block.startPassed');
  }
}

/** What a refusal of the server says to the person, with the way out. */
export function refusalText(t: Translate, refusal: Refusal): string {
  switch (refusal.kind) {
    case 'selfApproval':
      return t('gova1.refusal.selfApproval');
    case 'state':
      return t('gova1.refusal.state');
    case 'overlap':
      return t('gova1.refusal.overlap');
    case 'params':
      return refusal.path === undefined ? t('gova1.refusal.paramsAnywhere') : t('gova1.refusal.params', { path: refusal.path });
    case 'conflict':
      return t('gova1.refusal.conflict');
    case 'notFound':
      return t('gova1.refusal.notFound');
    case 'denied':
      return t('gova1.refusal.denied');
    case 'validation':
      return refusal.field === undefined ? t('gova1.refusal.validation') : t('gova1.refusal.validationField', { field: refusal.field });
    case 'session':
      return t('gova1.refusal.session');
    case 'general':
      return t('gova1.refusal.general');
  }
}

export function problemText(t: Translate, problem: Problem): string {
  const min = problem.min ?? 0;
  const max = problem.max ?? 0;
  switch (problem.code) {
    case 'required':
      return t('gova1.problem.required');
    case 'integer':
      return t('gova1.problem.integer');
    case 'number':
      return t('gova1.problem.number');
    case 'range':
      return t('gova1.problem.range', { min, max });
    case 'length':
      return t('gova1.problem.length', { max });
    case 'trim':
      return t('gova1.problem.trim');
    case 'pattern':
      return t('gova1.problem.pattern');
    case 'choice':
      return t('gova1.problem.choice');
    case 'date':
      return t('gova1.problem.date');
    case 'time':
      return t('gova1.problem.time');
    case 'listSize':
      return t('gova1.problem.listSize', { min, max });
    case 'watchOnly':
      return t('gova1.problem.watchOnly');
    case 'server':
      return t('gova1.problem.server');
  }
}

export function severityText(t: Translate, severity: 'URGENT' | 'ACTION' | 'WATCH'): string {
  switch (severity) {
    case 'URGENT':
      return t('gova1.severity.urgent');
    case 'ACTION':
      return t('gova1.severity.action');
    case 'WATCH':
      return t('gova1.severity.watch');
  }
}

/** The name of a field of an alert type (the other rule types show the name the schema gives, which is exact). */
export function alertFieldText(t: Translate, name: string): string | undefined {
  switch (name) {
    case 'source':
      return t('gova1.field.source');
    case 'owner':
      return t('gova1.field.owner');
    case 'expected_action':
      return t('gova1.field.expectedAction');
    case 'consequence':
      return t('gova1.field.consequence');
    case 'response_hours':
      return t('gova1.field.responseHours');
    case 'default_severity':
      return t('gova1.field.defaultSeverity');
    case 'reason_to_exist':
      return t('gova1.field.reasonToExist');
    case 'review_on':
      return t('gova1.field.reviewOn');
    case 'enabled':
      return t('gova1.field.enabled');
    default:
      return undefined;
  }
}
