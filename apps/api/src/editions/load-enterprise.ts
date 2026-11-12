import { SchedulePeriodLockGate, registerEditionPeriodLockGate } from '@machvon/db';
import { MOF_LAYOUTS } from '@machvon/kernel';
import type { EditionManifest, TenantContext } from '@machvon/kernel';
import { REPORT_FORMS } from '../modules/reports/form-registry';
import type { ModuleDescriptor } from '../modules/module-descriptor';
import type { ReportMailJobDeps } from './enterprise/report-mail-job.ts';

/** The configured form (a REPORT_LAYOUT rule) that asks the offices of a province for figures: a public-edition form. */
const PUBLIC_ONLY_CONFIGURED_FORM = 'CFG_AGENCY_REQUEST';

/**
 * DEMO-09: the forms that belong to the public edition (the four for the Ministry of Finance, the request to the offices of a province) are not in the catalogue of the enterprise; the public process lists them as before.
 * The loader calls it, and so does the test of the enterprise catalogue, so the test asserts what the real process does.
 */
export function hidePublicOnlyReportForms(): void {
  REPORT_FORMS.hide([...MOF_LAYOUTS.map((layout) => layout.code), PUBLIC_ONLY_CONFIGURED_FORM]);
}

/**
 * The one place of the API that names the enterprise package (ENT-0, structure B). The package is loaded only when the process serves
 * the enterprise edition, so a public process never loads it; `npm run edition:check` and the module-boundary rules allow this file
 * and no other shared one to name it. The package is resolved through the workspace (it is not a dependency of `@machvon/api` on purpose).
 */
export async function loadEnterpriseManifest(): Promise<EditionManifest> {
  const { ENTERPRISE_EDITION } = await import('@machvon/edition-enterprise');
  // The server entry of the package (RPT-1): adds the enterprise indicator pack and the rule type REPORT_FORM_MODE to the rule registry of this process. The web build never reads it.
  // ENT-2 adds the rules, the alert types and the alert readers of the connections to HPM and Oracle EBS (registered once, like the rules of the forms).
  const { enterpriseReportBundles, registerEnterpriseAiPolicy, registerEnterpriseCatalogueRules, registerEnterpriseIntegrationRules, registerEnterpriseOrgPack, registerEnterpriseReportRules } = await import('@machvon/edition-enterprise/src/server.ts');
  registerEnterpriseReportRules();
  registerEnterpriseIntegrationRules();
  // The catalogues of the enterprise project register (ENT-3e): types of project, flag of the stage, milestones of the investment life, types of legal document, and the project types for the master catalogue.
  registerEnterpriseCatalogueRules();
  // ENT-3d: the mapping and the verifier of the organisation pack file join the batch import of this process (the workers run in it).
  registerEnterpriseOrgPack();
  // Where the AI of the process runs (R5): on the servers of the customer, an outside provider only under an approved exception; the gateway reads the policy at every request.
  registerEnterpriseAiPolicy();
  // INT-2: the job that locks periods waits for the review of the planning board and the close of the schedule before it locks a month, a quarter or a year (a public process keeps the three working days alone).
  registerEditionPeriodLockGate(new SchedulePeriodLockGate());
  // The six demo forms join the catalogue of this process (RPT-1 part 2); a public process never reaches this line.
  // ENT-3a: the provider that fills them from the frozen enterprise period snapshot of the period when there is one.
  const { EnterpriseSnapshotProvider } = await import('./enterprise/snapshot-provider.ts');
  REPORT_FORMS.registerProvider(new EnterpriseSnapshotProvider());
  for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
  hidePublicOnlyReportForms();
  return ENTERPRISE_EDITION.manifest;
}

/**
 * The modules of the enterprise edition (ENT-2): the connections to HPM and to Oracle EBS, whose controllers live in `./enterprise` (that folder is a seam of the process like this file: with this file, the only API code that may import the enterprise package). The process
 * hands them to the application module with the manifest, so the registry of modules names none of them and a public process never loads them.
 */
export async function loadEnterpriseModules(): Promise<readonly ModuleDescriptor[]> {
  await loadEnterpriseManifest();
  const { ENTERPRISE_API_MODULES } = await import('./enterprise/index.ts');
  return ENTERPRISE_API_MODULES;
}

/** The job that mails the issued report forms by schedule (ENT-4d): built only for the enterprise edition, on the channel port of the process. */
export async function loadReportMailJob(deps: ReportMailJobDeps): Promise<{ run(ctx: TenantContext, now: Date): Promise<unknown> }> {
  const { createReportMailJob } = await import('./enterprise/report-mail-job.ts');
  return createReportMailJob(deps);
}
