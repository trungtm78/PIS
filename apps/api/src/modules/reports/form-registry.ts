import { DIS_WEEKLY_LAYOUT, DomainError, validateLayout } from '@machvon/kernel';
import type { EffectiveAccess, ReportFormBundle } from '@machvon/kernel';
import { DIS_WEEKLY_LAYOUT, DomainError, MOF_LAYOUTS, MOF_RECEIVER, mofFormOf, validateLayout } from '@machvon/kernel';
import type { ReportFormBundle } from '@machvon/kernel';
import { buildBlankTemplate } from './blank-template';
import { DIS_HOME_PROVIDER, DisHomeProvider } from './figure-provider';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import type { ReportFigureProvider } from './figure-provider';
import { registerCommitteeReportForm } from '../committee/pack-provider';

/**
 * The forms a process offers and the providers of their figures (RPT-1 part 2). A form is a `ReportFormBundle`: the public edition's generic forms are registered by this module, the enterprise forms by the
 * server entry of the enterprise package through the enterprise seam of the API (`editions/load-enterprise.ts`), so a public process never holds an enterprise form (`npm run edition:check`).
 * A registered form is copied into the tenant's own rows when someone first generates it (`report_layout`), so what was issued stays reproducible even if the bundle changes in a later release.
 */
export class ReportFormRegistry {
  private readonly forms = new Map<string, ReportFormBundle>();
  private readonly providers = new Map<string, ReportFigureProvider>();
  private readonly guards = new Map<string, string>();

  /** Adds a form. A code is registered once with one layout version; a DEMO form must be illustrative, a form with live figures names a provider the process has. */
  register(bundle: ReportFormBundle): void {
    validateLayout(bundle.layout);
    const code = bundle.layout.code;
    const known = this.forms.get(code);
    if (known !== undefined) {
      if (known.layout.version === bundle.layout.version && known.edition === bundle.edition) return;
      throw new DomainError('VALIDATION_FAILED', 422, 'report_form_registered_twice');
    }
    if (bundle.layout.status === 'DEMO' && (bundle.dataSource !== 'ILLUSTRATIVE' || bundle.illustrative === undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'demo_form_data');
    if (bundle.dataSource === 'ILLUSTRATIVE' && bundle.layout.status !== 'DEMO') throw new DomainError('VALIDATION_FAILED', 422, 'illustrative_not_demo');
    if (bundle.dataSource === 'LIVE' && (bundle.provider === null || bundle.illustrative !== undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'live_form_provider');
    this.forms.set(code, bundle);
  }

  registerProvider(provider: ReportFigureProvider): void {
    // A provider id is registered once: a second registration of the same id (the process loading twice) keeps the first.
    if (!this.providers.has(provider.id)) this.providers.set(provider.id, provider);
  }

  /** A form whose figures are confidential to a body (the meeting pack of the committee) names the permission over the whole tenant that its drafts, copies and files need besides the permissions of the engine. */
  guard(layoutCode: string, permission: string): void {
    this.guards.set(layoutCode, permission);
  }

  guardOf(layoutCode: string): string | undefined {
    return this.guards.get(layoutCode);
  }

  get(code: string): ReportFormBundle | undefined {
    return this.forms.get(code);
  }

  provider(id: string): ReportFigureProvider | undefined {
    return this.providers.get(id);
  }

  /** The forms in the order of their codes. */
  list(): ReportFormBundle[] {
    return [...this.forms.values()].sort((a, b) => a.layout.code.localeCompare(b.layout.code));
  }

  /** Only for tests: forgets every form and provider. */
  clear(): void {
    this.forms.clear();
    this.providers.clear();
    this.guards.clear();
  }
}

/** The registry of the process. */
export const REPORT_FORMS = new ReportFormRegistry();

/** Whether the caller may see drafts and copies of the form: the guard of the form, when it has one, is a permission over the whole tenant. */
export const layoutReadable = (access: EffectiveAccess, layoutCode: string): boolean => {
  const permission = REPORT_FORMS.guardOf(layoutCode);
  return permission === undefined || holdsOnWholeTenant(access, permission);
};

export function assertLayoutAccess(access: EffectiveAccess, layoutCode: string): void {
  if (!layoutReadable(access, layoutCode)) throw new DomainError('SCOPE_DENIED', 403);
}
/** The figures of the periodic forms for the Ministry: the snapshot that stood at the end of the period of the report. */
export const MOF_PROVIDER = 'MOF_DIS';

/** The generic forms of the public edition: the weekly disbursement report, read from the command center through its provider. Calling it again changes nothing. */
export function registerPublicReportForms(registry: ReportFormRegistry = REPORT_FORMS): void {
  registry.registerProvider(new DisHomeProvider());
  registry.register({
    edition: 'public',
    layout: DIS_WEEKLY_LAYOUT,
    narrative: null,
    receiver: 'INTERNAL',
    periodKind: 'AS_OF',
    dataSource: 'LIVE',
    provider: DIS_HOME_PROVIDER,
    templates: async () => ({ xlsx: await buildBlankTemplate(DIS_WEEKLY_LAYOUT), docx: null }),
  });
  registerCommitteeReportForm(registry);
}

/**
 * The four forms for the Ministry of Finance (GOV-12, G4-6): PENDING_EXTERNAL layouts built from the indicators of the register, with live figures from the snapshot at the end of the period. They can be drafted and read; they cannot be
 * issued until the official template is supplied and a new READY version of the same code is registered (see docs/report-engine.md). Calling it again changes nothing.
 */
export function registerMofReportForms(registry: ReportFormRegistry = REPORT_FORMS): void {
  registry.registerProvider(new DisHomeProvider(MOF_PROVIDER, true));
  for (const layout of MOF_LAYOUTS) {
    const form = mofFormOf(layout.code);
    if (form === undefined) continue;
    registry.register({ edition: 'public', layout, narrative: null, receiver: MOF_RECEIVER, periodKind: form.periodKind, dataSource: 'LIVE', provider: MOF_PROVIDER, templates: async () => ({ xlsx: await buildBlankTemplate(layout), docx: null }) });
  }
}
