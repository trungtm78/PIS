import type { EditionManifest } from '@machvon/kernel';
import { REPORT_FORMS } from '../modules/reports/form-registry';

/**
 * The one place of the API that names the enterprise package (ENT-0, structure B). The package is loaded only when the process serves
 * the enterprise edition, so a public process never loads it; `npm run edition:check` and the module-boundary rules allow this file
 * and no other shared one to name it. The package is resolved through the workspace (it is not a dependency of `@machvon/api` on purpose).
 */
export async function loadEnterpriseManifest(): Promise<EditionManifest> {
  const { ENTERPRISE_EDITION } = await import('@machvon/edition-enterprise');
  // The server entry of the package (RPT-1): adds the enterprise indicator pack and the rule type REPORT_FORM_MODE to the rule registry of this process. The web build never reads it.
  const { enterpriseReportBundles, registerEnterpriseReportRules } = await import('@machvon/edition-enterprise/src/server.ts');
  registerEnterpriseReportRules();
  // The six demo forms join the catalogue of this process (RPT-1 part 2); a public process never reaches this line.
  for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
  return ENTERPRISE_EDITION.manifest;
}
