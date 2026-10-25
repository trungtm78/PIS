import type { LedgerPage } from '@machvon/db';
import { SummaryCache } from '../ctr/summary-cache';

/**
 * The cache of the pages of the cumulative ledger (ST-PAY-001): `t:{tenant}:pay:ledger:{contract}:v{version}:{question}`. The version of the contract moves with every entry, so a page of an older
 * version is never asked for again; a `pay.*` event about the contract drops what the cache holds for it, whatever the version, so a change that did not move the version cannot be missed.
 */
export type LedgerCache = SummaryCache<LedgerPage>;

export const ledgerCachePrefix = (tenantId: string, contractId: string): string => `t:${tenantId}:pay:ledger:${contractId}:`;

export const ledgerCacheKey = (tenantId: string, contractId: string, version: number, question: string): string => `${ledgerCachePrefix(tenantId, contractId)}v${version}:${question}`;

/** The cache of this process, shared by the controller that answers the reads and the consumer that learns of the changes. */
export const SHARED_LEDGER_CACHE: LedgerCache = new SummaryCache<LedgerPage>();
