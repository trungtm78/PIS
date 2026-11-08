import { EGP_CONNECTOR_CODE, FEED_CONNECTOR_CODE, feedAlertsFor, message } from '@machvon/kernel';
import { EgpConnectionStore } from './egp-store.ts';
import { FeedDifferenceStore } from './finance-feed-mapping-store.ts';
import { ProvinceFactsReader } from './finance-feed-reader.ts';
import { FeedConnectionStore } from './finance-feed-store.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the audience of the alert: the integration administrator (`CONNECTOR_STALE`, owner INTEGRATION_ADMINISTRATOR), on the whole tenant (the connection belongs to no unit). */
export const CONNECTOR_AUDIENCE_PERMISSION = 'bid.egp.admin';
/** The audience of the alerts of the feed of the Finance Department: the integration administrator for the connection and the late units, whoever may settle a difference for a large difference. */
export const FEED_AUDIENCE_PERMISSION = 'fin.feed.admin';
export const FEED_DIFFERENCE_AUDIENCE_PERMISSION = 'fin.feed.resolve';

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
  private readonly feedConnections = new FeedConnectionStore();
  private readonly feedDifferences = new FeedDifferenceStore();
  private readonly feedFacts = new ProvinceFactsReader();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const own = await this.nationalNetwork(context);
    const extra: SourceRow[] = [];
    for (const reader of EXTRA_READERS) extra.push(...(await reader.read(context)));
    return [...own, ...extra];
  }

  private async nationalNetwork(context: SourceContext): Promise<SourceRow[]> {
    return [...(await this.egpItems(context)), ...(await this.feedItems(context))];
  }

  private async egpItems(context: SourceContext): Promise<SourceRow[]> {
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

  /**
   * The feed of the Finance Department (lane FEED-1, docs/finance-feed.md): FEED_STALE when its last run is older than the rule allows, FEED_UNIT_LATE for each unit that has not sent the report of the month after its
   * due day, FEED_DISCREPANCY_LARGE for each open difference above the large line. Nothing for a connection that was never used or was switched off with a reason. The state is computed when the list is read.
   */
  private async feedItems(context: SourceContext): Promise<SourceRow[]> {
    const connection = await this.feedConnections.current(context.tx);
    if (connection.id === null || !connection.enabled) return [];
    const reading = await this.feedConnections.health(context.tx, context.now, connection);
    if (reading.lastRunAt === null) return [];
    const generated = connection.generatorParams;
    const year = Number(context.today.slice(0, 4));
    const month = Number(context.today.slice(5, 7));
    const period = typeof generated?.fiscal_year === 'number' && typeof generated.current_month === 'number' ? { fiscalYear: generated.fiscal_year, month: generated.current_month } : month === 1 ? { fiscalYear: year - 1, month: 12 } : { fiscalYear: year, month: month - 1 };
    const quality = await this.feedFacts.quality(context.tx, { ...period, today: context.today, policy: reading.policy.params });
    const large = await this.feedDifferences.openLarge(context.tx, 50);
    const alerts = feedAlertsFor({ enabled: connection.enabled, health: reading.health, lateUnits: quality.lateUnits.map((unit) => unit.investorCode), largeOpenDifferences: large.map((row) => row.id) });
    const connectionRows: SourceRow[] = [];
    const differenceRows: SourceRow[] = [];
    for (const alert of alerts) {
      if (alert.code === 'FEED_STALE') {
        const staleSince = new Date(Date.parse(reading.lastRunAt) + reading.freshness.params.max_age_hours * 3_600_000).toISOString();
        const age = reading.health.ageHours;
        connectionRows.push({
          ...base('FEED_STALE'),
          id: `${FEED_CONNECTOR_CODE}:stale`,
          dueOn: context.today,
          originalDueOn: staleSince.slice(0, 10),
          title: message('home.source.feed.stale.title'),
          subtitle: age === null ? null : message('home.source.feed.stale.detail', { hours: Math.round(age), max: String(reading.freshness.params.max_age_hours) }),
          status: 'STALE',
          severity: severityOf('CONNECTOR', `STALE_${alert.severity}`, context.rules),
          lifecycle: 'NEW',
          consequence: CONSEQUENCES.FEED_STALE ?? null,
          causeKey: `connector:${FEED_CONNECTOR_CODE}`,
          startedAt: staleSince,
          target: { screen: 'FEED-01', id: connection.id },
        });
      } else if (alert.code === 'FEED_UNIT_LATE') {
        const unit = quality.lateUnits.find((one) => one.investorCode === alert.subject);
        if (unit === undefined) continue;
        connectionRows.push({
          ...base('FEED_UNIT_LATE'),
          id: `${FEED_CONNECTOR_CODE}:late:${unit.investorCode}:${quality.fiscalYear}-${quality.month}`,
          dueOn: unit.dueOn,
          originalDueOn: unit.dueOn,
          title: message('home.source.feed.unit_late.title', { unit: unit.investorName ?? unit.investorCode, month: quality.month, year: quality.fiscalYear }),
          subtitle: message('home.source.feed.unit_late.detail', { due: unit.dueOn, projects: unit.projects }),
          status: 'LATE',
          severity: severityOf('CONNECTOR', 'FEED_UNIT_LATE', context.rules),
          lifecycle: 'NEW',
          consequence: CONSEQUENCES.FEED_UNIT_LATE ?? null,
          causeKey: `feed-unit:${unit.investorCode}:${quality.fiscalYear}-${quality.month}`,
          startedAt: `${unit.dueOn}T00:00:00.000Z`,
          target: { screen: 'FEED-01', id: connection.id },
        });
      } else {
        const row = large.find((one) => one.id === alert.subject);
        if (row === undefined) continue;
        differenceRows.push({
          ...base('FEED_DISCREPANCY_LARGE'),
          id: `${FEED_CONNECTOR_CODE}:difference:${row.id}`,
          dueOn: row.dueAt.slice(0, 10),
          originalDueOn: row.dueAt.slice(0, 10),
          title: message('home.source.feed.discrepancy.title', { code: row.ourCode ?? row.feedProjectCode, year: row.fiscalYear }),
          subtitle: message('home.source.feed.discrepancy.detail', { feed: row.feed, ours: row.ours ?? '-', pct: row.deltaPct ?? '-' }),
          status: 'OPEN',
          severity: severityOf('CONNECTOR', 'FEED_DISCREPANCY_LARGE', context.rules),
          lifecycle: 'NEW',
          consequence: CONSEQUENCES.FEED_DISCREPANCY_LARGE ?? null,
          causeKey: `feed-difference:${row.id}`,
          startedAt: row.openedAt,
          target: { screen: 'FEED-04', id: row.id },
        });
      }
    }
    return [...(await forAudience(context, 'CONNECTOR', FEED_AUDIENCE_PERMISSION, connectionRows, true)), ...(await forAudience(context, 'CONNECTOR', FEED_DIFFERENCE_AUDIENCE_PERMISSION, differenceRows, true))];
  }
}
