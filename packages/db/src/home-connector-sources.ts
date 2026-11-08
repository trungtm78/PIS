import { EGP_CONNECTOR_CODE, message } from '@machvon/kernel';
import { EgpConnectionStore } from './egp-store.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the audience of the alert: the integration administrator (`CONNECTOR_STALE`, owner INTEGRATION_ADMINISTRATOR), on the whole tenant (the connection belongs to no unit). */
export const CONNECTOR_AUDIENCE_PERMISSION = 'bid.egp.admin';

/**
 * A reader of the connections an edition adds to the alert centre (ENT-2): a connection that is not part of the base product (the push to the reporting platform of the customer, the file import of its ledger) says in its own rows when it is stale or
 * failed. The edition registers its readers once when its package loads; a public process registers none and the source reads the national procurement network alone. The rows are of the kind CONNECTOR_STALE and carry the alert type
 * code of the reader, so that owner, expected action and consequence come from the registry of alert types like any other item.
 */
export interface ConnectorAlertReader {
  /** A stable id, lower case with dots (`hpm.reports`): registering the same id again changes nothing. */
  id: string;
  read(context: SourceContext): Promise<SourceRow[]>;
}

const EXTRA_READERS: ConnectorAlertReader[] = [];

/** Adds a reader of connections to the source CONNECTOR; a reader already registered under the id is kept as it is. */
export function registerConnectorAlertReader(reader: ConnectorAlertReader): void {
  if (EXTRA_READERS.some((known) => known.id === reader.id)) return;
  EXTRA_READERS.push(reader);
}

/**
 * The connections to outside systems as a source of the alert centre (EGP-1, `docs/egp-connector.md`). One kind, `CONNECTOR_STALE`, with its ALERT_TYPE (owner: integration administrator; expected action: check the
 * connector, fetch the latest file and record the cause; consequence: the figures from outside are older than allowed and must say so): the connection `egp.muasamcong` whose last applied file is older than
 * `max_age_hours` of the rule `CONNECTOR_FRESHNESS`, code `EGP_FILE` (read through `GovernancePolicyPort`; the numbers are our own and flagged UNVERIFIED until the tenant approves its rule). The severity is the
 * `stale_severity` of that rule. A tenant that never imported a file is not nagged (the connection says it never took a file in), and one that switched the connection off with a reason is not either: it chose to stop.
 * The age is computed when the list is read, so there is no job to run and nothing to fall behind.
 */
export class HomeConnectorSources {
  private readonly connections = new EgpConnectionStore();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const own = await this.nationalNetwork(context);
    const extra: SourceRow[] = [];
    for (const reader of EXTRA_READERS) extra.push(...(await reader.read(context)));
    return [...own, ...extra];
  }

  private async nationalNetwork(context: SourceContext): Promise<SourceRow[]> {
    const connection = await this.connections.current(context.tx);
    if (connection.id === null || !connection.enabled) return [];
    const reading = await this.connections.health(context.tx, context.now, connection);
    const alert = reading.view.health.alert;
    if (alert === null || reading.lastImportAt === null) return [];
    const staleSince = new Date(Date.parse(reading.lastImportAt) + reading.rule.params.maxAgeHours * 3_600_000).toISOString();
    const age = reading.view.health.ageHours;
    const row: SourceRow = {
      ...base('CONNECTOR_STALE'),
      id: `${EGP_CONNECTOR_CODE}:stale`,
      dueOn: context.today,
      originalDueOn: staleSince.slice(0, 10),
      title: message('home.source.connector.title', { code: EGP_CONNECTOR_CODE }),
      subtitle: age === null ? null : message('home.source.connector.detail', { hours: Math.round(age), max: String(reading.rule.params.maxAgeHours) }),
      status: 'STALE',
      severity: severityOf('CONNECTOR', `STALE_${alert.severity}`, context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES.CONNECTOR_STALE ?? null,
      causeKey: `connector:${EGP_CONNECTOR_CODE}`,
      startedAt: staleSince,
      target: { screen: 'BID-22', id: connection.id },
    };
    return forAudience(context, 'CONNECTOR', CONNECTOR_AUDIENCE_PERMISSION, [row], true);
  }
}
