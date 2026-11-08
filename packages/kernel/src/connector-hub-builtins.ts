import { EGP_CONNECTOR_CODE, EGP_FRESHNESS_RULE_CODE, EGP_LAYOUT_KINDS, EGP_LAYOUT_VERSION, EGP_SOURCE_SYSTEM, egpAcceptance } from './egp.ts';
import { EGP_POSITIONS } from './egp-connection.ts';
import { NATIONAL_CODE_CONNECTOR, NATIONAL_CODE_FORMAT_VERSION } from './national-code-file.ts';
import { PROCUREMENT_CONNECTOR, PROCUREMENT_FORMAT_VERSION } from './procurement-file.ts';
import { connectorDescriptor, registerConnector } from './connector-hub.ts';
import type { ConnectorDescriptor, ConnectorLayout } from './connector-hub.ts';
import { protocolDefinition, registerProtocol } from './connector-protocols.ts';
import { MANUAL_SCHEDULE } from './etl-pipeline.ts';
import type { PipelineSpec } from './etl-pipeline.ts';
import { FEED_CONNECTOR_CODE, FEED_KINDS, FEED_LAYOUT_VERSION, FEED_POSITIONS, FEED_SOURCE_SYSTEM, feedAcceptance } from './finance-feed-model.ts';
import { INDICATOR_IMPORT_CONNECTOR } from './ind-import-mapping.ts';
import { ACCESS_CONNECTOR_CODE } from './integration-access-connection.ts';
import { OPEN_API_SCOPE_CODES } from './open-api.ts';

/**
 * The connectors that exist on main, written as descriptors (HUB-1). A lane that adds a connector writes one object like these and calls `registerConnector` (docs/integration-hub.md, "How a lane adds a
 * connector in 30 lines"); nothing else in the hub changes. The e-GP descriptor reads the constants of its own module, so a new layout version of `egp.ts` shows in the hub without an edit here.
 */

const TREASURY_FORMAT_VERSION = 'ASSUMED-2026.1';

/** The pipeline of a connector that takes one file at a time through the file import framework: one per layout, read from the drop, loaded by the connector's own apply step, run on demand. */
const filePipeline = (layout: Pick<ConnectorLayout, 'code' | 'version'>, name: string, target: string): PipelineSpec => ({
  code: layout.code,
  name,
  protocol: 'FILE_DROP',
  mode: 'INCREMENTAL',
  layoutCode: layout.code,
  layoutVersion: layout.version,
  target,
  schedule: MANUAL_SCHEDULE,
});

