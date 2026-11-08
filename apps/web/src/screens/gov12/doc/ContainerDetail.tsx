import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { Figure, shortHash, useRead, vietnamDateTime } from '../docaud-support';
import '../docaud.css';
import { stateTone } from './docModel';
import type { ContainerDetailRead } from './docModel';

/**
 * The detail of one document container (DOC-28): where it stands, the content hash it was registered with, the answers of the newest review (each figure with its "i") and the record of the moves between
 * states with who made them and why. The record is append-only. The panel reads when it is opened and says when it could not.
 */
export function ContainerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useRead<ContainerDetailRead>('getDocContainer', { path: { id } });
  return (
    <section aria-labelledby="container-detail-title" data-testid="container-detail" className="g12-detail">
      <div className="g12-actions">
        <h2 id="container-detail-title">{t('gov12da.doc28.detail.title')}</h2>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose} data-testid="container-detail-close">
          {t('gov12da.doc28.detail.close')}
        </button>
      </div>
      {query.isLoading ? (
        <p role="status" aria-busy="true" data-testid="container-detail-loading">
          {t('gov12da.doc28.detail.loading')}
        </p>
      ) : query.isError || query.data === undefined ? (
        <p role="alert" data-testid="container-detail-error">
          {t('gov12da.doc28.detail.error')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
            {t('gov12da.doc28.detail.retry')}
          </button>
        </p>
      ) : (
        <DetailBody data={query.data} />
      )}
    </section>
  );
}

function DetailBody({ data }: { data: ContainerDetailRead }) {
  const { t } = useTranslation();
  const review = data.latest_review;
  const asOf = vietnamDateTime(data.as_of);
  return (
    <>
      <dl className="g12-facts">
        <div>
          <dt>{t('gov12da.doc28.col.document')}</dt>
          <dd>
            <strong>{data.title}</strong> ({t('gov12da.doc28.col.revision')}: {data.revision_label})
          </dd>
        </div>
        <div>
          <dt>{t('gov12da.doc28.col.state')}</dt>
          <dd>
            <StatusPill tone={stateTone(data.state)}>{t(`gov12da.doc.state.${data.state.toLowerCase()}`)}</StatusPill>
          </dd>
        </div>
        <div>
          <dt>{t('gov12da.doc28.col.hash')}</dt>
          <dd>
            <code className="g12-hash" title={data.content_sha256}>
              {shortHash(data.content_sha256)}
            </code>
          </dd>
        </div>
      </dl>
      {review === null ? (
        <p className="g12-muted" data-testid="container-no-review">
          {t('gov12da.doc28.detail.noReview')}
        </p>
      ) : (
        <div className="g12-figures" data-testid="container-review">
          <Figure label={t('gov12da.doc28.detail.required')} value={String(review.required)} topic="transmittal" asOf={asOf} rule={undefined} testId="review-required" />
          <Figure label={t('gov12da.doc28.detail.answered')} value={String(review.answered)} topic="transmittal" asOf={asOf} rule={undefined} testId="review-answered" />
          <Figure label={t('gov12da.doc28.detail.approved')} value={String(review.approved)} topic="transmittal" asOf={asOf} rule={undefined} testId="review-approved" />
          <Figure label={t('gov12da.doc28.detail.rejected')} value={String(review.rejected)} topic="transmittal" asOf={asOf} rule={undefined} testId="review-rejected" />
          <Figure label={t('gov12da.doc28.detail.overdue')} value={String(review.overdue)} topic="transmittal" asOf={asOf} rule={undefined} testId="review-overdue" />
          <p data-testid="review-ready">{review.all_required_answered ? t('gov12da.doc28.detail.allAnswered') : t('gov12da.doc28.detail.waiting')}</p>
        </div>
      )}
      <h3>{t('gov12da.doc28.detail.moves')}</h3>
      {data.moves.length === 0 ? (
        <p className="g12-muted" data-testid="container-no-moves">
          {t('gov12da.doc28.detail.noMoves')}
        </p>
      ) : (
        <ol className="g12-thread" data-testid="container-moves">
          {data.moves.map((move) => (
            <li key={move.id} className="g12-thread__item" data-testid={`move-row-${move.id}`}>
              <strong>
                {move.from_state === null ? t('gov12da.doc28.detail.registered') : t('gov12da.doc28.detail.moved', { from: t(`gov12da.doc.state.${move.from_state.toLowerCase()}`), to: t(`gov12da.doc.state.${move.to_state.toLowerCase()}`) })}
              </strong>
              <div className="g12-muted">
                {vietnamDateTime(move.at)} · {t('gov12da.doc28.detail.actor', { actor: move.actor_id.slice(0, 8) })}
              </div>
              {move.reason === null ? null : <div>{t('gov12da.doc28.detail.reason', { reason: move.reason })}</div>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
