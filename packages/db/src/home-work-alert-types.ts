import type { ResolvedGovernanceRule } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { CONSEQUENCES } from './home-work-rules.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the registry of alert types (G0-3, rule type `ALERT_TYPE`) says about the type of an item of the alert centre: who owns it, what is expected, how fast it must be answered, which version of the rule said so.
 * The alert centre shows the consequence and the response time from here and never from a constant of its own; `CONSEQUENCES` of home-work-rules.ts stays only as the text of the built-in types.
 */
export interface AlertTypeReading {
  code: string;
  owner: string | null;
  expectedAction: string | null;
  responseHours: number | null;
  /** The version of the rule that decided: 0 for the built-in type. */
  version: number;
  source: 'RULE' | 'DEFAULT';
  /** The day the type is next reviewed has passed. */
  reviewOverdue: boolean;
  /** An urgent alert of this type may break the quiet hours of a person once nobody took it up in time (G2-5). */
  quietBypass: boolean;
}

/** The part of an item this hook reads and writes. */
interface AlertTypedRow {
  kind: string;
  source: string;
  consequence: string | null;
  /** What a native clock says is expected: an item that carries its own expected action carries its own consequence too (both are mandatory when a module starts the clock), and the type does not replace it. */
  expectedAction?: string | null;
  alertType?: AlertTypeReading | null;
  /** The type an item names itself when its kind is shared by several types (the connectors an edition adds). */
  alertTypeCode?: string | undefined;
}

const BY_CONSEQUENCE: ReadonlyMap<string, string> = new Map(Object.entries(CONSEQUENCES).map(([code, sentence]) => [sentence, code]));

/**
 * The alert type of an item. The sources of the alert centre say what is not done in a sentence that is the consequence of the type, so the sentence names the type; a kind of work that is its own type (the money
 * control) names itself; the work that was there before the alert centre has the type of its source.
 */
export function alertTypeCodeOf(row: Pick<AlertTypedRow, 'kind' | 'source' | 'consequence' | 'alertTypeCode'>): string {
  if (row.alertTypeCode !== undefined) return row.alertTypeCode;
  return (row.consequence === null ? undefined : BY_CONSEQUENCE.get(row.consequence)) ?? (CONSEQUENCES[row.kind] === undefined ? row.source : row.kind);
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function readingOf(resolved: ResolvedGovernanceRule, today: string): AlertTypeReading {
  const params = resolved.params;
  const review = text(params.review_on);
  return {
    code: resolved.code,
    owner: text(params.owner),
    expectedAction: text(params.expected_action),
    responseHours: typeof params.response_hours === 'number' ? params.response_hours : null,
    version: resolved.version,
    source: resolved.source,
    reviewOverdue: review !== null && review < today,
    quietBypass: params.quiet_bypass === true,
  };
}

/**
 * The one hook of G0-3 in the alert centre: after the sources are read, the consequence and the response time of each item come from the `ALERT_TYPE` rule in force today (an approved version of the tenant, else the
 * built-in type) through the governance port. An item whose type is not in the registry keeps the consequence its source gave (the governance check says there should be none). A read of the registry that fails is
 * rolled back to a savepoint and leaves the items as their sources made them: the alert centre must not lose the work because the registry could not be read.
 */
export async function applyAlertTypes(tx: TenantTx, rows: readonly AlertTypedRow[], today: string, port: GovernancePolicyPort = new GovernancePolicyPort()): Promise<void> {
  if (rows.length === 0) return;
  await tx.query('savepoint home_alert_types');
  let types: ResolvedGovernanceRule[];
  try {
    types = await port.getAll(tx, 'ALERT_TYPE', today);
    await tx.query('release savepoint home_alert_types');
  } catch {
    await tx.query('rollback to savepoint home_alert_types');
    await tx.query('release savepoint home_alert_types');
    return;
  }
  const byCode = new Map(types.map((resolved) => [resolved.code, resolved]));
  for (const row of rows) {
    const resolved = byCode.get(alertTypeCodeOf(row));
    if (resolved === undefined) continue;
    const reading = readingOf(resolved, today);
    row.alertType = reading;
    const consequence = text(resolved.params.consequence);
    if (consequence !== null && (row.expectedAction ?? null) === null) row.consequence = consequence;
  }
}
