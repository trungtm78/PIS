/** The status a send moves to when the provider may have acted but the result never came back. */
export const UNCERTAIN_STATUS = 'UNCERTAIN';

/**
 * The statuses of one kind of tracked item and the moves between them. Every status that can follow another is listed under it; a move
 * may skip statuses (a provider need not report each one). The graph has no cycle, which is what makes a status monotonic: whatever has
 * been reached is never reached again from a later status.
 */
export interface StatusTable<S extends string = string> {
  readonly name: string;
  readonly initial: readonly S[];
  readonly statuses: readonly S[];
  /** The statuses strictly after the key, directly or through others. */
  readonly after: ReadonlyMap<S, ReadonlySet<S>>;
}

/** Builds a table and refuses a definition that names an unknown status, moves to itself or contains a cycle. */
export function defineStatusTable<S extends string>(name: string, transitions: Readonly<Record<S, readonly S[]>>, initial: readonly S[]): StatusTable<S> {
  const statuses = Object.keys(transitions) as S[];
  const known = new Set<S>(statuses);
  if (initial.length === 0 || initial.some((status) => !known.has(status))) throw new Error(`status table ${name}: initial statuses must be declared`);
  const after = new Map<S, ReadonlySet<S>>();
  const visiting = new Set<S>();
  const reach = (status: S): ReadonlySet<S> => {
    const done = after.get(status);
    if (done !== undefined) return done;
    if (visiting.has(status)) throw new Error(`status table ${name}: ${status} is part of a cycle`);
    visiting.add(status);
    const reached = new Set<S>();
    for (const next of transitions[status]) {
      if (!known.has(next)) throw new Error(`status table ${name}: ${status} moves to the undeclared status ${next}`);
      if (next === status) throw new Error(`status table ${name}: ${status} moves to itself`);
      reached.add(next);
      for (const later of reach(next)) reached.add(later);
    }
    visiting.delete(status);
    after.set(status, reached);
    return reached;
  };
  for (const status of statuses) reach(status);
  return { name, initial, statuses, after };
}

/**
 * What became of an incoming status:
 * - APPLIED: it is later than the current one; the item moves.
 * - DUPLICATE: it is the current status; nothing changes and nothing is recorded.
 * - STALE: it is earlier than the current one (a late callback); ignored.
 * - CONFLICT: neither before nor after (for example FAILED after DELIVERED); ignored, and the disagreement needs a person.
 * - UNKNOWN_STATUS: the table does not know the status; ignored.
 */
export type ReduceOutcome = 'APPLIED' | 'DUPLICATE' | 'STALE' | 'CONFLICT' | 'UNKNOWN_STATUS';

/** Decides what an incoming status does to an item at `current`. A status never moves backwards. */
export function reduceStatus<S extends string>(table: StatusTable<S>, current: S, incoming: string): ReduceOutcome {
  const next = table.statuses.find((status) => status === incoming);
  if (next === undefined) return 'UNKNOWN_STATUS';
  if (next === current) return 'DUPLICATE';
  if (table.after.get(current)?.has(next) === true) return 'APPLIED';
  if (table.after.get(next)?.has(current) === true) return 'STALE';
  return 'CONFLICT';
}
