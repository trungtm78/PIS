import type { HoldKind, HoldScopeKind } from './model';

/**
 * The rules of the forms that place and release a legal hold (ADM-12, `placeLegalHold`, `releaseLegalHold`). A hold is placed on the paper of an authority, and the person who releases it is never the person who placed it (the
 * server refuses `SELF_APPROVAL_DENIED`). The rules repeat those of the server so that the person is told before sending.
 */

export const HOLD_KIND_CHOICES: readonly HoldKind[] = ['INSPECTION', 'AUDIT', 'LITIGATION', 'INVESTIGATION', 'CONTRACT_END'];
export const HOLD_SCOPE_CHOICES: readonly HoldScopeKind[] = ['TENANT', 'UNIT', 'PROJECT', 'CONTRACT', 'RESOURCE'];
export const HOLD_LIMITS = { authority: { min: 5, max: 500 }, reason: { min: 10, max: 2000 }, ids: { max: 200 } } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HoldForm {
  holdKind: HoldKind;
  scopeKind: HoldScopeKind;
  /** Identifiers separated by commas, spaces or lines. */
  ids: string;
  authorityReference: string;
  reason: string;
  /** A `datetime-local` value, or empty for now. */
  effectiveAt: string;
}

export const EMPTY_HOLD: HoldForm = { holdKind: 'INSPECTION', scopeKind: 'PROJECT', ids: '', authorityReference: '', reason: '', effectiveAt: '' };

export type HoldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalid' | 'noIds' | 'idsNotAllowed' | 'tooManyIds';
export type HoldProblems = Partial<Record<'authorityReference' | 'reason' | 'ids' | 'effectiveAt', HoldProblem>>;

export const idsOf = (value: string): string[] => value.split(/[\s,;]+/).filter((part) => part !== '');

export function validateHold(form: HoldForm): HoldProblems {
  const found: HoldProblems = {};
  const authority = form.authorityReference.trim().length;
  if (authority === 0) found.authorityReference = 'required';
  else if (authority < HOLD_LIMITS.authority.min) found.authorityReference = 'tooShort';
  else if (authority > HOLD_LIMITS.authority.max) found.authorityReference = 'tooLong';
  const reason = form.reason.trim().length;
  if (reason === 0) found.reason = 'required';
  else if (reason < HOLD_LIMITS.reason.min) found.reason = 'tooShort';
  else if (reason > HOLD_LIMITS.reason.max) found.reason = 'tooLong';
  const ids = idsOf(form.ids);
  if (form.scopeKind === 'TENANT') {
    if (ids.length > 0) found.ids = 'idsNotAllowed';
  } else if (ids.length === 0) found.ids = 'noIds';
  else if (ids.length > HOLD_LIMITS.ids.max) found.ids = 'tooManyIds';
  else if (!ids.every((id) => UUID.test(id))) found.ids = 'invalid';
  if (form.effectiveAt !== '' && Number.isNaN(new Date(form.effectiveAt).getTime())) found.effectiveAt = 'invalid';
  return found;
}

export const holdHasProblems = (problems: HoldProblems): boolean => Object.values(problems).some((problem) => problem !== undefined);

export function holdBody(form: HoldForm): Record<string, unknown> {
  const ids = [...new Set(idsOf(form.ids).map((id) => id.toLowerCase()))];
  return {
    hold_kind: form.holdKind,
    resource_scope: form.scopeKind === 'TENANT' ? { kind: 'TENANT' } : { kind: form.scopeKind, ids },
    authority_reference: form.authorityReference.trim(),
    reason: form.reason.trim(),
    ...(form.effectiveAt === '' ? {} : { effective_at: new Date(form.effectiveAt).toISOString() }),
  };
}

/** The reason of a release: 10 to 2000 characters. */
export function validateRelease(reason: string): HoldProblem | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'required';
  if (length < HOLD_LIMITS.reason.min) return 'tooShort';
  return length > HOLD_LIMITS.reason.max ? 'tooLong' : undefined;
}
