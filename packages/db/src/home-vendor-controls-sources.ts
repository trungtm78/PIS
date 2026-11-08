import { alphaVendorAlerts } from './home-vendor-alpha-sources.ts';
import { betaVendorAlerts } from './home-vendor-beta-sources.ts';
import { gammaVendorAlerts } from './home-vendor-gamma-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/**
 * The alerts of the controls of contractors and suppliers (lane VND-2; docs/vendor-controls.md) as one list for the source `VENDOR` of the alert centre: independence findings and the finance and load signals, bid security
 * expiry and subcontract breaches and unconfirmed payments, and the grade review, the performance publication, the answers to review and the streak of poor ratings. Each part reads its own tables and its own rules
 * through `VendorPolicyReader` when the list is read (no job), and filters its rows for the audience that owns the alert type.
 */
export class HomeVendorControlsSources {
  async items(context: SourceContext): Promise<SourceRow[]> {
    return [...(await alphaVendorAlerts(context)), ...(await betaVendorAlerts(context)), ...(await gammaVendorAlerts(context))];
  }
}
