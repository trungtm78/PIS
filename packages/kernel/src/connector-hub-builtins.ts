import { EGP_CONNECTOR_CODE, EGP_FRESHNESS_RULE_CODE, EGP_LAYOUT_KINDS, EGP_LAYOUT_VERSION, EGP_SOURCE_SYSTEM, egpAcceptance } from './egp.ts';
import { EGP_POSITIONS } from './egp-connection.ts';
import { NATIONAL_CODE_CONNECTOR, NATIONAL_CODE_FORMAT_VERSION } from './national-code-file.ts';
import { PROCUREMENT_CONNECTOR, PROCUREMENT_FORMAT_VERSION } from './procurement-file.ts';
import { connectorDescriptor, registerConnector } from './connector-hub.ts';
import type { ConnectorDescriptor, ConnectorLayout } from './connector-hub.ts';
import { MANUAL_SCHEDULE } from './etl-pipeline.ts';
import type { PipelineSpec } from './etl-pipeline.ts';

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

/** The descriptors of what exists on main, in the order the catalogue shows them. */
export const BUILT_IN_CONNECTORS: readonly ConnectorDescriptor[] = [EGP_DESCRIPTOR, TREASURY_DESCRIPTOR, PROCUREMENT_MILESTONES_DESCRIPTOR, NATIONAL_CODES_DESCRIPTOR];

/** Registers the built-in connectors; safe to call again (a connector that is already registered is left as it is). The API module and the tests of the hub call it. */
export function registerBuiltInConnectors(): void {
  for (const descriptor of BUILT_IN_CONNECTORS) {
    if (connectorDescriptor(descriptor.code) === undefined) registerConnector(descriptor);
  }
}
