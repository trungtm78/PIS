/**
 * The code of a new phase, step, task, role or party, made from its name (R63). The rule is the kernel's `workflowCodeFrom` (packages/kernel/src/project-workflow-table.ts), repeated here because the web may not
 * import the kernel (.dependency-cruiser.cjs, R56); `codes-model.test.ts` holds the vectors of the kernel test, so the two cannot drift unseen.
 *
 * The marks of the letters are dropped (`đ` is `d`), the letters are capitals, everything else is one underscore, at most 40 characters; a name that gives no letter first gets the prefix `C_`. A code that is taken
 * gets `_2`, `_3`, ... (the stem is cut so that the whole still fits). The code of a row is made ONCE: renaming the row never calls this again, because the code is the identity of the row in every project that froze
 * the template.
 */
const CODE_MAX = 40;

export function workflowCodeFrom(name: string, taken: Iterable<string> = []): string {
  const plain = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let stem = /^[A-Z]/.test(plain) ? plain : `C_${plain}`;
  stem = stem.slice(0, CODE_MAX).replace(/_+$/g, '');
  if (stem.length < 2) stem = 'CODE';
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${stem.slice(0, CODE_MAX - suffix.length).replace(/_+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A code no entity of the list has yet, for a row that has no name so far; it is replaced by the code made from the name the first time the row is named. */
export function provisionalCode(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let index = 1; ; index += 1) if (!used.has(`NEW_${index}`)) return `NEW_${index}`;
}
