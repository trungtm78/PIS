import { useMutation, useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../../adm/governance/hooks';
import { toResolved, toVersions } from '../../adm/governance/model';
import type { Resolved, RuleVersion } from '../../adm/governance/model';
import { TEMPLATE_RULE_TYPE } from '../model';
import type { SchedulePreview, TemplateValidation } from '../model';
import type { Template } from './template-model';
import { paramsOfTemplate } from './template-model';

/** The checks of the server on a template: cycles, references, limits and the quality flags of the schedule (they never block). */
export function useValidateTemplate() {
  const client = useApiClient();
  return useMutation<TemplateValidation, Error, Template>({
    mutationFn: (template) => client.command('validateProjectWorkflowTemplate', { body: paramsOfTemplate(template) }),
  });
}

export interface PreviewInput {
  template: Template;
  plannedStartDate: string;
  facts: { project_group?: string; funding_source?: string; project_type?: string };
}

/** The schedule of a template on a start day and the facts of a project, tried out on the server (nothing is stored). */
export function usePreviewTemplate() {
  const client = useApiClient();
  return useMutation<SchedulePreview, Error, PreviewInput>({
    mutationFn: (input) => client.command('previewProjectWorkflowTemplate', { body: { params: paramsOfTemplate(input.template), planned_start_date: input.plannedStartDate, facts: input.facts } }),
  });
}

export interface TemplateCodeData {
  code: string;
  versions: RuleVersion[];
  /** The rule in force today (a rule of the tenant, or the template that ships with the platform); null when nothing governs the code. */
  effective: Resolved | null;
}

/**
 * For each code of the library: every version and the rule in force. The keys sit under the rule store's key, so a move made through the governance dialog (submit, approve, retire) reads them again.
 */
export function useTemplateCodes(codes: readonly string[], enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: [...key, 'pwf-template', code],
      enabled: enabled && key[1] !== undefined,
      retry: false,
      queryFn: async (): Promise<TemplateCodeData> => {
        const [versions, effective] = await Promise.all([
          client.read('listGovernanceRuleVersions' as never, { query: { rule_type: TEMPLATE_RULE_TYPE, code } } as never),
          client.read('getEffectiveGovernanceRule' as never, { query: { rule_type: TEMPLATE_RULE_TYPE, code } } as never).catch((error: unknown) => {
            if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) return null;
            throw error;
          }),
        ]);
        const parsed = toVersions(versions);
        if (parsed === undefined) throw new Error('VERSIONS_UNUSABLE');
        return { code, versions: parsed, effective: effective === null ? null : (toResolved(effective) ?? null) };
      },
    })),
  });
}

/** A value that follows `value` after it has stayed the same for `delay` milliseconds (live checks wait for the person to stop typing). */
export function useDebouncedValue<V>(value: V, delay: number): V {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
