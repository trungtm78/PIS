/**
 * The effects of a document in which other modules may still rely on it as a legal basis (DOC.md F9, BR-DOC-21): a document in force, and one that was corrected, which stays in force with its correction. A recalled or
 * a replaced document, one that is still pending and one that has expired are not.
 */
export const IN_FORCE_EFFECTS: readonly string[] = ['EFFECTIVE', 'CORRECTED'];

export const isInForce = (effectStatus: string): boolean => IN_FORCE_EFFECTS.includes(effectStatus);
