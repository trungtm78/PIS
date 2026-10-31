import { IN_FORCE_EFFECTS, isInForce } from '../src/doc-effect.ts';

describe('the effects in which a document is still a legal basis (BR-DOC-21)', () => {
  it('are in force and corrected, and no other', () => {
    expect(IN_FORCE_EFFECTS).toEqual(['EFFECTIVE', 'CORRECTED']);
    expect(['PENDING', 'EFFECTIVE', 'RECALLED', 'REPLACED', 'CORRECTED', 'EXPIRED', ''].map(isInForce)).toEqual([false, true, false, false, true, false, false]);
  });
});
