import { KPI_RULE_TYPE, kpiDefinitionOf } from './kpi-register.ts';
import type { KpiDefinition } from './kpi-register.ts';
import type { GovernanceRuleVersion, ResolvedGovernanceRule } from './governance-rules.ts';
import { isEntrySurface, isIndicatorCategory, INDICATOR_VALUE_KINDS, VAT_BASES } from './ind-definitions.ts';
import type { EntrySurface, IndicatorCategory, IndicatorValueKind, VatBasis } from './ind-definitions.ts';

/**
 * The indicator dictionary (IND-1, DL.02). It does not hold a second copy of anything: an indicator is the `KPI_DEFINITION` rule of its code (name, unit, formula, owner, version, approval, effective days all
 * come from `kpi-register.ts`) with the optional members that tell how the figure is obtained and entered. A KPI with none of them reads as a derived figure of the command centre and cannot be entered.
 */

export interface IndicatorEntry extends KpiDefinition {
  category: IndicatorCategory | null;
  valueKind: IndicatorValueKind;
  /** The name of the figure in the facts of an entry rule. */
  entryField: string | null;
  vatBasis: VatBasis | null;
  aliases: string[];
  requiredOn: EntrySurface[];
}

const isKind = (value: unknown): value is IndicatorValueKind => (INDICATOR_VALUE_KINDS as readonly unknown[]).includes(value);
const isVat = (value: unknown): value is VatBasis => (VAT_BASES as readonly unknown[]).includes(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** The indicator a resolved `KPI_DEFINITION` rule says. */
export function indicatorOf(resolved: ResolvedGovernanceRule, rules: readonly GovernanceRuleVersion[] = []): IndicatorEntry {
  const definition = kpiDefinitionOf(resolved, rules);
  const params = resolved.params;
  const category = params['category'];
  const entryField = params['entry_field'];
  return {
    ...definition,
    category: isIndicatorCategory(category) ? category : null,
    valueKind: isKind(params['value_kind']) ? params['value_kind'] : 'DERIVED',
    entryField: typeof entryField === 'string' && entryField !== '' ? entryField : null,
    vatBasis: isVat(params['vat_basis']) ? params['vat_basis'] : null,
    aliases: strings(params['aliases']),
    requiredOn: strings(params['required_on']).filter(isEntrySurface),
  };
}

export const INDICATOR_RULE_TYPE = KPI_RULE_TYPE;

/** A figure may be typed or loaded only when its definition says it is entered and gives the name it is entered under. */
export const isEnterable = (indicator: Pick<IndicatorEntry, 'valueKind' | 'entryField'>): boolean => indicator.valueKind === 'ENTERED' && indicator.entryField !== null;

/** A label of a form compared without regard to case, accents of composition and spaces (the accents of Vietnamese are part of the word and are kept). */
export const normalizeLabel = (label: string): string => label.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface DictionaryFilter {
  category?: IndicatorCategory | undefined;
  valueKind?: IndicatorValueKind | undefined;
  /** Only the figures that can be entered. */
  enterable?: boolean | undefined;
  /** Words of the code, the name or an alias. */
  text?: string | undefined;
}

/** The entries a filter lets through, in the order of their codes. */
export function filterDictionary(entries: readonly IndicatorEntry[], filter: DictionaryFilter): IndicatorEntry[] {
  const needle = filter.text === undefined ? '' : normalizeLabel(filter.text);
  return entries
    .filter((entry) => filter.category === undefined || entry.category === filter.category)
    .filter((entry) => filter.valueKind === undefined || entry.valueKind === filter.valueKind)
    .filter((entry) => filter.enterable !== true || isEnterable(entry))
    .filter((entry) => needle === '' || [entry.code, entry.name, ...entry.aliases].some((word) => normalizeLabel(word).includes(needle)))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export interface DictionaryFinding {
  code: 'ENTRY_FIELD_SHARED' | 'ALIAS_SHARED' | 'ENTERED_WITHOUT_FIELD' | 'DERIVED_WITH_FIELD';
  indicators: string[];
  detail: string;
}

/**
 * What a reader of the dictionary must settle before a form can be mapped to it: two indicators that share the name they are entered under or a name in the customer's forms (a column would be ambiguous), an
 * entered figure that has no field name (no rule can see it), and a derived figure that has one (it would invite an entry).
 */
export function dictionaryFindings(entries: readonly IndicatorEntry[]): DictionaryFinding[] {
  const found: DictionaryFinding[] = [];
  const byField = new Map<string, string[]>();
  const byAlias = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.entryField !== null) byField.set(entry.entryField, [...(byField.get(entry.entryField) ?? []), entry.code]);
    for (const alias of new Set([entry.name, ...entry.aliases].map(normalizeLabel))) byAlias.set(alias, [...(byAlias.get(alias) ?? []), entry.code]);
    if (entry.valueKind === 'ENTERED' && entry.entryField === null) found.push({ code: 'ENTERED_WITHOUT_FIELD', indicators: [entry.code], detail: entry.code });
    if (entry.valueKind === 'DERIVED' && entry.entryField !== null) found.push({ code: 'DERIVED_WITH_FIELD', indicators: [entry.code], detail: entry.entryField });
  }
  for (const [field, codes] of byField) if (codes.length > 1) found.push({ code: 'ENTRY_FIELD_SHARED', indicators: codes, detail: field });
  for (const [alias, codes] of byAlias) if (codes.length > 1) found.push({ code: 'ALIAS_SHARED', indicators: codes, detail: alias });
  return found.sort((a, b) => (a.code + a.detail < b.code + b.detail ? -1 : 1));
}

/** The fields the dictionary requires on a surface: the entry fields of the entered indicators that name it in `required_on`. */
export const mandatoryFieldsOf = (entries: readonly IndicatorEntry[], surface: EntrySurface): string[] =>
  entries
    .filter((entry) => isEnterable(entry) && entry.requiredOn.includes(surface))
    .map((entry) => entry.entryField as string)
    .sort();
