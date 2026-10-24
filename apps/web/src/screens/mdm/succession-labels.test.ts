import { describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { structureStateLabel, successionKindLabel, successionProblemMessage } from './succession-labels';
import { SUCCESSION_KINDS } from './succession-model';
import type { StructureState } from './succession-model';

/** A translator that returns the key, so that a label is known by the key it asks for. */
const t = (key: string): string => key;

describe('succession labels', () => {
  it('names every kind of succession and every state of an entry with a key of the catalogue', () => {
    const kinds = SUCCESSION_KINDS.map((kind) => successionKindLabel(t, kind));
    expect(new Set(kinds).size).toBe(SUCCESSION_KINDS.length);
    const states: StructureState[] = ['IN_FORCE', 'SUCCEEDED', 'NOT_STARTED', 'ENDED'];
    const named = states.map((state) => structureStateLabel(t, state));
    expect(new Set(named).size).toBe(states.length);
    for (const key of [...kinds, ...named]) expect(vi_).toHaveProperty([key]);
  });

  it('words the problems of a share and of two entries, and leaves the others to the shared sentences', () => {
    expect(successionProblemMessage(t, 'invalidShare')).toBe('mdm.succession.invalidShare.error');
    expect(successionProblemMessage(t, 'sameEntry')).toBe('mdm.succession.sameEntry.error');
    expect(successionProblemMessage(t, 'required')).toBe('mdm.field.required.error');
    expect(successionProblemMessage(t, 'tooShort')).toBe('mdm.field.tooShort.error');
  });
});
