import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../aud.css';
import { EngagementFilter } from '../recommendation/components';
import { useRecommendationBoard } from '../recommendation/hooks';
import { BOARD_PATH, READ_PERMISSION, evidenceRows, holds } from './model';
import type { EvidenceRow } from './model';

/**
 * AUD-09: the evidence of the remediation (ST-AUD-006, AUD 3.3): for each action that is done, the document that proves it, with a link to the document in DOC. The server takes as the proof of an action only a document in
 * force or a file that was scanned clean, so what is listed here is that and nothing else. The data are confidential: only the recommendations of the engagements in the scope of the caller, and the ones given to them, are here.
 */
export default function EvidenceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What is listed belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <EvidenceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EvidenceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.evidence.page.title')}</h1>
          <p>{t('aud.evidence.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.remediation.confidential.note')}
      </p>
      {holds(permissions, READ_PERMISSION) ? (
        <EvidenceList />
      ) : (
        <div data-testid="evidence-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('aud.followup.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EvidenceList() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const list = useRecommendationBoard({ engagementId, status: '', type: '' });
  const rows = evidenceRows(list.data ?? []);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : rows });
  return (
    <>
      <div className="card aud-filters">
        <EngagementFilter selected={engagementId} />
        <p className="sub">
          <Link to={BOARD_PATH + (engagementId === undefined ? '' : `?engagement=${engagementId}`)}>{t('aud.followup.board.link')}</Link>
        </p>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <p className="sub" data-testid="evidence-rule">
          {t('aud.evidence.rule.note')}
        </p>
        <div className="tablewrap">
          <table className="table" data-testid="evidence-table" aria-label={t('aud.evidence.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('aud.evidence.column.subject')}</th>
                <th scope="col">{t('aud.evidence.column.document')}</th>
                <th scope="col">{t('aud.evidence.column.note')}</th>
                <th scope="col">{t('aud.evidence.column.attachedBy')}</th>
                <th scope="col">{t('aud.evidence.column.attachedAt')}</th>
                <th scope="col">{t('aud.evidence.column.done')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
    </>
  );
}

/** A moment of the server as the people of the tenant read it (Vietnam time). */
const momentOf = (value: string): string => {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' });
};

function Row({ row }: { row: EvidenceRow }) {
  const { t } = useTranslation();
  return (
    <tr data-action-id={row.key} data-recommendation-id={row.recommendationId}>
      <td>
        <strong>{row.recommendationCode}</strong> <span className="sub">{row.engagementCode}</span>
        <br />
        <span className="sub">{t('aud.evidence.subject.action', { code: row.actionCode })}</span>
      </td>
      <td>
        {/* The evidence is a document of the tenant by its own identifier; no screen of DOC opens a document by that identifier (DOC-06 takes an outgoing document, DOC-07 a version), so it is named and not linked. */}
        <code data-testid="evidence-document">{row.documentId}</code>
      </td>
      <td className="aud-words">{row.note}</td>
      <td>{row.attachedBy ?? '—'}</td>
      <td>{row.attachedAt === null ? '—' : momentOf(row.attachedAt)}</td>
      <td>{row.doneOn ?? '—'}</td>
    </tr>
  );
}
