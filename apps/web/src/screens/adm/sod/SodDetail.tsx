import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { actionLabel, scopeLabel, statusLabel, statusTone } from './labels';
import { toException } from './model';
import type { ExceptionView } from './model';

export interface DecisionView {
  approverId: string;
  approverName: string;
  decision: string;
  comment: string | null;
  decidedAt: string;
}

export interface ExceptionDetail {
  exception: ExceptionView;
  decisions: DecisionView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An exception with the decisions of its approvers, as `getSodException` returns them; a body that is not an exception is a failure, not an empty page. */
export function toExceptionDetail(raw: unknown): ExceptionDetail {
  const exception = toException(raw);
  if (exception === undefined) throw new Error('the exception is not in the shape of the contract');
  const decisions = isRecord(raw) && Array.isArray(raw.decisions) ? raw.decisions.filter(isRecord) : [];
  return {
    exception,
    decisions: decisions.map((row) => ({ approverId: text(row.approver_id), approverName: text(row.approver_name), decision: text(row.decision), comment: typeof row.comment === 'string' ? row.comment : null, decidedAt: text(row.decided_at) })),
  };
}

export function useSodException(id: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ExceptionDetail>({
    queryKey: ['adm', 'sod', tenant?.id, 'exception', id],
    queryFn: async () => toExceptionDetail(await client.read('getSodException', { path: { id } })),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One exception in full: the pair, the person, the window and the reason, and the decision of each approver with the words they gave (approver, decision, day). */
export function SodDetail({ row, onClose }: { row: ExceptionView; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useSodException(row.id);
  const shown = detail.data?.exception ?? row;
  return (
    <SectionCard title={t('govd.sod.detail.title')} status={<StatusPill tone={statusTone(shown.status)}>{statusLabel(t, shown.status)}</StatusPill>}>
      <div data-testid="sod-detail">
        <p>
          {actionLabel(t, shown.actionA)} / {actionLabel(t, shown.actionB)} · {scopeLabel(t, shown.scope)}
        </p>
        <p className="adm-kit-sub">
          {shown.validFrom} - {shown.validTo} · {t('govd.sod.approvals', { given: shown.approvals, needed: shown.approversNeeded })}
        </p>
        <p>{shown.reason}</p>
        {detail.isLoading ? (
          <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
        ) : detail.isError || detail.data === undefined ? (
          <p role="alert" data-testid="sod-detail-error">
            {t('govd.sod.detail.failed')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void detail.refetch()}>
              {t('govd.sod.detail.retry')}
            </button>
          </p>
        ) : detail.data.decisions.length === 0 ? (
          <p role="status" data-testid="sod-detail-empty">
            {t('govd.sod.detail.empty')}
          </p>
        ) : (
          <KitTable caption={t('govd.sod.detail.decisions')} testId="sod-decisions">
            <thead>
              <tr>
                <th scope="col">{t('govd.sod.detail.approver')}</th>
                <th scope="col">{t('govd.sod.detail.decision')}</th>
                <th scope="col">{t('govd.sod.detail.comment')}</th>
                <th scope="col">{t('govd.sod.detail.at')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.data.decisions.map((entry) => (
                <tr key={`${entry.approverId}:${entry.decidedAt}`}>
                  <td>{entry.approverName === '' ? entry.approverId.slice(0, 8) : entry.approverName}</td>
                  <td>{entry.decision}</td>
                  <td>{entry.comment ?? '—'}</td>
                  <td>{entry.decidedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </KitTable>
        )}
        <button type="button" className="ui-button ui-button--outline" onClick={onClose}>
          {t('govd.sod.detail.close')}
        </button>
      </div>
    </SectionCard>
  );
}
