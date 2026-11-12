/**
 * The server entry of the enterprise edition package (RPT-1): everything that needs the kernel's rule registry, the Excel and Word libraries or the report engine, kept apart from `index.ts` so that the web build,
 * which reads the manifest through `index.ts`, never pulls them in. The only file that loads this entry is the API's enterprise seam (`apps/api/src/editions/load-enterprise.ts`), which calls
 * `registerEnterpriseReportRules()` once: that adds the enterprise indicator pack under `KPI_DEFINITION` and the rule type `REPORT_FORM_MODE` to the registry of the process.
 */
export * from './report-forms/exports.ts';
export { ENTERPRISE_AI_POLICY, clearEnterpriseAiPolicy, registerEnterpriseAiPolicy } from './ai-policy.ts';
// The connections of the enterprise edition (ENT-2): the push of issued reports to HPM and the file import and reconciliation of Oracle EBS; the rules, the ports and the stores, with the rules and alert types they register.
export * from './integration/exports.ts';
// The leadership dashboard of the enterprise edition (ENT-4d): rates against the annual plan by company, unit and project with the same period of last year, and the projects blocked on procedure.
export * from './leader/exports.ts';
// The scheduled e-mail delivery of issued report forms (ENT-4d).
export * from './delivery/exports.ts';
// The organisation pack of the enterprise edition (ENT-3d): the PVFCCo template, the store that loads and verifies it, and the registration of its mapping and verifier in the batch import.
export * from './org-pack/exports.ts';
// The ports to the eProcurement system and to the registry of documents (CN.02, TH.03, PX-06, PX-07): working-assumption layouts, fake adapters, no connection.
export * from './external/exports.ts';
