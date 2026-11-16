import { describe, expect, it } from 'vitest';
import { DRAFT_PREFIX, NEW_TEMPLATE, clearLocalDrafts, draftKey, draftOfTemplate, dropLocalDraft, findLocalDraft, saveLocalDraft, templateOfDraft } from './draft-store';
import type { DraftScope } from './draft-store';
import { addNamedPhase, addRow, linesOf, nameLine, settleCodes } from './table-model';
import { blankTemplate, isPending, paramsOfTemplate } from './template-model';
import type { Template } from './template-model';

/** A store like the browser's, in memory. */
function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
}

const SCOPE: DraftScope = { tenantId: 'tenant-a', membershipId: 'member-1', code: 'CB_ROAD_REPAIR' };
const NOW = new Date('2026-11-16T03:00:00.000Z');

function template(): Template {
  const base = addNamedPhase({ ...blankTemplate(), name: 'Sửa chữa đường' }, 'Chuẩn bị');
  const one = addRow(base, 'CHUAN_BI');
  if (one === undefined) throw new Error('no row');
  const named = settleCodes(nameLine(one.template, linesOf(one.template)[0] as never, 'Khảo sát'));
  const two = addRow(named, 'CHUAN_BI');
  if (two === undefined) throw new Error('no row');
  return two.template;
}

describe('the local draft of the editor (R70)', () => {
  it('is kept by tenant, person, template code and the version it started from', () => {
    expect(draftKey(SCOPE, 'v2')).toBe(`${DRAFT_PREFIX}tenant-a:member-1:CB_ROAD_REPAIR:v2`);
    const store = memory();
    expect(saveLocalDraft(store, SCOPE, draftOfTemplate(template(), 'v2', NOW))).toBe(true);
    expect(findLocalDraft(store, SCOPE, 'v2').state).toBe('same');
    // Another person, another tenant and another template see nothing of it.
    expect(findLocalDraft(store, { ...SCOPE, membershipId: 'member-2' }, 'v2')).toEqual({ state: 'none' });
    expect(findLocalDraft(store, { ...SCOPE, tenantId: 'tenant-b' }, 'v2')).toEqual({ state: 'none' });
    expect(findLocalDraft(store, { ...SCOPE, code: NEW_TEMPLATE }, 'blank')).toEqual({ state: 'none' });
  });

  it('gives back the template as it was, the rows that still wait for a name marked so that their code is still made from it', () => {
    const store = memory();
    const written = template();
    saveLocalDraft(store, SCOPE, draftOfTemplate(written, 'v2', NOW));
    const found = findLocalDraft(store, SCOPE, 'v2');
    if (found.state !== 'same') throw new Error('the draft was not found');
    expect(found.draft.savedAt).toBe('2026-11-16T03:00:00.000Z');
    const restored = templateOfDraft(found.draft);
    expect(paramsOfTemplate(restored)).toEqual(paramsOfTemplate(written));
    expect(restored.tasks.map((task) => isPending(task))).toEqual([false, true]);
    expect((restored.steps ?? []).map((step) => isPending(step))).toEqual([false, true]);
    const named = settleCodes(nameLine(restored, linesOf(restored)[1] as never, 'Thẩm định'));
    expect(named.tasks.map((task) => task.code)).toEqual(['KHAO_SAT', 'THAM_DINH']);
  });

  it('a draft made on another base version is a conflict: nothing is merged, the person keeps it or drops it', () => {
    const store = memory();
    saveLocalDraft(store, SCOPE, draftOfTemplate(template(), 'v2', NOW));
    // Somebody approved version 3 meanwhile: the screen now opens on v3.
    const found = findLocalDraft(store, SCOPE, 'v3');
    expect(found.state).toBe('conflict');
    if (found.state !== 'conflict') return;
    expect(found.draft.base).toBe('v2');
    // Kept: it becomes the draft on the new base, and the old one is gone (one draft a template and a person).
    saveLocalDraft(store, SCOPE, { ...found.draft, base: 'v3' });
    expect(findLocalDraft(store, SCOPE, 'v3').state).toBe('same');
    expect(store.getItem(draftKey(SCOPE, 'v2'))).toBeNull();
    // Dropped: nothing is left.
    dropLocalDraft(store, SCOPE);
    expect(findLocalDraft(store, SCOPE, 'v3')).toEqual({ state: 'none' });
  });

  it('carries the "Áp cho" changes that wait to be submitted with the template', () => {
    const store = memory();
    saveLocalDraft(store, SCOPE, draftOfTemplate(template(), 'v2', NOW, { added: [{ field: 'project_type', value: 'ROAD_REPAIR', first: false }], removed: ['OLD_LINE'] }));
    const found = findLocalDraft(store, SCOPE, 'v2');
    expect(found.state === 'same' ? found.draft.apply : undefined).toEqual({ added: [{ field: 'project_type', value: 'ROAD_REPAIR', first: false }], removed: ['OLD_LINE'] });
    expect('apply' in draftOfTemplate(template(), 'v2', NOW, { added: [], removed: [] })).toBe(false);
  });

  it('sign-out removes every draft of the device and nothing else', () => {
    const store = memory();
    store.setItem('mv.favourites', '[]');
    saveLocalDraft(store, SCOPE, draftOfTemplate(template(), 'v2', NOW));
    saveLocalDraft(store, { ...SCOPE, membershipId: 'member-2', code: NEW_TEMPLATE }, draftOfTemplate(template(), 'blank', NOW));
    expect(clearLocalDrafts(store)).toBe(2);
    expect(store.length).toBe(1);
    expect(store.getItem('mv.favourites')).toBe('[]');
  });

  it('a store that is absent, full or holds something else loses the convenience and never the screen', () => {
    expect(saveLocalDraft(undefined, SCOPE, draftOfTemplate(template(), 'v2', NOW))).toBe(false);
    expect(findLocalDraft(undefined, SCOPE, 'v2')).toEqual({ state: 'none' });
    expect(clearLocalDrafts(undefined)).toBe(0);
    dropLocalDraft(undefined, SCOPE);
    const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } } as unknown as Storage;
    expect(saveLocalDraft(full, SCOPE, draftOfTemplate(template(), 'v2', NOW))).toBe(false);
    const store = memory();
    store.setItem(draftKey(SCOPE, 'v2'), 'not json');
    expect(findLocalDraft(store, SCOPE, 'v2')).toEqual({ state: 'none' });
    store.setItem(draftKey(SCOPE, 'v2'), JSON.stringify({ base: 'v2' }));
    expect(findLocalDraft(store, SCOPE, 'v2')).toEqual({ state: 'none' });
    const broken = { get length(): number { throw new Error('closed'); }, key: () => null, getItem: () => { throw new Error('closed'); }, setItem: () => undefined, removeItem: () => undefined } as unknown as Storage;
    expect(findLocalDraft(broken, SCOPE, 'v2')).toEqual({ state: 'none' });
    expect(clearLocalDrafts(broken)).toBe(0);
    dropLocalDraft(broken, SCOPE);
  });
});
