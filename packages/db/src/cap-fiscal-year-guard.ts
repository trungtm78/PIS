import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * What a fiscal year lets the capital do (ST-CAP-008, CAP 3.1 F6, BR-CAP-04). The year control is kept by `CapFiscalYearStore`; a year without a control row is open. An open year takes
 * every command. A soft-closed year (the adjustment period after the year end) takes only what moves capital out of the year or pays it: the plan, the appropriations, the reservations
 * and the commitments of that year are refused, and so is the capital carried into it. A locked year takes nothing, until it is reopened for a window.
 */

/** 409 FISCAL_YEAR_LOCKED naming the plan year and, in `state`, whether the year is soft-closed or locked. */
const refused = (state: string): DomainError => new DomainError('FISCAL_YEAR_LOCKED', 409, 'plan_year', { extensions: { state } });

/**
 * The plan commands, the appropriation register, the commitments and the capital carried into a year need the year open: a year that is soft-closed or locked takes none of them.
 * Years the control does not know are open.
 */
export async function assertYearsOpen(tx: TenantTx, years: readonly number[]): Promise<void> {
  if (years.length === 0) return;
  const [closed] = await tx.query<{ status: string }>(
    "select status from machvon.fiscal_year_control where plan_year = any($1::integer[]) and status in ('SOFT_CLOSED', 'LOCKED') order by (status = 'LOCKED') desc limit 1",
    [[...new Set(years)]],
  );
  if (closed !== undefined) throw refused(closed.status);
}

/**
 * What takes capital out of a year (carrying it over to the next, ST-CAP-007) and what pays it needs the year not locked: the adjustment period of a soft-closed year is exactly for them.
 */
export async function assertYearsNotLocked(tx: TenantTx, years: readonly number[]): Promise<void> {
  if (years.length === 0) return;
  const locked = await tx.query("select 1 from machvon.fiscal_year_control where plan_year = any($1::integer[]) and status = 'LOCKED'", [[...new Set(years)]]);
  if (locked.length > 0) throw refused('LOCKED');
}
