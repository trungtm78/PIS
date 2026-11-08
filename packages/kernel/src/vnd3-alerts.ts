/**
 * The alert types of lane VND-3 (docs/vendor-investigation.md section 9), read by `HomeVendor3Sources` when the alert centre is read (no job): a lead for the auditors (V-A5, auditors only), a hit of the screening (V-A14),
 * a re-confirmation due or lapsed (V-A15), a request to a contractor that is waiting or answered, and an action of a remediation plan that is late. The severity of a facet is a starting value that a tenant changes on the alert type.
 */
export const VND3_ALERT_CODES = ['VENDOR_LINK_LEAD', 'VENDOR_SCREENING_HIT', 'VENDOR_RECONFIRM_OVERDUE', 'VENDOR_PORTAL_REQUEST', 'VENDOR_REMEDIATION_ACTION'] as const;
export type Vnd3AlertCode = (typeof VND3_ALERT_CODES)[number];

export const VND3_FACET_SEVERITY: Readonly<Record<string, 'URGENT' | 'ACTION' | 'WATCH'>> = {
  LEAD_NEW: 'WATCH',
  LEAD_HIGH: 'ACTION',
  SCREENING_HOLD: 'URGENT',
  SCREENING_HIT: 'ACTION',
  RECONFIRM_DUE: 'WATCH',
  RECONFIRM_OVERDUE: 'ACTION',
  REQUEST_ANSWERED: 'ACTION',
  REQUEST_DUE_SOON: 'WATCH',
  REQUEST_OVERDUE: 'ACTION',
  REMEDIATION_DUE: 'WATCH',
  REMEDIATION_OVERDUE: 'ACTION',
};

/** The permissions the audiences of these alerts read them with (whole tenant): the auditors for leads, the approvers of the register for the rest. */
export const VND3_AUDIENCE_PERMISSIONS = {
  lead: 'vnd.lead.read',
  screening: 'vnd.screening.decide',
  reconfirm: 'vnd.portal.manage',
  request: 'vnd.portal.manage',
  remediation: 'vnd.remediation.manage',
} as const;

/** The screens of the lane: VND-01 to VND-06 belong to VND-1 and VND-07 to VND-12 to VND-2 (running in parallel), so these start at 13. */
export const VND3_SCREENS = { leads: 'VND-13', lead: 'VND-14', screening: 'VND-15', portalHome: 'VND-16', portalRequests: 'VND-17', portalCertificates: 'VND-18', portalEvaluations: 'VND-19', portalManage: 'VND-20', remediation: 'VND-21', disputes: 'VND-22' } as const;
