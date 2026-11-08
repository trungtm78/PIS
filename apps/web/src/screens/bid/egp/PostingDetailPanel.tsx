import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { DeadlineInfo } from './PostingInfo';
import { usePostingDetail } from './posting-hooks';
import { fieldLabel, kindLabel, stateLabel } from './posting-labels';
import { shortHash, stamp } from './posting-model';
import type { PostingState } from './posting-model';
import './posting.css';

const STATES: readonly string[] = ['DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED'];

/** What was done to a duty, who did it and why; the rule that gave its deadline; the packet that was prepared and the receipt. Read when a person asks, never written here. */
export function PostingDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = usePostingDetail(id);
  const data = detail.data;
  const packetFields = data?.obligation.packetSha256 === null || data === undefined ? [] : data.requiredFields;
  return (
    <SectionCard
      title={t('egp.posting.detail.title')}
      status={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('egp.posting.detail.close.action')}
        </button>
      }
    >
      <div data-testid="detail" data-posting-id={id}>
        {detail.isLoading && <p role="status">{t('egp.posting.detail.loading')}</p>}
        {detail.isError && (
          <p role="alert" data-testid="detail-error">
            {t('egp.posting.detail.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void detail.refetch()}>
              {t('states.retry.action')}
            </button>
          </p>
        )}
        {data !== undefined && (
          <>
            <p>
              <strong>{kindLabel(t, data.obligation.kind)}</strong> {data.obligation.subjectCode}
            </p>
            <p className="sub" data-testid="detail-rule">
              {t('egp.posting.detail.rule', { due: data.deadlineRule.dueIn ?? 0, version: data.deadlineRule.version })} <DeadlineInfo detail={data} />
            </p>
            {data.obligation.packetSha256 !== null && (
              <p className="sub" data-testid="detail-packet">
                {t('egp.posting.detail.packet', { hash: shortHash(data.obligation.packetSha256) })} {packetFields.map((name) => fieldLabel(t, name)).join(', ')}
              </p>
            )}
            <h3>{t('egp.posting.detail.history.title')}</h3>
            <ol className="posting-history" data-testid="history">
              {data.history.map((line) => (
                <li key={line.id}>
                  <span>{stamp(line.occurredAt)}</span>{' '}
                  <strong>{t('egp.posting.detail.history.line', { state: STATES.includes(line.stateAfter) ? stateLabel(t, line.stateAfter as PostingState) : line.stateAfter, name: line.actorName ?? t('egp.posting.cell.none') })}</strong>
                  {line.reason !== null && <small> {t('egp.posting.detail.history.reason', { reason: line.reason })}</small>}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </SectionCard>
  );
}
