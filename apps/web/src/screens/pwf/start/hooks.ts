import { useMutation } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCatalogue, useEffective } from '../../adm/governance/hooks';
import { usePwfCommand } from '../hooks';
import { TEMPLATE_RULE_TYPE } from '../model';
import type { TemplateParams } from '../model';
import type { AdoptBody, StartBody } from './model';

/** The catalogue of rule types, of which the screen takes the template type: the codes that govern a project type today. */
export function useTemplateCatalogue(enabled: boolean) {
  return useCatalogue(enabled);
}

/** The template in force today under one code (a rule of the tenant, else the default that ships). */
export function useTemplateRule(code: string | undefined, enabled: boolean) {
  return useEffective(TEMPLATE_RULE_TYPE, code === '' ? undefined : code, undefined, enabled);
}

export interface StartInput {
  projectId: string;
  body: StartBody;
}

/** Starts the workflow of a project: one idempotency attempt per intention. */
export function useStartWorkflow() {
  const client = useApiClient();
  return usePwfCommand<StartInput>((input, attempt) => client.command('startProjectWorkflow', { path: { project_id: input.projectId }, body: input.body, attempt }));
}

export interface AdoptInput {
  projectId: string;
  body: AdoptBody;
}

/** Applies the adoption (dry_run = false): one idempotency attempt per intention. */
export function useApplyAdoption() {
  const client = useApiClient();
  return usePwfCommand<AdoptInput>((input, attempt) => client.command('adoptProjectWorkflow', { path: { project_id: input.projectId }, body: input.body, attempt }));
}

/** The dry run of an adoption writes nothing, so every run is asked afresh (its own idempotency key) and nothing cached is refreshed. */
export function useDryRunAdoption() {
  const client = useApiClient();
  return useMutation({ mutationFn: (input: AdoptInput) => client.command('adoptProjectWorkflow', { path: { project_id: input.projectId }, body: input.body }) });
}

export interface PreviewInput {
  params: TemplateParams;
  plannedStart: string;
  facts: NonNullable<StartBody['facts']>;
}

/** The schedule of a template on a start day, computed and not stored. */
export function usePreviewTemplate() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (input: PreviewInput) => client.command('previewProjectWorkflowTemplate', { body: { params: input.params, planned_start_date: input.plannedStart, facts: input.facts } }),
  });
}
