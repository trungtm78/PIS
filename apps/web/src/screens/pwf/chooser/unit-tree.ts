/**
 * The organisation units of the tenant as a tree to choose from (R61): a unit that the project and the template cannot name is chosen by the person who starts the workflow, from this list, never guessed. The read is the
 * list of units the caller may read; a unit whose period of effect has ended is not offered (the server refuses it anyway, PWF_UNIT_UNKNOWN).
 */

export interface UnitNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export interface UnitChoice extends UnitNode {
  /** How deep the unit sits under the roots the caller reads (0 for a root). */
  depth: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** One row of the list of units as a node; a row with no id is not a unit, and a unit that ended before `today` (`valid_until`, `YYYY-MM-DD`) is left out. */
export function toUnitNode(raw: unknown, today: string): UnitNode[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  if (row === undefined || id === undefined) return [];
  const until = text(row.valid_until);
  if (until !== undefined && until.slice(0, 10) < today) return [];
  return [{ id, code: text(row.code) ?? '', name: text(row.name) ?? '', parentId: text(row.parent_id) ?? null }];
}

/** The units in tree order (a parent, then its children by code and name), each with its depth; a unit whose parent is not in the list (a unit the caller reads under one it does not) is a root. */
export function unitChoices(nodes: readonly UnitNode[]): UnitChoice[] {
  const known = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, UnitNode[]>();
  for (const node of nodes) {
    const parent = node.parentId !== null && known.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const order = (list: UnitNode[]): UnitNode[] => [...list].sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  const out: UnitChoice[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const node of order(children.get(parent) ?? [])) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ ...node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
