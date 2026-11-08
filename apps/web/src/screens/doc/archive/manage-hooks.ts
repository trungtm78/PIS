import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { dossiersKey } from './hooks';
import { toDossier } from './types';
import type { Dossier } from './types';

export interface DossierItem {
  id: string;
  documentId: string;
  ordinal: number;
  title: string;
  docKind: string;
  docTypeCode: string;
  classification: string;
  issuedOn: string | null;
}

export interface DossierDetail {
  dossier: Dossier;
  items: DossierItem[];
  settlementClosedOn: string | null;
  closedAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function toDossierDetail(raw: unknown): DossierDetail {
  const row = isRecord(raw) ? raw : {};
  const items = Array.isArray(row.items) ? row.items.filter(isRecord) : [];
  return {
    dossier: toDossier(row),
    settlementClosedOn: typeof row.settlement_closed_on === 'string' ? row.settlement_closed_on : null,
    closedAt: typeof row.closed_at === 'string' ? row.closed_at : null,
    items: items.map((item) => ({
      id: text(item.id),
      documentId: text(item.document_id),
      ordinal: typeof item.ordinal === 'number' ? item.ordinal : 0,
      title: text(item.title),
      docKind: text(item.doc_kind),
      docTypeCode: text(item.doc_type_code),
      classification: text(item.classification),
      issuedOn: typeof item.issued_on === 'string' ? item.issued_on : null,
    })),
  };
}

/** One dossier with its contents, the retention rule applied and the legal hold (`getDossier`). */
export function useDossierDetail(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DossierDetail>({
    queryKey: [...dossiersKey(tenant?.id), 'one', id],
    queryFn: async () => toDossierDetail(await client.read('getDossier', { path: { id: id as string } })),
    enabled: id !== undefined && tenant !== undefined,
    retry: false,
  });
}

export interface UnitChoice {
  id: string;
  label: string;
}

/** The organization units of the tenant a dossier can belong to. */
export function useUnitChoices(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UnitChoice[]>({
    queryKey: ['doc', 'dossier-units', tenant?.id],
    queryFn: async () =>
      ((await client.readAll('get_resources_organization_unit')) as unknown[])
        .filter(isRecord)
        .flatMap((row) => (typeof row.id === 'string' && text(row.name) !== '' ? [{ id: row.id, label: [text(row.code), text(row.name)].filter((part) => part !== '').join(' · ') }] : []))
        .sort((a, b) => a.label.localeCompare(b.label, 'vi')),
    enabled: enabled && tenant !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

function useDossierCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: dossiersKey(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: dossiersKey(tenant?.id) });
    },
  });
}

export function useCreateDossier() {
  const client = useApiClient();
  return useDossierCommand((body: Record<string, unknown>, attempt) => client.command('createDossier', { body: body as never, attempt }));
}

export function useAddDocument() {
  const client = useApiClient();
  return useDossierCommand((input: { id: string; version: number; body: Record<string, unknown> }, attempt) => client.command('addDocumentToDossier', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useCloseDossier() {
  const client = useApiClient();
  return useDossierCommand((input: { id: string; version: number; body: Record<string, unknown> }, attempt) => client.command('closeDossier', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
