import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toUploadedFile } from '../../prj/national-code-import-model';
import type { UploadedFile } from '../../prj/national-code-import-model';
import { toImportResult } from './import-model';
import type { ImportResult } from './import-model';
import { toLink, toMilestone, toTrackedPackage } from './model';
import type { LinkLine, MilestoneBody, MilestoneLine, TrackedPackage } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-procurement', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-procurement', tenant?.id, tenant?.membershipId];
}

/** The packages in the scope of the caller, with the version a record of a milestone is made under. */
export function useTrackedPackages() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TrackedPackage[]>({
    queryKey: [...key, 'packages'],
    queryFn: async () => (await client.readAll('get_resources_procurement_package')).flatMap((raw) => toTrackedPackage(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The milestones of the packages in the scope of the caller. */
export function useMilestones() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MilestoneLine[]>({
    queryKey: [...key, 'milestones'],
    queryFn: async () => {
      const body = (await client.read('listProcurementMilestones')) as { items?: unknown[] };
      return (body.items ?? []).flatMap((raw) => toMilestone(raw) ?? []);
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The links of the packages to their codes on the national bidding network, with their differences. */
export function useExternalLinks() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LinkLine[]>({
    queryKey: [...key, 'links'],
    queryFn: async () => {
      const body = (await client.read('listProcurementExternalLinks')) as { items?: unknown[] };
      return (body.items ?? []).flatMap((raw) => toLink(raw) ?? []);
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface RecordInput {
  packageId: string;
  version: number;
  body: MilestoneBody;
}

/** The record of a milestone, under the version of the package the caller saw: one idempotency attempt per intention, every cached read refreshed on success. */
export function useRecordMilestone() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecordInput) => client.command('recordProcurementMilestone', { path: { id: input.packageId }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned); the answer names its key, its hash and what it holds. */
export function useUploadProcurementFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) =>
      toUploadedFile(await uploadFile(client, 'uploadProcurementFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  fileObjectKey: string;
  fileSha256: string;
  mode: 'DRY_RUN' | 'APPLY';
}

/** The dry run or the apply of the stored file: one idempotency attempt per intention; an apply refreshes the milestones and the links. */
export function useImportProcurementFile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<ImportResult | undefined, unknown, ImportInput>({
    mutationFn: async (input) =>
      toImportResult(
        await client.command('importProcurementFile', {
          body: { file_object_key: input.fileObjectKey, file_sha256: input.fileSha256, mode: input.mode },
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      if (input.mode === 'APPLY') await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
