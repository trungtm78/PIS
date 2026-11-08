import { FEED_CHANNELS, FEED_CONNECTOR_CODE, FEED_KINDS, FEED_LAYOUT_VERSIONS, FEED_PENDING_EXTERNAL_ITEMS, FEED_POSITIONS, FEED_SOURCE_SYSTEM } from './finance-feed-model.ts';

/**
 * Everything the Integration Hub needs to know about the connector `fin.sotaichinh` (the feed of the Finance Department), in one plain constant: the lead adapts it to the hub descriptor at merge. No behaviour
 * lives here; the rules are in `finance-feed-management.ts`, the layouts and adapters in `finance-feed.ts`.
 */
export const FINANCE_FEED_CONNECTION = {
  code: FEED_CONNECTOR_CODE,
  /** The system on the other side, and the source system written on its rows of `master_crosswalk`. */
  counterparty: 'FINANCE_DEPARTMENT',
  sourceSystem: FEED_SOURCE_SYSTEM,
  direction: 'INBOUND',
  /** The ways records come in: a file a person hands over, a push of the Finance application with a machine account, the data generator. */
  transportModes: FEED_CHANNELS,
  /** Which transports are real today: the file adapter works, the push adapter refuses (FEED_API_UNAVAILABLE) until the machine account exists, the generator is a deterministic producer. */
  adapterStatus: { FILE: 'PROPOSED', API_PUSH: 'MISSING', GENERATOR: 'MOCK' },
  kinds: FEED_KINDS,
  /** The positions of the file import framework, one per kind. */
  positions: FEED_POSITIONS,
  layouts: { versions: FEED_LAYOUT_VERSIONS, current: FEED_LAYOUT_VERSIONS[FEED_LAYOUT_VERSIONS.length - 1] ?? null, acceptance: 'PENDING_EXTERNAL' },
  pendingExternal: FEED_PENDING_EXTERNAL_ITEMS,
  /** Freshness: the governance rule type and code the health reads (built-in defaults registered by `registerFinanceFeedRules`). */
  freshness: { ruleType: 'CONNECTOR_FRESHNESS', ruleCode: 'FIN_FEED' },
  policy: { ruleType: 'FINANCE_FEED_POLICY', ruleCode: 'DEFAULT' },
  alertTypes: ['FEED_STALE', 'FEED_UNIT_LATE', 'FEED_DISCREPANCY_LARGE'],
  kpiCodes: ['FEED_COMPLETENESS', 'FEED_TIMELINESS', 'FEED_DISCREPANCY_RATE'],
  /** The role accountable for the connection. */
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  /** No adapter opens a connection: files are handed over, a push arrives from outside, the generator calls nothing. */
  egressPolicy: 'NONE',
  /** What reads the records, always through the reader and never an adapter. */
  consumers: ['PROVINCE_FACTS_READER', 'COMMITTEE_DASHBOARD', 'ALERT_CENTRE', 'KPI_REGISTER'],
  screens: ['FEED-01', 'FEED-02', 'FEED-03', 'FEED-04', 'FEED-05'],
} as const;
