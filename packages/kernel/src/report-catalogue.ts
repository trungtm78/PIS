import { DomainError } from './errors.ts';
import { RECEIVER_CODE } from './report-form.ts';
import { REPORT_PERIOD_KINDS } from './report-layout.ts';
import type { FormPeriodKind, ReportFormEntry } from './report-layout.ts';

/**
 * The catalogue of the report forms, the report types and the agencies that receive them as a managed list (MD.03). Until now the six forms of the enterprise edition, their receivers and their period kinds were
 * constants of the code (`REPORT_FORM_CATALOGUE`). A tenant now keeps them as entries of the master catalogues `REPORT_TYPE` (which form, which period) and `RECEIVING_AGENCY` (which types it receives, the code its
 * deliveries are logged under), and this module is the pure rule that reads them: the receiver of a form is the agency that lists the type of the form, the code stays the default for a form the catalogue does not
 * mention, and a disagreement between the two is reported, never settled silently. A tenant that manages nothing keeps the behaviour of the code, receiver for receiver.
 */

/** One published entry of a master catalogue, reduced to what this rule reads. */
export interface CatalogueEntry {
  key: string;
  label: string;
  attributes: Readonly<Record<string, unknown>>;
}

export interface ManagedReportCatalogue {
  periodKinds: readonly CatalogueEntry[];
  reportTypes: readonly CatalogueEntry[];
  agencies: readonly CatalogueEntry[];
}

export type FormSource = 'MANAGED' | 'CODE_DEFAULT';
export type CatalogueProblem = 'NO_AGENCY' | 'AGENCY_NOT_UNIQUE' | 'PERIOD_UNKNOWN' | 'PERIOD_MISMATCH';

export interface CatalogueForm {
  code: string;
  name: string;
  receiver: string;
  period: FormPeriodKind;
  source: FormSource;
  reportTypeKey: string | null;
  agencyKey: string | null;
  problems: CatalogueProblem[];
}

export interface ReportCatalogueView {
  /** Whether the tenant keeps any report type or agency of its own. */
  managed: boolean;
  forms: CatalogueForm[];
  /** The receivers a delivery may be logged under, sorted: those of the agencies and those of the forms. */
  receivers: string[];
}

/** The code a delivery to the agency is logged under: `receiver_code` when the entry has one, else its key. */
export function agencyReceiverOf(agency: CatalogueEntry): string {
  const code = agency.attributes.receiver_code;
  return typeof code === 'string' && RECEIVER_CODE.test(code) ? code : agency.key;
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The period kind of a form that a grain of the catalogue stands for; a meeting has no length, so no form is made for it. */
function periodOfGrain(grain: string | undefined): FormPeriodKind | undefined {
  return grain !== undefined && grain !== 'MEETING' && (REPORT_PERIOD_KINDS as readonly string[]).includes(grain) ? (grain as FormPeriodKind) : undefined;
}

function agenciesOfType(agencies: readonly CatalogueEntry[], typeKey: string): CatalogueEntry[] {
  return agencies.filter((agency) => Array.isArray(agency.attributes.report_type_keys) && (agency.attributes.report_type_keys as unknown[]).includes(typeKey));
}

function formOf(form: ReportFormEntry, catalogue: ManagedReportCatalogue): CatalogueForm {
  const base: CatalogueForm = { code: form.code, name: form.name, receiver: form.receiver, period: form.period, source: 'CODE_DEFAULT', reportTypeKey: null, agencyKey: null, problems: [] };
  const type = catalogue.reportTypes.find((one) => one.attributes.form_code === form.code);
  if (type === undefined) return base;
  const problems: CatalogueProblem[] = [];
  const periodKind = catalogue.periodKinds.find((one) => one.key === textOf(type.attributes.period_kind_key));
  if (periodKind === undefined) problems.push('PERIOD_UNKNOWN');
  else if (periodOfGrain(textOf(periodKind.attributes.grain)) !== form.period) problems.push('PERIOD_MISMATCH');
  const agencies = agenciesOfType(catalogue.agencies, type.key);
  if (agencies.length === 0) problems.push('NO_AGENCY');
  if (agencies.length > 1) problems.push('AGENCY_NOT_UNIQUE');
  // One agency settles the receiver; none or several leave it with the code, which is what the report was always delivered under.
  const agency = agencies.length === 1 ? (agencies[0] as CatalogueEntry) : undefined;
  return { ...base, receiver: agency === undefined ? form.receiver : agencyReceiverOf(agency), source: 'MANAGED', reportTypeKey: type.key, agencyKey: agency?.key ?? null, problems };
}

/** The forms of the code as the tenant's catalogue sees them, and the receivers a delivery may go to. */
export function reportCatalogueView(catalogue: ManagedReportCatalogue, defaults: readonly ReportFormEntry[]): ReportCatalogueView {
  const forms = defaults.map((form) => formOf(form, catalogue));
  const receivers = new Set<string>([...catalogue.agencies.map(agencyReceiverOf), ...forms.map((form) => form.receiver)]);
  return { managed: catalogue.agencies.length > 0 || catalogue.reportTypes.length > 0, forms, receivers: [...receivers].sort() };
}

/** A delivery is logged under a receiver the catalogue knows; a tenant that manages nothing takes any well-formed one, as before. 422 `VALIDATION_FAILED` naming `receiver`. */
export function assertReceiverKnown(view: ReportCatalogueView, receiver: string): void {
  if (view.managed && !view.receivers.includes(receiver)) throw new DomainError('VALIDATION_FAILED', 422, 'receiver');
}
