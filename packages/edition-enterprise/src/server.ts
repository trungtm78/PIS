/**
 * The server entry of the enterprise edition package (RPT-1): everything that needs the kernel's rule registry, the Excel and Word libraries or the report engine, kept apart from `index.ts` so that the web build,
 * which reads the manifest through `index.ts`, never pulls them in. The only file that loads this entry is the API's enterprise seam (`apps/api/src/editions/load-enterprise.ts`), which calls
 * `registerEnterpriseReportRules()` once: that adds the enterprise indicator pack under `KPI_DEFINITION` and the rule type `REPORT_FORM_MODE` to the registry of the process.
 */
export * from './report-forms/exports.ts';
