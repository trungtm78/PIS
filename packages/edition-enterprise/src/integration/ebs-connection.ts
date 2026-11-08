/**
 * What the Integration Hub needs to know of the connection to Oracle EBS, in one place (ENT-2, mirrors `packages/kernel/src/egp-connection.ts`): data only, no logic, no import. The lead adapts it to the hub descriptor
 * at merge. The values are the ones the rules, the store and the controllers use (`ebs-connection.test.ts` holds them equal).
 */
export const EBS_CONNECTION_DESCRIPTOR = {
  code: 'ebs.ledger',
  /** Data enters the platform: a person hands over a file extracted from Oracle EBS. */
  direction: 'INBOUND',
  /** Only a file import exists; an API transport is added when the customer gives the access. */
  transportModes: ['FILE_IMPORT'],
  adapterStatus: 'PROPOSED',
  /** The position of the file import framework (`integration_cursor`, `file_import.connector_code`). */
  positions: ['EBS_LEDGER_FILE'],
  layouts: [{ version: 'WORKING-ASSUMPTION-2026.1', kind: 'LEDGER_EXTRACT', acceptance: 'PENDING_EXTERNAL' }],
  /** Freshness: the age of the last applied file against the rule `CONNECTOR_FRESHNESS` (code `EBS_FILE`), read through the governance port; every number is flagged unverified. */
  freshness: {
    ruleType: 'CONNECTOR_FRESHNESS',
    ruleCode: 'EBS_FILE',
    defaults: { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false },
    legalStatus: 'UNVERIFIED',
  },
  /** The working days an open difference has to be explained: the rule `EBS_RECONCILE_POLICY` (code `DEFAULT`). */
  reconcilePolicy: { ruleType: 'EBS_RECONCILE_POLICY', ruleCode: 'DEFAULT', defaults: { due_in_working_days: 5 } },
  alertTypes: ['CONNECTOR_STALE'],
  alertSource: 'CONNECTOR',
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  /** The file reader never opens a connection to anything. */
  egressPolicy: 'NONE',
  permissions: { read: 'ebs.read', admin: 'ebs.admin', import: 'ebs.import', preview: 'ebs.import.preview', reconcile: 'ebs.reconcile' },
  screens: ['EBS-01', 'EBS-02'],
  /** Who reads what the connection holds. */
  consumers: ['EBS-02 reconciliation by project code', 'ADM-11 audit trail', 'alert centre (source CONNECTOR)'],
} as const;
