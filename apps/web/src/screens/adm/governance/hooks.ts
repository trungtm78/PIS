import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { DEFAULT_DAY, toAlertTypes, toCatalogue, toDiff, toResolved, toVersion, toVersions } from './model';
import type { Move, Params } from './model';

/** What these screens show depends on who is signed in (the rules are the tenant's, but the buttons depend on the membership): both are in every key. */
export function useScopeKey(): readonly ['gova1', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['gova1', tenant?.id, tenant?.membershipId];
}

const notThere = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/** The catalogue of the rule types the platform knows, with the codes and what governs each today. */
export function useCatalogue(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'catalogue'],
    queryFn: async () => {
      const parsed = toCatalogue(await client.read('getGovernanceRuleCatalog' as never, {} as never));
      if (parsed === undefined) throw new Error('CATALOGUE_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Every version of one code (and one unit), the newest first. */
export function useVersions(ruleType: string | undefined, code: string | undefined, unitId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'versions', ruleType ?? '', code ?? '', unitId ?? ''],
    queryFn: async () => {
      const parsed = toVersions(await client.read('listGovernanceRuleVersions' as never, { query: { rule_type: ruleType, code, ...(unitId === undefined ? {} : { unit_id: unitId }) } } as never));
      if (parsed === undefined) throw new Error('VERSIONS_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined && ruleType !== undefined && code !== undefined,
    retry: false,
  });
}

/** The rule in force on a day (today when `asOf` is empty): null when nothing governs the code, neither a rule of the tenant nor a default. */
export function useEffective(ruleType: string | undefined, code: string | undefined, unitId: string | undefined, enabled: boolean, asOf?: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'effective', ruleType ?? '', code ?? '', unitId ?? '', asOf ?? ''],
    queryFn: async () => {
      try {
        return toResolved(await client.read('getEffectiveGovernanceRule' as never, { query: { rule_type: ruleType, code, ...(unitId === undefined ? {} : { unit_id: unitId }), ...(asOf === undefined ? {} : { as_of: asOf }) } } as never)) ?? null;
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && ruleType !== undefined && code !== undefined,
    retry: false,
  });
}

/** The default that ships with the platform: the rule in force on a day before any rule can begin. Null when the code has no default. */
export function useBuiltInDefault(ruleType: string | undefined, code: string | undefined, enabled: boolean) {
  return useEffective(ruleType, code, undefined, enabled, DEFAULT_DAY);
}

export function useRule(ruleId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'rule', ruleId ?? ''],
    queryFn: async () => {
      try {
        return toVersion(await client.read('getGovernanceRule' as never, { path: { ruleId } } as never)) ?? null;
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && ruleId !== undefined,
    retry: false,
  });
}

/** What changed in a version: against `against`, else the version before it, else the default. Null when the version is not there. */
export function useDiff(ruleId: string | undefined, against: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'diff', ruleId ?? '', against ?? ''],
    queryFn: async () => {
      try {
        return toDiff(await client.read('getGovernanceRuleDiff' as never, { path: { ruleId }, ...(against === undefined ? {} : { query: { against } }) } as never)) ?? null;
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && ruleId !== undefined,
    retry: false,
  });
}

/** The registry of alert types as it stands on a day (today when empty) for the whole tenant or one unit. */
export function useAlertTypes(unitId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'alert-types', unitId ?? ''],
    queryFn: async () => {
      const parsed = toAlertTypes(await client.read('listAlertTypes' as never, { ...(unitId === undefined ? {} : { query: { unit_id: unitId } }) } as never));
      if (parsed === undefined) throw new Error('ALERT_TYPES_UNUSABLE');
      return parsed;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of these screens refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DraftInput {
  ruleType: string;
  code: string;
  unitId: string | undefined;
  params: Params;
  effectiveFrom: string;
  effectiveTo: string | undefined;
  reason: string;
}

/** Writes a draft: a new version of a code. Returns the id of the version. */
export function useCreateDraft() {
  const client = useApiClient();
  return useCommand<DraftInput>((input, attempt) =>
    client.command('createGovernanceRuleDraft' as never, {
      body: {
        rule_type: input.ruleType,
        code: input.code,
        ...(input.unitId === undefined ? {} : { unit_id: input.unitId }),
        params: input.params,
        effective_from: input.effectiveFrom,
        ...(input.effectiveTo === undefined ? {} : { effective_to: input.effectiveTo }),
        reason: input.reason,
      },
      attempt,
    } as never),
  );
}

export interface MoveInput {
  move: Move;
  id: string;
  /** The version of the record the person saw (If-Match). */
  version: number;
  reason: string;
  /** Retire only: the first day the version no longer applies. */
  effectiveTo?: string | undefined;
}

const OPERATION: Readonly<Record<Move, string>> = { submit: 'submitGovernanceRule', withdraw: 'withdrawGovernanceRule', approve: 'approveGovernanceRule', retire: 'retireGovernanceRule' };

/** Submit, withdraw, approve or retire one version; the version of the record is the If-Match of the call. */
export function useRuleMove() {
  const client = useApiClient();
  return useCommand<MoveInput>((input, attempt) =>
    client.command(OPERATION[input.move] as never, {
      path: { ruleId: input.id },
      body: input.move === 'retire' && input.effectiveTo !== undefined ? { reason: input.reason, effective_to: input.effectiveTo } : { reason: input.reason },
      ifMatchVersion: input.version,
      attempt,
    } as never),
  );
}
