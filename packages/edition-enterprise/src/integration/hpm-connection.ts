/**
 * What the Integration Hub needs to know of the connection to HPM, in one place (ENT-2, mirrors `packages/kernel/src/egp-connection.ts`): data only, no logic, no import. The lead adapts it to the hub descriptor
 * at merge. The values are the ones the rules, the store and the controllers use (`hpm-connection.test.ts` holds them equal).
 */
export const HPM_CONNECTION_DESCRIPTOR = {
  code: 'hpm.reports',
  /** Reports leave the platform: it pushes issued copies to the reporting platform of the customer. */
  direction: 'OUTBOUND',
  /** Only a file writer exists; an API transport is added when the customer publishes the interface of HPM. */
  transportModes: ['FILE_EXPORT'],
  adapterStatus: 'PROPOSED',
  layouts: [{ version: 'HPM-FILE-WORKING-ASSUMPTION-2026.1', kind: 'DELIVERY_PACKAGE', acceptance: 'PENDING_EXTERNAL' }],
  /** Freshness: the age of the last delivery against the rule `HPM_PUSH_POLICY` (code `DEFAULT`), read through the governance port; every number is flagged unverified. */
  freshness: {
    ruleType: 'HPM_PUSH_POLICY',
    ruleCode: 'DEFAULT',
    defaults: { max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' },
    legalStatus: 'UNVERIFIED',
  },
  alertTypes: ['HPM_PUSH_FAILED', 'HPM_PUSH_STALE'],
  alertSource: 'CONNECTOR',
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  /** The file writer never opens a connection to anything. */
  egressPolicy: 'NONE',
  permissions: { read: 'hpm.read', admin: 'hpm.admin', push: 'hpm.push', receipt: 'hpm.receipt' },
  screens: ['HPM-01', 'HPM-02'],
  /** Who reads what the connection holds. */
  consumers: ['RPT-1 issued copies (the reports it pushes)', 'ADM-11 audit trail', 'alert centre (source CONNECTOR)'],
} as const;
