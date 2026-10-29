export const TILE_KEYS = ['drafts_in_review', 'awaiting_leader_signature', 'awaiting_number', 'awaiting_seal', 'overdue_incoming', 'interop_errors', 'templates_pending_confirmation'] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export interface Tile {
  key: TileKey;
  /** The number in the queue in the scope of the viewer, or none when the viewer may not read that kind of document (never shown as 0). */
  count: number | null;
}

export interface Overview {
  asOf: string;
  tiles: Tile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The overview as the server answers it; a tile that is unknown, or whose count is not a whole number, is left out, and the tiles come in the order of the screen. */
export function toOverview(raw: unknown): Overview {
  const body = isRecord(raw) ? raw : {};
  const found = new Map<TileKey, Tile>();
  for (const entry of Array.isArray(body.tiles) ? body.tiles : []) {
    if (!isRecord(entry)) continue;
    const key = TILE_KEYS.find((candidate) => candidate === entry.key);
    if (key === undefined) continue;
    const count = entry.count;
    if (count === null) found.set(key, { key, count: null });
    else if (typeof count === 'number' && Number.isInteger(count) && count >= 0) found.set(key, { key, count });
  }
  return { asOf: typeof body.as_of === 'string' ? body.as_of : '', tiles: TILE_KEYS.flatMap((key) => found.get(key) ?? []) };
}

/** Where a tile leads: the list of that queue (the filter travels in the link), or nowhere while there is nothing behind it. */
export function tileLink(key: TileKey): string | undefined {
  switch (key) {
    case 'drafts_in_review':
      return '/doc/doc-03?status=IN_REVIEW';
    case 'awaiting_leader_signature':
      return '/doc/doc-03?status=SUBMITTED';
    case 'awaiting_number':
      return '/doc/doc-03?status=SIGNED';
    case 'awaiting_seal':
      return '/doc/doc-03?status=NUMBERED';
    case 'overdue_incoming':
      return '/doc/doc-12?overdue=true';
    case 'templates_pending_confirmation':
      return '/doc/doc-14';
    case 'interop_errors':
      return undefined;
  }
}

/** The legal confirmation that the templates wait for, as the design names it. */
export const TEMPLATE_CXN = '[CXN-DOC-01]';
