import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useScopeKey } from './hooks';

/** A governance alert of the register across projects (`listGovernanceAlerts`): the same alert the baseline of one project lists, with the project it belongs to. */
export interface RegisterAlert {
  id: string;
  projectId: string;
  projectCode: string;
  subjectKind: 'MILESTONE' | 'PROJECT';
  subjectCode: string | null;
  audience: string;
  moveCount: number;
  threshold: number;
  ruleVersion: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  raisedAt: string;
  acknowledgedAt: string | null;
}

export interface AlertRegister {
  items: RegisterAlert[];
  asOf: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The register as the API writes it; a row without an identifier or a project is dropped, and a status that is not known is read as open (never as taken in). */
export function toAlertRegister(raw: unknown): AlertRegister | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return {
    asOf: str(raw.as_of),
    items: raw.items.flatMap((item): RegisterAlert[] => {
      if (!isRecord(item) || str(item.id) === '' || str(item.project_id) === '') return [];
      return [
        {
          id: str(item.id),
          projectId: str(item.project_id),
          projectCode: str(item.project_code),
          subjectKind: item.subject_kind === 'PROJECT' ? 'PROJECT' : 'MILESTONE',
          subjectCode: str(item.subject_code) === '' ? null : str(item.subject_code),
          audience: str(item.audience),
          moveCount: num(item.move_count),
          threshold: num(item.threshold),
          ruleVersion: str(item.rule_version),
          status: item.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'OPEN',
          raisedAt: str(item.raised_at),
          acknowledgedAt: str(item.acknowledged_at) === '' ? null : str(item.acknowledged_at),
        },
      ];
    }),
  };
}

export const REGISTER_LIMIT = 100;

/** The governance alerts that reach the caller across the projects of the scope, newest first as the server orders them; the filter is part of the key. */
export function useGovernanceAlerts(status: '' | 'OPEN' | 'ACKNOWLEDGED') {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AlertRegister>({
    queryKey: [...key, 'alert-register', status],
    queryFn: async () => {
      const parsed = toAlertRegister(await client.read('listGovernanceAlerts' as never, { query: { limit: REGISTER_LIMIT, ...(status === '' ? {} : { status }) } } as never));
      if (parsed === undefined) throw new Error('ALERT_REGISTER_UNUSABLE');
      return parsed;
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}
