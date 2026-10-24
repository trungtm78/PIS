import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { pmtRoot, useCommand } from './hooks';
import { toProjectOption } from './dossier-model';
import type { AddPermitBody, DecisionBody, ExemptionBody, MilestoneBody, OpenDossierBody, ProjectOption, RenewalBody, RevocationBody } from './dossier-model';

/** What a command of the dossier answers: the record it acted on (a renewal answers the new permit). */
export interface CommandAnswer {
  resource_id?: string;
  resource_version?: number;
  status?: string;
}

export interface OpenDossierInput {
  projectId: string;
  body: OpenDossierBody;
}

/** Opens the dossier of a project with the permits the rules of the day require. */
export function useOpenDossier() {
  const client = useApiClient();
  return useCommand<OpenDossierInput, CommandAnswer>((input, attempt) => client.command('createPermitDossier', { path: { id: input.projectId }, body: input.body, attempt }));
}

export interface AddPermitInput {
  dossierId: string;
  body: AddPermitBody;
}

export function useAddPermit() {
  const client = useApiClient();
  return useCommand<AddPermitInput, CommandAnswer>((input, attempt) => client.command('addPermit', { path: { id: input.dossierId }, body: input.body, attempt }));
}

/** A command on one permit names the version the screen read: a permit that moved meanwhile answers VERSION_CONFLICT. */
export interface PermitCommand<Body> {
  permitId: string;
  version: number;
  body: Body;
}

export function useRecordMilestone() {
  const client = useApiClient();
  return useCommand<PermitCommand<MilestoneBody>, CommandAnswer>((input, attempt) =>
    client.command('recordPermitMilestone', { path: { id: input.permitId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useDecidePermit() {
  const client = useApiClient();
  return useCommand<PermitCommand<DecisionBody>, CommandAnswer>((input, attempt) =>
    client.command('recordPermitDecision', { path: { id: input.permitId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useRenewPermit() {
  const client = useApiClient();
  return useCommand<PermitCommand<RenewalBody>, CommandAnswer>((input, attempt) =>
    client.command('renewPermit', { path: { id: input.permitId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useDeclareExemption() {
  const client = useApiClient();
  return useCommand<PermitCommand<ExemptionBody>, CommandAnswer>((input, attempt) =>
    client.command('declarePermitExemption', { path: { id: input.permitId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useRevokePermit() {
  const client = useApiClient();
  return useCommand<PermitCommand<RevocationBody>, CommandAnswer>((input, attempt) =>
    client.command('revokePermit', { path: { id: input.permitId }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

/** The projects the caller may read (the register is filtered by the unit tree): a dossier is opened for one of them. */
export function useProjectOptions(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProjectOption[]>({
    // The register depends on the scope of the membership, not only on the tenant.
    queryKey: [...pmtRoot(tenant?.id), tenant?.membershipId, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectOption(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