export const EGP_DESCRIPTOR: ConnectorDescriptor = {
  code: EGP_CONNECTOR_CODE,
  name: 'National e-procurement network (muasamcong)',
  direction: 'BOTH',
  protocols: ['FILE_DROP'],
  plannedProtocols: ['HTTPS_REST', 'SOAP_XML'],
  pipelines: EGP_LAYOUT_KINDS.map((kind) => filePipeline({ code: kind, version: EGP_LAYOUT_VERSION }, `e-GP ${kind} file`, 'egp.import.apply')),
  layouts: EGP_LAYOUT_KINDS.map((kind) => ({
    code: kind,
    version: EGP_LAYOUT_VERSION,
    acceptance: egpAcceptance(EGP_LAYOUT_VERSION) === 'PENDING_EXTERNAL' ? ('PENDING_EXTERNAL' as const) : ('ACCEPTED' as const),
    pending: [`SAMPLE_${kind}`],
  })),
  freshness: { ruleCode: EGP_FRESHNESS_RULE_CODE, defaults: { maxAgeHours: 168, warnAfterHours: 120, staleSeverity: 'WATCH', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['BID', 'CTR', 'HOME'],
  alertTypes: ['EGP_POSTING_DUE', 'EGP_POSTING_OVERDUE'],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['BID-22', 'BID-23', 'BID-24'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: EGP_LAYOUT_KINDS.map((kind) => EGP_POSITIONS[kind]), sourceSystems: [EGP_SOURCE_SYSTEM], stateOwner: 'CONNECTOR' },
  sources: ['packages/kernel/src/egp.ts', 'packages/kernel/src/egp-connection.ts', 'packages/db/src/egp-store.ts', 'packages/db/src/egp-import.ts'],
};

export const TREASURY_DESCRIPTOR: ConnectorDescriptor = {
  code: 'treasury.statement',
  name: 'State Treasury statement file',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  pipelines: [filePipeline({ code: 'STATEMENT', version: TREASURY_FORMAT_VERSION }, 'STATEMENT file', 'file-import.apply')],
  layouts: [{ code: 'STATEMENT', version: TREASURY_FORMAT_VERSION, acceptance: 'PENDING_EXTERNAL', pending: ['SAMPLE_STATEMENT'] }],
  freshness: { ruleCode: 'TREASURY_STATEMENT', defaults: { maxAgeHours: 72, warnAfterHours: 36, staleSeverity: 'ACTION', figuresBlockedWhenStale: true }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['PAY', 'DIS', 'HOME'],
  alertTypes: ['TREASURY_RECON_ITEM_OVERDUE'],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['PAY-13'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: ['TREASURY_STATEMENT_FILE'], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/db/src/pay-treasury-import-store.ts', 'packages/db/src/pay-treasury-statement-format.ts'],
};

export const NATIONAL_CODES_DESCRIPTOR: ConnectorDescriptor = {
  code: 'national.project_codes',
  name: 'National public investment system: project codes',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  pipelines: [filePipeline({ code: 'PROJECT_CODES', version: NATIONAL_CODE_FORMAT_VERSION }, 'PROJECT_CODES file', 'file-import.apply')],
  layouts: [{ code: 'PROJECT_CODES', version: NATIONAL_CODE_FORMAT_VERSION, acceptance: 'PENDING_EXTERNAL', pending: ['SAMPLE_PROJECT_CODES'] }],
  freshness: { ruleCode: NATIONAL_CODE_CONNECTOR, defaults: { maxAgeHours: 720, warnAfterHours: 504, staleSeverity: 'WATCH', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['PRJ', 'MNE'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['PRJ-21'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: [NATIONAL_CODE_CONNECTOR], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/kernel/src/national-code-file.ts', 'packages/db/src/prj-national-code-store.ts'],
};

export const PROCUREMENT_MILESTONES_DESCRIPTOR: ConnectorDescriptor = {
  code: 'procurement.milestones',
  name: 'Procurement milestone file (national procurement portal)',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  pipelines: [filePipeline({ code: 'MILESTONES', version: PROCUREMENT_FORMAT_VERSION }, 'MILESTONES file', 'file-import.apply')],
  layouts: [{ code: 'MILESTONES', version: PROCUREMENT_FORMAT_VERSION, acceptance: 'PENDING_EXTERNAL', pending: ['SAMPLE_MILESTONES'] }],
  freshness: { ruleCode: PROCUREMENT_CONNECTOR, defaults: { maxAgeHours: 336, warnAfterHours: 168, staleSeverity: 'WATCH', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['BID', 'CTR'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['BID-17', 'BID-19'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: [PROCUREMENT_CONNECTOR], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/kernel/src/procurement-file.ts', 'packages/db/src/bid-procurement-import.ts'],
};

/**
 * The protocol of a connection where THIS platform is the server: a machine account calls the open API with its client credentials, or a BI tool logs in to the reader views with its own database login. Nothing
 * leaves the machine (the other side opens the connection), so the egress class is NONE; the other side retries, so the delivery is at least once and every call is judged again. Registered here, once, because the
 * connectors that use it are built in.
 */
export const API_SERVE_PROTOCOL = 'API_SERVE';
if (protocolDefinition(API_SERVE_PROTOCOL) === undefined) {
  registerProtocol({
    code: API_SERVE_PROTOCOL,
    name: 'Served interface (open API for machine accounts, reader views for BI tools)',
    directions: ['INBOUND', 'OUTBOUND'],
    transport: 'API_PULL',
    security: { auth: ['OAUTH_CLIENT', 'DB_CREDENTIALS'], tls: 'REQUIRED', signature: 'NONE' },
    egress: 'NONE',
    failure: { retry: 'BACKOFF', maxAttempts: 3, idempotencyRequired: true, delivery: 'AT_LEAST_ONCE', watermarkAfterLoadOnly: true },
    formats: ['JSON', 'CSV'],
    configuration: ['rate_limit_per_minute', 'scopes', 'certified_datasets'],
    implementation: 'END_TO_END',
  });
}

/**
 * The Finance Department feed (FEED-1, `docs/finance-feed.md`): four record kinds that arrive as files today, from the generator of the platform, and later by a push of the Finance application with a machine account
 * (planned: the push adapter refuses until that interface is published). The switch is the connection's own (`finance_feed_connection`); the hub moves it through the state adapter.
 */
export const FINANCE_FEED_DESCRIPTOR: ConnectorDescriptor = {
  code: FEED_CONNECTOR_CODE,
  name: 'Provincial Finance Department feed',
  direction: 'INBOUND',
  protocols: ['FILE_DROP', 'GENERATOR'],
  plannedProtocols: ['WEBHOOK_INBOUND'],
  pipelines: FEED_KINDS.map((kind) => filePipeline({ code: kind, version: FEED_LAYOUT_VERSION }, `Finance feed ${kind} file`, 'finance.feed.apply')),
  layouts: FEED_KINDS.map((kind) => ({
    code: kind,
    version: FEED_LAYOUT_VERSION,
    acceptance: feedAcceptance(FEED_LAYOUT_VERSION) === 'PENDING_EXTERNAL' ? ('PENDING_EXTERNAL' as const) : ('ACCEPTED' as const),
    pending: [`FEED_SAMPLE_${kind}`],
  })),
  freshness: { ruleCode: 'FIN_FEED', defaults: { maxAgeHours: 48, warnAfterHours: 24, staleSeverity: 'ACTION', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['BAN', 'DIS', 'PRJ', 'HOME'],
  alertTypes: ['FEED_STALE', 'FEED_UNIT_LATE', 'FEED_DISCREPANCY_LARGE'],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['FEED-01', 'FEED-02', 'FEED-03', 'FEED-04', 'FEED-05'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: FEED_KINDS.map((kind) => FEED_POSITIONS[kind]), sourceSystems: [FEED_SOURCE_SYSTEM], stateOwner: 'CONNECTOR' },
  sources: ['packages/kernel/src/finance-feed-model.ts', 'packages/kernel/src/finance-feed.ts', 'packages/kernel/src/finance-feed-connection.ts', 'packages/db/src/finance-feed-store.ts', 'packages/db/src/finance-feed-import.ts'],
};

/**
 * The open interface (INT-1): the machine accounts of the open API and the logins of BI tools. The platform is the server; the hub keeps the credential side in view (accounts about to expire, secrets overdue,
 * rate limits hit) through a check run each hour, so a lapsed credential shows as a failing connector. No freshness: how old the data is, is not the question; a tenant that never opened the interface is NEVER_RUN.
 */
export const ACCESS_DESCRIPTOR: ConnectorDescriptor = {
  code: ACCESS_CONNECTOR_CODE,
  name: 'Open interface: machine accounts and BI reader views',
  direction: 'BOTH',
  protocols: [API_SERVE_PROTOCOL],
  layouts: [],
  freshness: null,
  credentials: { kind: 'MACHINE_ACCOUNT', scopes: OPEN_API_SCOPE_CODES },
  consumers: ['INT', 'BI', 'FEED'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['INT-01', 'INT-02', 'INT-03', 'INT-04', 'INT-05'],
  ledger: { kind: 'HUB_RUNS', positions: [], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/kernel/src/integration-access-connection.ts', 'packages/kernel/src/open-api.ts', 'packages/db/src/int-open-api-store.ts'],
};

/**
 * The Excel and CSV import of indicator figures (IND-1): a mapping approved by a second person says which column is which figure, so the layout is the tenant's own and has no acceptance of the outside. Runs are the
 * files of the file import framework (position `INDICATOR_IMPORT`); the import keeps no cursor row.
 */
export const INDICATOR_IMPORT_DESCRIPTOR: ConnectorDescriptor = {
  code: 'ind.figure-import',
  name: 'Indicator figures: Excel and CSV import',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  pipelines: [filePipeline({ code: 'INDICATOR_FIGURES', version: 'TENANT-MAPPING' }, 'Indicator figure file', 'ind.figure.apply')],
  layouts: [{ code: 'INDICATOR_FIGURES', version: 'TENANT-MAPPING', acceptance: 'NOT_APPLICABLE' }],
  freshness: null,
  credentials: { kind: 'NONE' },
  consumers: ['IND', 'MNE', 'BI'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['IND-03'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: [INDICATOR_IMPORT_CONNECTOR], sourceSystems: [], stateOwner: 'HUB', cursorless: true },
  sources: ['packages/kernel/src/ind-import-mapping.ts', 'packages/db/src/ind-import.ts', 'packages/db/src/ind-store.ts'],
};

/**
 * The bulk import of a master data catalogue (MDM, ST-MDM-006): a file mapped at upload is staged, applied as change requests and published as one batch. The batch keeps its own history; each applied batch is also
 * written to the run log of the hub through the shared port, so the catalogue shows the import with the rest.
 */
export const MASTER_IMPORT_CONNECTOR_CODE = 'mdm.catalogue-import';
export const MASTER_IMPORT_LAYOUT = { code: 'MASTER_FILE', version: 'TENANT-MAPPING' } as const;
export const MASTER_IMPORT_DESCRIPTOR: ConnectorDescriptor = {
  code: MASTER_IMPORT_CONNECTOR_CODE,
  name: 'Master data: bulk catalogue import',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  pipelines: [filePipeline(MASTER_IMPORT_LAYOUT, 'Master catalogue file', 'mdm.import.apply')],
  layouts: [{ ...MASTER_IMPORT_LAYOUT, acceptance: 'NOT_APPLICABLE' }],
  freshness: null,
  credentials: { kind: 'NONE' },
  consumers: ['MDM', 'PRJ', 'BID'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['MDM-29'],
  ledger: { kind: 'HUB_RUNS', positions: [], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/db/src/master-import-store.ts'],
};

/** The descriptors of what exists on main, in the order the catalogue shows them. The enterprise edition adds HPM and Oracle EBS when it loads. */
export const BUILT_IN_CONNECTORS: readonly ConnectorDescriptor[] = [
  EGP_DESCRIPTOR,
  TREASURY_DESCRIPTOR,
  PROCUREMENT_MILESTONES_DESCRIPTOR,
  NATIONAL_CODES_DESCRIPTOR,
  FINANCE_FEED_DESCRIPTOR,
  ACCESS_DESCRIPTOR,
  INDICATOR_IMPORT_DESCRIPTOR,
  MASTER_IMPORT_DESCRIPTOR,
];

/** Registers the built-in connectors; safe to call again (a connector that is already registered is left as it is). The API module and the tests of the hub call it. */
export function registerBuiltInConnectors(): void {
  for (const descriptor of BUILT_IN_CONNECTORS) {
    if (connectorDescriptor(descriptor.code) === undefined) registerConnector(descriptor);
  }
}
