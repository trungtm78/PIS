import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import '../dis.css';
import { ReportFacts } from './components';
import { DecisionHistory, DecisionPanel } from './decision-parts';
import { CORRECTION_PATH, HISTORY_PATH, canAskAmendment, canCorrect, canDecide, formatMoment } from './decision-model';
import { cellLabel } from './labels';
import { CELLS } from './model';
import type { ReportDetail } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';

/**
 * DIS-07: the report as it was handed in and what was decided on it (ST-DIS-006, DIS 3 F2): the six cells, the revision it corrects and why, the decisions of the reviewers with what a return asked
 * to be fixed and by when, and the buttons that belong to the person: accept or return for a reviewer, a correction for the maker. The accepted revision is the one the figures of the period are taken from.
 */
export default function ReportDetailScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      texts={{
        back: t('dis.reportDetail.back.link'),
        title: t('dis.reportDetail.page.title'),
        subtitle: t('dis.reportDetail.page.subtitle'),
        choose: t('dis.reportDetail.choose.text'),
        footer: t('dis.reportDetail.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <Detail key={detail.id} detail={detail} />}
    </StepFrame>
  );
}

function Detail({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const last = detail.decisions[detail.decisions.length - 1];
  const sentBack = (detail.status === 'RETURNED' || detail.status === 'AMENDMENT_REQUESTED') && last !== undefined;
  return (
    <div className="card">
      <ReportFacts detail={detail} />
      <p data-testid="current-mark" className={detail.isCurrent ? 'callout' : 'muted'}>
        {detail.isCurrent ? t('dis.reportDetail.current.yes.text') : t('dis.reportDetail.current.no.text')}
      </p>
      {detail.supersedesId === null ? null : (
        <p data-testid="lineage">
          {t('dis.reportDetail.lineage.text', { reason: detail.amendmentReason ?? '' })}{' '}
          <Link to={`${HISTORY_PATH}?report=${detail.id}`}>{t('dis.reportDetail.history.link')}</Link>
        </p>
      )}
      {detail.acceptedAt === null ? null : <p className="sub">{t('dis.reportDetail.accepted.text', { at: formatMoment(detail.acceptedAt) })}</p>}
      {sentBack ? (
        <div className="callout warning" role="status" data-testid="sent-back">
          <p>{last.reason}</p>
          {last.returnItems.length === 0 ? null : (
            <ul>
              {last.returnItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {last.dueAt === null ? null : <p>{t('dis.reportDecision.history.due.text', { at: formatMoment(last.dueAt) })}</p>}
        </div>
      ) : null}
      <Cells detail={detail} />
      <Content detail={detail} />
      <DecisionHistory decisions={detail.decisions} />
      {canDecide(permissions, mode, detail.status) ? <DecisionPanel detail={detail} kinds={['approve', 'return']} /> : null}
      {canAskAmendment(permissions, mode, detail) ? <DecisionPanel detail={detail} kinds={['request_amendment']} /> : null}
      <p>
        {canCorrect(permissions, mode, detail.status) ? (
          <Link className="button" to={`${CORRECTION_PATH}?report=${detail.id}`}>
            {t('dis.reportDetail.correct.action')}
          </Link>
        ) : null}{' '}
        <Link to={`${HISTORY_PATH}?report=${detail.id}`}>{t('dis.reportDetail.history.link')}</Link>
      </p>
    </div>
  );
}

/** What the report says beyond its cells, as it was handed in: the explanation of a fall, the volumes, the registration for next month, the notes and the files, so that a reviewer reads all of it here. */
function Content({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const { progress, narrative } = detail;
  const notes: Array<[string, string | null]> = [
    [t('dis.review.notes.results.label'), narrative?.results ?? null],
    [t('dis.review.notes.causes.label'), narrative?.causes ?? null],
    [t('dis.review.notes.solutions.label'), narrative?.solutions ?? null],
    [t('dis.review.notes.proposals.label'), narrative?.proposals ?? null],
  ];
  return (
    <>
      {detail.negativeDeltaExplanation === null ? null : (
        <section aria-labelledby="detail-explanation-title">
          <h2 id="detail-explanation-title">{t('dis.reportEdit.explanation.label')}</h2>
          <p data-testid="detail-explanation">{detail.negativeDeltaExplanation}</p>
        </section>
      )}
      <section aria-labelledby="detail-volumes-title">
        <h2 id="detail-volumes-title">{t('dis.reportDetail.volumes.title')}</h2>
        {progress === null ? (
          <p className="muted" data-testid="detail-volumes-none">
            {t('dis.reportDetail.volumes.none.text')}
          </p>
        ) : (
          <dl className="aud-facts" data-testid="detail-volumes">
            <dt>{t('dis.progress.construction.label')}</dt>
            <dd>{formatVnd(progress.constructionVnd)}</dd>
            <dt>{t('dis.progress.acceptance.label')}</dt>
            <dd>{formatVnd(progress.acceptanceVnd)}</dd>
            <dt>{t('dis.progress.treasury.label')}</dt>
            <dd>{formatVnd(progress.treasurySubmittedVnd)}</dd>
            <dt>{t('dis.progress.preparing.label')}</dt>
            <dd>{formatVnd(progress.preparingDossierVnd)}</dd>
            {progress.physicalProgressPct === null ? null : (
              <>
                <dt>{t('dis.progress.percent.label')}</dt>
                <dd>{progress.physicalProgressPct}</dd>
              </>
            )}
          </dl>
        )}
      </section>
      <section aria-labelledby="detail-registration-title">
        <h2 id="detail-registration-title">{t('dis.reportDetail.registration.title')}</h2>
        <p data-testid="detail-registration">{t('dis.reportDetail.registration.text', { total: formatVnd(detail.totals.nextMonthVnd), ctmtqg: formatVnd(detail.totals.nextMonthCtmtqgVnd) })}</p>
      </section>
      <section aria-labelledby="detail-notes-title">
        <h2 id="detail-notes-title">{t('dis.review.notes.title')}</h2>
        {notes.every(([, words]) => words === null) ? (
          <p className="muted" data-testid="detail-notes-none">
            {t('dis.reportDetail.notes.none.text')}
          </p>
        ) : (
          <dl className="aud-facts" data-testid="detail-notes">
            {notes.map(([label, words]) =>
              words === null ? null : (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{words}</dd>
                </div>
              ),
            )}
          </dl>
        )}
      </section>
      <section aria-labelledby="detail-files-title">
        <h2 id="detail-files-title">{t('dis.review.files.title')}</h2>
        {detail.attachments.length === 0 ? (
          <p className="muted" data-testid="detail-files-none">
            {t('dis.review.files.none.text')}
          </p>
        ) : (
          <ul className="dis-files" data-testid="detail-files">
            {detail.attachments.map((file) => (
              <li key={file.fileObjectId}>
                {file.fileName} <span className="sub">{t('dis.review.files.size.text', { size: Math.max(1, Math.ceil(file.sizeBytes / 1024)) })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** The six cells as they were handed in, with the CTMTQG inside them given apart (BR-DIS-01) and the total that is the sum of the cells, never of the periods. */
function Cells({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="detail-cells-title">
      <h2 id="detail-cells-title">{t('dis.reportDetail.cells.title')}</h2>
      <div className="tablewrap">
        <table className="table dis-matrix" aria-label={t('dis.reportDetail.cells.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dis.reportDetail.cells.col.source')}</th>
              <th scope="col" className="num">
                {t('dis.reportDetail.cells.col.cumulative')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportDetail.cells.col.ctmtqg')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportDetail.cells.col.change')}
              </th>
            </tr>
          </thead>
          <tbody>
            {CELLS.map((key) => {
              const cell = detail.cells.find((entry) => entry.bucket === key.bucket && entry.level === key.level);
              const fall = cell?.deltaVnd?.startsWith('-') === true;
              return (
                <tr key={`${key.bucket}:${key.level}`}>
                  <th scope="row">{cellLabel(t, key)}</th>
                  <td className="num">{formatVnd(cell?.cumulativeVnd ?? '0')}</td>
                  <td className="num">{cell?.ctmtqgVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.ctmtqgVnd)}</td>
                  <td className={fall ? 'num dis-fall' : 'num'}>{cell?.deltaVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.deltaVnd)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('dis.reportDetail.cells.total.label')}</th>
              <td className="num" data-testid="detail-total">
                {formatVnd(detail.totals.cumulativeVnd)}
              </td>
              <td className="num" data-testid="detail-ctmtqg">
                {formatVnd(detail.totals.ctmtqgVnd)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
