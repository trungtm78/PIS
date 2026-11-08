import { aggregateFeedFacts, feedInternalFindings, feedQuality, foldFeedFacts } from '@machvon/kernel';
import type { FeedFacts, FeedFinding, FeedGroupBy, FeedPolicy, FeedProjectFact, FeedQuality } from '@machvon/kernel';
import { FeedDifferenceStore } from './finance-feed-mapping-store.ts';
import { FeedConnectionStore, FeedRecordStore } from './finance-feed-store.ts';
import type { TenantTx } from './tenant-database.ts';

export interface ProvinceFactsFilter {
  fiscalYear: number;
  /** Only statements true on or before this day count (a view of the past). */
  asOf?: string | undefined;
  sector?: string | undefined;
  district?: string | undefined;
  investor?: string | undefined;
  fund?: string | undefined;
}

/**
 * The reader of the province-wide facts (FEED-1, `docs/finance-feed.md` section 9): the one thing a consumer such as the dashboard of the head of the committee reads. It knows nothing of the adapters: it folds the
 * records of the store (the latest statement of a thing wins, the earlier ones stay in the store), takes the current epoch of the generator and every record of the other channels, and returns projects, plans and
 * disbursement by sector, district, investor, fund and month, with the channels the figures came in by (internal provenance). The day the real feed replaces the generator no consumer changes.
 */
export class ProvinceFactsReader {
  private readonly connections = new FeedConnectionStore();
  private readonly records = new FeedRecordStore();
  private readonly differences = new FeedDifferenceStore();

  private async epoch(tx: TenantTx): Promise<number> {
    return (await this.connections.current(tx)).generatorEpoch;
  }

  /** The facts of each project of a fiscal year, in the order of their codes. */
  async projects(tx: TenantTx, filter: ProvinceFactsFilter): Promise<FeedProjectFact[]> {
    const loaded = await this.records.load(tx, { generatorEpoch: await this.epoch(tx), fiscalYear: filter.fiscalYear, kinds: ['PROJECT', 'PLAN', 'DISBURSEMENT'] });
    return foldFeedFacts(loaded, filter);
  }

  /** The facts grouped by sector, district, investor, fund, month or project, with totals and rates. */
  async facts(tx: TenantTx, filter: ProvinceFactsFilter, groupBy: FeedGroupBy): Promise<FeedFacts> {
    return aggregateFeedFacts(await this.projects(tx, filter), groupBy, filter.fiscalYear);
  }

  /** The disagreements inside the data of the feed itself (a cumulative that is not the sum of the months, over the plan, a month stated again, an unknown project). */
  async findings(tx: TenantTx, fiscalYear: number): Promise<FeedFinding[]> {
    const loaded = await this.records.load(tx, { generatorEpoch: await this.epoch(tx), fiscalYear, kinds: ['PROJECT', 'PLAN', 'DISBURSEMENT'] });
    return feedInternalFindings(loaded, fiscalYear);
  }

  /** The data-quality indicators of the feed for one reporting month: completeness, timeliness, who is late, and the discrepancy rate against our own figures. */
  async quality(tx: TenantTx, input: { fiscalYear: number; month: number; today: string; policy: FeedPolicy }): Promise<FeedQuality> {
    const loaded = await this.records.load(tx, { generatorEpoch: await this.epoch(tx), fiscalYear: input.fiscalYear, kinds: ['PROJECT', 'PLAN', 'DISBURSEMENT'] });
    const facts = foldFeedFacts(loaded, { fiscalYear: input.fiscalYear });
    const counts = await this.differences.counts(tx, input.fiscalYear);
    return feedQuality({
      facts,
      disbursements: loaded,
      fiscalYear: input.fiscalYear,
      month: input.month,
      today: input.today,
      reportDueDays: input.policy.report_due_days,
      compared: counts.comparedLatest ?? 0,
      discrepancies: counts.differencesLatest ?? 0,
      findings: feedInternalFindings(loaded, input.fiscalYear).length,
    });
  }
}
