import type { EditionManifest } from '@machvon/kernel';
import { REPORT_FORMS } from '../modules/reports/form-registry';
import type { ModuleDescriptor } from '../modules/module-descriptor';

/**
 * The one place of the API that names the enterprise package (ENT-0, structure B). The package is loaded only when the process serves
 * the enterprise edition, so a public process never loads it; `npm run edition:check` and the module-boundary rules allow this file
 * and no other shared one to name it. The package is resolved through the workspace (it is not a dependency of `@machvon/api` on purpose).
 */
export async function loadEnterpriseManifest(): Promise<EditionManifest> {
  const { ENTERPRISE_EDITION } = await import('@machvon/edition-enterprise');
  // The server entry of the package (RPT-1): adds the enterprise indicator pack and the rule type REPORT_FORM_MODE to the rule registry of this process. The web build never reads it.
  // ENT-2 adds the rules, the alert types and the alert readers of the connections to HPM and Oracle EBS (registered once, like the rules of the forms).
  const { enterpriseReportBundles, registerEnterpriseAiPolicy, registerEnterpriseIntegrationRules, registerEnterpriseReportRules } = await import('@machvon/edition-enterprise/src/server.ts');
  registerEnterpriseReportRules();
  registerEnterpriseIntegrationRules();
  // Where the AI of the process runs (R5): on the servers of the customer, an outside provider only under an approved exception; the gateway reads the policy at every request.
  registerEnterpriseAiPolicy();
  // The six demo forms join the catalogue of this process (RPT-1 part 2); a public process never reaches this line.
  for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
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
