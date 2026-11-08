import { MANUAL_SCHEDULE } from '@machvon/kernel';
import type { ConnectorDescriptor, PipelineSpec } from '@machvon/kernel';
import { EBS_CONNECTOR_CODE, EBS_FILE_POSITION, EBS_LAYOUT_VERSION, EBS_SOURCE_SYSTEM, ebsAcceptance } from './ebs-rules.ts';
import { HPM_CONNECTOR_CODE, HPM_PACKAGE_FORMAT, hpmAcceptance } from './hpm-rules.ts';

/**
 * The Integration Hub descriptors of the two connections of the enterprise edition (HUB-2): HPM (reports go out) and Oracle EBS (the ledger comes in). They are plain data, registered with the hub when the edition
 * loads (`registerEnterpriseIntegrationRules`), so a public process never lists them. The numbers repeat the ones of the rules and `hub-descriptors.test.ts` holds them equal.
 */

const pipeline = (layoutCode: string, layoutVersion: string, name: string, target: string): PipelineSpec => ({
  code: layoutCode,
  name,
  protocol: 'FILE_DROP',
  mode: 'INCREMENTAL',
  layoutCode,
  layoutVersion,
  target,
  schedule: MANUAL_SCHEDULE,
});

/** The freshness code of the push to HPM under the rule type CONNECTOR_FRESHNESS: the same numbers as the rule `HPM_PUSH_POLICY` (`warn_after_hours`, `max_age_hours`, `stale_severity`). */
export const HPM_FRESHNESS_RULE_CODE = 'HPM_PUSH';

export const HPM_DESCRIPTOR: ConnectorDescriptor = {
  code: HPM_CONNECTOR_CODE,
  name: 'HPM reporting platform: delivery of issued reports',
  direction: 'OUTBOUND',
  protocols: ['FILE_DROP'],
  plannedProtocols: ['HTTPS_REST'],
  pipelines: [pipeline('DELIVERY_PACKAGE', HPM_PACKAGE_FORMAT, 'HPM delivery package', 'hpm.push.deliver')],
  layouts: [{ code: 'DELIVERY_PACKAGE', version: HPM_PACKAGE_FORMAT, acceptance: hpmAcceptance(HPM_PACKAGE_FORMAT) === 'PENDING_EXTERNAL' ? 'PENDING_EXTERNAL' : 'ACCEPTED', pending: ['HPM_INTERFACE_SPECIFICATION'] }],
  freshness: { ruleCode: HPM_FRESHNESS_RULE_CODE, defaults: { maxAgeHours: 1080, warnAfterHours: 720, staleSeverity: 'ACTION', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['RPT', 'HPM', 'HOME'],
  alertTypes: ['HPM_PUSH_FAILED', 'HPM_PUSH_STALE'],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['HPM-01', 'HPM-02'],
  ledger: { kind: 'HUB_RUNS', positions: [], sourceSystems: [], stateOwner: 'CONNECTOR' },
  sources: ['packages/edition-enterprise/src/integration/hpm-rules.ts', 'packages/edition-enterprise/src/integration/hpm-port.ts', 'packages/edition-enterprise/src/integration/hpm-store.ts'],
};

export const EBS_DESCRIPTOR: ConnectorDescriptor = {
  code: EBS_CONNECTOR_CODE,
  name: 'Oracle EBS: ledger extract and reconciliation',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  plannedProtocols: ['DB_READ'],
  pipelines: [pipeline('LEDGER_EXTRACT', EBS_LAYOUT_VERSION, 'Oracle EBS ledger extract', 'ebs.ledger.apply')],
  layouts: [{ code: 'LEDGER_EXTRACT', version: EBS_LAYOUT_VERSION, acceptance: ebsAcceptance(EBS_LAYOUT_VERSION) === 'PENDING_EXTERNAL' ? 'PENDING_EXTERNAL' : 'ACCEPTED', pending: ['EBS_EXTRACT_SAMPLE'] }],
  freshness: { ruleCode: 'EBS_FILE', defaults: { maxAgeHours: 168, warnAfterHours: 120, staleSeverity: 'WATCH', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['EBS', 'HOME'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['EBS-01', 'EBS-02'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: [EBS_FILE_POSITION], sourceSystems: [EBS_SOURCE_SYSTEM], stateOwner: 'CONNECTOR' },
  sources: ['packages/edition-enterprise/src/integration/ebs-rules.ts', 'packages/edition-enterprise/src/integration/ebs-store.ts'],
};

/** The connectors of the enterprise edition, in the order the catalogue shows them. */
export const ENTERPRISE_CONNECTORS: readonly ConnectorDescriptor[] = [HPM_DESCRIPTOR, EBS_DESCRIPTOR];
