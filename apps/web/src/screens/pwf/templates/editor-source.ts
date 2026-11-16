import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DEFAULT_DAY, isRuleCode, isUuid, textParam } from '../../adm/governance/model';
import type { Resolved, RuleVersion } from '../../adm/governance/model';
import { useBuiltInDefault, useEffective, useRule, useVersions } from '../../adm/governance/hooks';
import { TEMPLATE_RULE_TYPE } from '../model';
import { cloneTemplate } from './quick-start';
import { addNamedPhase, addRow } from './table-model';
import { blankTemplate, readTemplate } from './template-model';
import type { Template } from './template-model';

/** Where the editor starts from (PWF-02): an existing version of a code, the template that ships with the platform, or a new procedure (empty, a copy, or one that waits for pasted rows). */
export type SourceBase =
  | { kind: 'new'; start: 'blank' | 'paste' | 'builtin' | 'clone' }
  | { kind: 'default'; unverified: boolean }
  | { kind: 'rule'; version: RuleVersion };

export interface EditorSource {
  state: 'loading' | 'error' | 'missing' | 'ready';
  retry: () => void;
  /** Changes when the base changes: the editor starts over from the new base. */
  key: string;
  /** The code of the rule the template is written under; empty for a procedure that has none yet (it is made from the name at the first save). */
  code: string;
  base: SourceBase;
  template: Template;
  /** Every version of the code, the newest first. */
  versions: readonly RuleVersion[];
  /** The rule in force, or the template that ships; null when nothing governs the code. */
  effective: Resolved | null;
  /** The address named a version that is not there. */
  fromMissing: boolean;
}

/** A new procedure: one phase and one row to type into (their codes are made from the names). */
export function startingTemplate(): Template {
  const phased = addNamedPhase(blankTemplate());
  const phase = phased.phases[0];
  return phase === undefined ? phased : (addRow(phased, phase.code)?.template ?? phased);
}

/**
 * Reads what the address says: `?from=<version id>` opens that version, `?code=<code>` opens the draft in the making if the code has one and else the rule in force (or the template that ships), `?start=` begins a new
 * procedure (`blank`, `paste`, `builtin:<code>` for the template that ships with the platform, `clone:<code>` for the rule in force of a code). Nothing is asked of the server for a code that is not one.
 */
export function useEditorSource(enabled: boolean): EditorSource {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const fromRaw = textParam(params.get('from'));
  const fromId = fromRaw !== undefined && isUuid(fromRaw) ? fromRaw : undefined;
  const codeRaw = textParam(params.get('code'));
  const startRaw = textParam(params.get('start'));
  const [startKind, startCode] = startRaw === undefined ? [undefined, undefined] : (startRaw.split(':') as [string, string | undefined]);
  const rule = useRule(enabled ? fromId : undefined);
  const code = fromId !== undefined ? (rule.data?.code ?? '') : (codeRaw ?? '');
  const codeOk = isRuleCode(code) && startKind === undefined;
  const versions = useVersions(TEMPLATE_RULE_TYPE, code, undefined, enabled && codeOk);
  const effective = useEffective(TEMPLATE_RULE_TYPE, code, undefined, enabled && codeOk);
  const seedCode = (startKind === 'builtin' || startKind === 'clone') && startCode !== undefined && isRuleCode(startCode) ? startCode : undefined;
  const seedEffective = useEffective(TEMPLATE_RULE_TYPE, seedCode, undefined, enabled && startKind === 'clone' && seedCode !== undefined);
  const seedBuiltIn = useBuiltInDefault(TEMPLATE_RULE_TYPE, seedCode, enabled && startKind === 'builtin' && seedCode !== undefined);
  void DEFAULT_DAY;

  const list = versions.data ?? [];
  const draft = fromId === undefined ? list.find((version) => version.status === 'DRAFT') : undefined;
  const inForce = effective.data?.source === 'RULE' ? list.find((version) => version.version === effective.data?.version) : undefined;
  const chosen: RuleVersion | undefined = fromId !== undefined ? (rule.data ?? undefined) : (draft ?? inForce ?? (effective.data === null || effective.data === undefined ? list[0] : undefined));
  const seed = startKind === 'builtin' ? seedBuiltIn.data : seedEffective.data;
  const retry = (): void => void Promise.all([rule.refetch(), versions.refetch(), effective.refetch(), seedEffective.refetch(), seedBuiltIn.refetch()]);

  const seedParams = seed?.params;
  const seedName = typeof seedParams?.name === 'string' ? seedParams.name : '';
  const fresh = useMemo(() => {
    if (startKind === 'builtin' || startKind === 'clone') return seedParams === undefined ? undefined : cloneTemplate(readTemplate(seedParams), t('pwfx.start.copyName', { name: seedName }));
    return startingTemplate();
  }, [startKind, seedParams, seedName, t]);
  const chosenTemplate = useMemo(() => (chosen === undefined ? undefined : readTemplate(chosen.params)), [chosen]);
  const defaultTemplate = useMemo(() => (effective.data?.source === 'DEFAULT' ? readTemplate(effective.data.params) : undefined), [effective.data]);

  const loading = rule.isLoading || versions.isLoading || effective.isLoading || seedEffective.isLoading || seedBuiltIn.isLoading;
  const error = rule.error ?? versions.error ?? effective.error ?? seedEffective.error ?? seedBuiltIn.error;
  const effectiveData = effective.data ?? null;
  const empty = blankTemplate();
  const base = (state: EditorSource['state'], key: string, sourceBase: SourceBase, template: Template, fromMissing = false): EditorSource => ({ state, retry, key, code, base: sourceBase, template, versions: list, effective: effectiveData, fromMissing });

  if (startKind !== undefined) {
    const kind = startKind === 'paste' ? 'paste' : startKind === 'builtin' ? 'builtin' : startKind === 'clone' ? 'clone' : 'blank';
    if ((kind === 'builtin' || kind === 'clone') && fresh === undefined) return { ...base(loading ? 'loading' : error !== null && error !== undefined ? 'error' : 'missing', `new:${startRaw ?? ''}`, { kind: 'new', start: kind }, empty), code: '' };
    return { ...base('ready', `new:${startRaw ?? ''}`, { kind: 'new', start: kind }, fresh ?? empty), code: '' };
  }
  if (fromId === undefined && codeRaw === undefined) return { ...base('ready', 'new:blank', { kind: 'new', start: 'blank' }, fresh ?? empty), code: '' };
  if (loading) return base('loading', `loading:${fromId ?? code}`, { kind: 'new', start: 'blank' }, empty);
  if (error !== null && error !== undefined) return base('error', `error:${fromId ?? code}`, { kind: 'new', start: 'blank' }, empty);
  if (fromId !== undefined && rule.data === null) return base('ready', `missing:${fromId}`, { kind: 'new', start: 'blank' }, fresh ?? empty, true);
  if (chosen !== undefined && chosenTemplate !== undefined) return base('ready', `rule:${chosen.id}:${chosen.resourceVersion}`, { kind: 'rule', version: chosen }, chosenTemplate);
  if (defaultTemplate !== undefined) return base('ready', `default:${code}`, { kind: 'default', unverified: effectiveData?.unverified === true }, defaultTemplate);
  return base('missing', `missing:${code}`, { kind: 'new', start: 'blank' }, empty);
}
