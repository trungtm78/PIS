import { DomainError, milestoneMoment } from '@machvon/kernel';
import type { MilestoneDates } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The opening and the closing of the bids of a package as the milestones give them: the day it happened, else the day it is planned for. */
export interface BidWindow {
  openingAt: string | null;
  closingAt: string | null;
}

interface WindowSql {
  milestone_kind: string;
  planned_at: string | null;
  actual_at: string | null;
}

export async function bidWindowOf(tx: TenantTx, packageId: string): Promise<BidWindow> {
  const rows = await tx.query<WindowSql>(
    `select milestone_kind, to_char(planned_at at time zone 'UTC', ${ISO}) as planned_at, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at
       from machvon.procurement_milestone where package_id = $1::uuid and milestone_kind in ('BID_OPENING', 'BID_CLOSING')`,
    [packageId],
  );
  const dates = (kind: string): MilestoneDates | undefined => {
    const row = rows.find((candidate) => candidate.milestone_kind === kind);
    return row === undefined ? undefined : { plannedAt: row.planned_at, actualAt: row.actual_at };
  };
  return { openingAt: milestoneMoment(dates('BID_OPENING')), closingAt: milestoneMoment(dates('BID_CLOSING')) };
}

/**
 * Whether an opening at `nextOpening` would seal again a proposal of the package that was already released: the bids are opened once, and a date that comes later than the
 * moment they were opened at does not close them. The database refuses it too (the milestone trigger); this is the answer a person can act on.
 */
export async function openingWouldReseal(tx: TenantTx, packageId: string, nextOpening: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from machvon.proposal where package_id = $1::uuid and status = 'RECEIVED' and access_released_at <= now() and access_released_at < $2::timestamptz limit 1`,
    [packageId, nextOpening],
  );
  return rows.length > 0;
}

export async function assertOpeningNotResealed(tx: TenantTx, packageId: string, nextOpening: string | null, field: 'planned_at' | 'actual_at'): Promise<void> {
  if (nextOpening !== null && (await openingWouldReseal(tx, packageId, nextOpening))) {
    throw new DomainError('OPENING_ALREADY_RELEASED', 409, field);
  }
}
