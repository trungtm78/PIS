import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { kindOf } from './model';
import type { AlertStatus, AlertType, Kind } from './model';

/** A risk alert of the register across projects (`listProjectRiskAlerts`): the alert a project page lists, with the project it belongs to. */
export interface RiskRegisterAlert {
  id: string;
  projectId: string;
  projectCode: string;
  type: AlertType;
  kind: Kind | null;
  score: number;
  priorScore: number | null;
  threshold: number;
  ruleVersion: string;
  ruleUnverified: boolean;
  status: AlertStatus;
  raisedOn: string;
  resolvedOn: string | null;
}

export interface RiskAlertRegister {
  items: RiskRegisterAlert[];
  asOf: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The register as the API writes it; a row without an identifier or a project is dropped, a status that is not known is read as open, and a rule that does not say it was confirmed is not confirmed. */
export function toRiskAlertRegister(raw: unknown): RiskAlertRegister | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return {
    asOf: str(raw.as_of),
    items: raw.items.flatMap((item): RiskRegisterAlert[] => {
      if (!isRecord(item) || str(item.id) === '' || str(item.project_id) === '') return [];
      return [
        {
          id: str(item.id),
          projectId: str(item.project_id),
          projectCode: str(item.project_code),
          type: item.alert_type === 'RISK_SCORE_JUMP' ? 'RISK_SCORE_JUMP' : 'RISK_SCORE_CRITICAL',
          kind: kindOf(item.signal_kind) ?? null,
          score: numOrNull(item.score) ?? 0,
          priorScore: numOrNull(item.prior_score),
          threshold: numOrNull(item.threshold) ?? 0,
          ruleVersion: str(item.rule_version),
          ruleUnverified: item.rule_unverified !== false,
          status: item.status === 'ACKNOWLEDGED' || item.status === 'RESOLVED' ? item.status : 'OPEN',
          raisedOn: str(item.raised_on),
          resolvedOn: str(item.resolved_on) === '' ? null : str(item.resolved_on),
        },
      ];
    }),
  };
}

export const RISK_REGISTER_LIMIT = 100;

/** The risk alerts across the projects of the scope; the status filter is part of the key. */
export function useRiskAlertRegister(status: '' | AlertStatus) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<RiskAlertRegister>({
    queryKey: [...scope, 'risk-signals', 'alert-register', status],
    queryFn: async () => {
      const parsed = toRiskAlertRegister(await client.read('listProjectRiskAlerts' as never, { query: { limit: RISK_REGISTER_LIMIT, ...(status === '' ? {} : { status }) } } as never));
      if (parsed === undefined) throw new Error('RISK_ALERT_REGISTER_UNUSABLE');
      return parsed;
    },
    enabled: scope[1] !== undefined,
    retry: false,
  });
}
