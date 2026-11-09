import { AnalyticsGovernanceStore, GovernancePolicyPort } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { CONFIG_CODE_PATTERN, CONFIG_DEFAULT_PROVIDER, DomainError, REPORT_LAYOUT_RULE_TYPE, compileLayoutConfig, illustrativeLayoutData, layoutConfigOf } from '@machvon/kernel';
import type { LayoutConfig, ReportFormBundle, ReportIndicatorDefinition, ResolvedGovernanceRule } from '@machvon/kernel';
import { buildBlankTemplate } from './blank-template';
import { definitionOf } from './figure-provider';

/**
 * The forms a tenant configured without code (ENT-4b, R23). A configured form is a governance rule of the type `REPORT_LAYOUT` (versions, maker and approver apart, audit by the rule store); this module turns the
 * version in force on a day into a `ReportFormBundle` for the report engine: the layout from `compileLayoutConfig`, an Excel template built from the layout, and a provider for the figures. The bundle is built per
 * request and never put in the registry of the process, so a version approved today is offered at once and the registry still holds only code-owned forms. What is issued keeps the version and the hash of the layout
 * (`report_layout` and `layout_sha256`), so a later version never changes a copy that was issued.
 */
const policy = new GovernancePolicyPort();
const register = new AnalyticsGovernanceStore();

export const isConfiguredCode = (code: string): boolean => new RegExp(CONFIG_CODE_PATTERN).test(code);
/** The version label of a layout compiled from a rule: `v` and the version of the rule (`v0` for a built-in starting layout). */
export const configuredVersionOf = (rule: Pick<ResolvedGovernanceRule, 'version'>): string => `v${rule.version}`;

async function definitionsOf(tx: TenantTx, today: string): Promise<Record<string, ReportIndicatorDefinition>> {
  const map = await register.kpiDefinitions(tx, today);
  return Object.fromEntries([...map].map(([code, definition]) => [code, definitionOf(definition)]));
}

export interface ConfiguredForm {
  bundle: ReportFormBundle;
  config: LayoutConfig;
  rule: ResolvedGovernanceRule;
}

/** The bundle of a resolved rule (used by the catalogue, by generation, and by the preview with params that are not stored yet). */
export async function bundleOfConfig(code: string, version: string, config: LayoutConfig, definitions: Readonly<Record<string, ReportIndicatorDefinition>>): Promise<ReportFormBundle> {
  const names = Object.fromEntries(Object.entries(definitions).map(([key, one]) => [key, one.name]));
  const compiled = compileLayoutConfig(code, version, config, { names });
  const template = await buildBlankTemplate(compiled.layout, { landscape: compiled.layout.columns.length > 6 });
  return {
    edition: 'public',
    layout: compiled.layout,
    narrative: null,
    receiver: compiled.receiver,
    periodKind: compiled.periodKind,
    dataSource: compiled.demo ? 'ILLUSTRATIVE' : 'LIVE',
    provider: compiled.demo ? null : (config.data_provider ?? CONFIG_DEFAULT_PROVIDER),
    templates: async () => ({ xlsx: template, docx: null }),
    ...(compiled.demo ? { illustrative: (period: Parameters<NonNullable<ReportFormBundle['illustrative']>>[0]) => illustrativeLayoutData(config, period, definitions) } : {}),
  };
}

/** The configured form `code` as it stands on `today`, or undefined when no rule or starting layout has that code. */
export async function configuredFormOf(tx: TenantTx, code: string, today: string): Promise<ConfiguredForm | undefined> {
  if (!isConfiguredCode(code)) return undefined;
  const rule = await policy.get(tx, REPORT_LAYOUT_RULE_TYPE, code, today);
  if (rule === undefined) return undefined;
  const config = layoutConfigOf(rule.params);
  const bundle = await bundleOfConfig(code, configuredVersionOf(rule), config, await definitionsOf(tx, today));
  return { bundle, config, rule };
}

/** Every configured form in force on `today`, by code. A rule that no longer compiles is left out, not allowed to hide the others. */
export async function configuredFormsOf(tx: TenantTx, today: string): Promise<ConfiguredForm[]> {
  const rules = (await policy.getAll(tx, REPORT_LAYOUT_RULE_TYPE, today)).filter((rule) => isConfiguredCode(rule.code));
  if (rules.length === 0) return [];
  const definitions = await definitionsOf(tx, today);
  const out: ConfiguredForm[] = [];
  for (const rule of rules) {
    try {
      const config = layoutConfigOf(rule.params);
      out.push({ bundle: await bundleOfConfig(rule.code, configuredVersionOf(rule), config, definitions), config, rule });
    } catch (failure) {
      if (!(failure instanceof DomainError)) throw failure;
    }
  }
  return out;
}

export { definitionsOf as indicatorDefinitionsOf };
