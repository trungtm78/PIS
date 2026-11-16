import { useMutation } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCatalogue } from '../../adm/governance/hooks';
import { usePwfCommand } from '../hooks';
import type { AdoptBody, StartBody } from './model';

/** The catalogue of rule types, of which the screen takes the template type: the codes that govern a project type today. */
export function useTemplateCatalogue(enabled: boolean) {
  return useCatalogue(enabled);
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
