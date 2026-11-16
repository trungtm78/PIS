import { isPending, paramsOfTemplate, pending, readTemplate, stepsOf } from './template-model';
import type { ApplyChange } from './assignment-model';
import type { Template } from './template-model';

/**
 * The local draft of the editor (R70): what a person is writing is kept on the device so that a reload does not lose it. It is kept per tenant, person, template code and the version the editing started from. When
 * the version it started from is no longer the one the screen opens (somebody approved a newer one meanwhile), the draft is never merged: the person is asked to keep it (on the new base) or to drop it. Every draft
 * of the device is removed at sign-out. It is a convenience of one browser: the draft of record is the one the rule store holds after "Lưu nháp".
 */

export const DRAFT_PREFIX = 'pwf.tpl.draft:';
/** The code slot of a template that has no code yet. */
export const NEW_TEMPLATE = '~new';

export interface DraftScope {
  tenantId: string;
  membershipId: string;
  /** The code of the template, or `NEW_TEMPLATE`. */
  code: string;
}

/** The pending "Áp cho" changes travel with the draft (they are submitted together with the template, R60). */
export type DraftApply = ApplyChange;

export interface LocalDraft {
  /** The version the editing started from (`v3`, `default`, `blank`). */
  base: string;
  savedAt: string;
  params: unknown;
  /** The rows that have no name yet: their codes are provisional and are still to be made from their names. */
  pending: { phases: string[]; steps: string[]; tasks: string[] };
  apply?: DraftApply;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const scopeKey = (scope: DraftScope): string => `${DRAFT_PREFIX}${scope.tenantId}:${scope.membershipId}:${scope.code}:`;
export const draftKey = (scope: DraftScope, base: string): string => `${scopeKey(scope)}${base}`;

const keysOf = (storage: Store, prefix: string): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
};

const parse = (text: string | null): LocalDraft | undefined => {
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as Partial<LocalDraft> | null;
    if (value === null || typeof value !== 'object' || typeof value.base !== 'string' || typeof value.savedAt !== 'string' || typeof value.params !== 'object' || value.params === null) return undefined;
    const marks = value.pending ?? { phases: [], steps: [], tasks: [] };
    return { base: value.base, savedAt: value.savedAt, params: value.params, pending: { phases: [...(marks.phases ?? [])], steps: [...(marks.steps ?? [])], tasks: [...(marks.tasks ?? [])] }, ...(value.apply === undefined ? {} : { apply: value.apply }) };
  } catch {
    return undefined;
  }
};

export function draftOfTemplate(template: Template, base: string, now: Date, apply?: DraftApply): LocalDraft {
  return {
    base,
    savedAt: now.toISOString(),
    params: paramsOfTemplate(template),
    pending: { phases: template.phases.filter(isPending).map((one) => one.code), steps: stepsOf(template).filter(isPending).map((one) => one.code), tasks: template.tasks.filter(isPending).map((one) => one.code) },
    ...(apply === undefined || (apply.added.length === 0 && apply.removed.length === 0) ? {} : { apply }),
  };
}

/** The template a local draft holds, with the rows that still wait for their code marked again. */
export function templateOfDraft(draft: LocalDraft): Template {
  const template = readTemplate(draft.params);
  const mark = <E extends { code: string }>(list: readonly E[], codes: readonly string[]): E[] => list.map((one) => (codes.includes(one.code) ? pending(one) : one));
  return { ...template, phases: mark(template.phases, draft.pending.phases), ...(template.steps === undefined ? {} : { steps: mark(template.steps, draft.pending.steps) }), tasks: mark(template.tasks, draft.pending.tasks) };
}

/** Writes the draft; a draft of the same template on another base is replaced (one draft a template and a person). A store that is full or closed loses the convenience, never the screen. */
export function saveLocalDraft(storage: Store | undefined, scope: DraftScope, draft: LocalDraft): boolean {
  if (storage === undefined) return false;
  try {
    for (const key of keysOf(storage, scopeKey(scope))) if (key !== draftKey(scope, draft.base)) storage.removeItem(key);
    storage.setItem(draftKey(scope, draft.base), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export type FoundDraft = { state: 'none' } | { state: 'same'; draft: LocalDraft } | { state: 'conflict'; draft: LocalDraft };

/** The draft of this template and person: on the base the screen opened (`same`), on another base (`conflict`: the person decides, nothing is merged), or none. */
export function findLocalDraft(storage: Store | undefined, scope: DraftScope, base: string): FoundDraft {
  if (storage === undefined) return { state: 'none' };
  try {
    const same = parse(storage.getItem(draftKey(scope, base)));
    if (same !== undefined) return { state: 'same', draft: same };
    for (const key of keysOf(storage, scopeKey(scope))) {
      const other = parse(storage.getItem(key));
      if (other !== undefined) return { state: 'conflict', draft: other };
    }
  } catch {
    // A store that cannot be read holds no draft.
  }
  return { state: 'none' };
}

export function dropLocalDraft(storage: Store | undefined, scope: DraftScope): void {
  if (storage === undefined) return;
  try {
    for (const key of keysOf(storage, scopeKey(scope))) storage.removeItem(key);
  } catch {
    // Nothing to drop in a store that is closed.
  }
}

/** Every local draft of the device, of every person and tenant: what sign-out removes. */
export function clearLocalDrafts(storage: Store | undefined): number {
  if (storage === undefined) return 0;
  try {
    const keys = keysOf(storage, DRAFT_PREFIX);
    for (const key of keys) storage.removeItem(key);
    return keys.length;
  } catch {
    return 0;
  }
}

/** The local store of the browser, or undefined where there is none (a private window that refuses it, a test without a DOM). */
export function browserDraftStore(): Store | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
