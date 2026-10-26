import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import '../dis.css';
import { DETAIL_PATH, compareRevisions, signed } from './decision-model';
import { useReport, useRevisionsOf } from './hooks';
import { cellLabel, reportStatusLabel } from './labels';
import type { ReportDetail, ReportLine } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';

/**
 * DIS-11: the history of the revisions of a report and their comparison (ST-DIS-006, DIS 3 F2): every revision of the project in the period with its status, the one the figures of the period are taken
 * from marked, and two revisions side by side cell by cell with the change signed (a fall is negative, never shown as zero). A revision that was handed in is never edited, so what is compared is what was said.
 */
export default function HistoryScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      texts={{
        back: t('dis.reportHistory.back.link'),
        title: t('dis.reportHistory.page.title'),
        subtitle: t('dis.reportHistory.page.subtitle'),
        choose: t('dis.reportHistory.choose.text'),
        footer: t('dis.reportHistory.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <History key={detail.id} detail={detail} />}
    </StepFrame>
  );
}

function History({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const revisions = useRevisionsOf(detail.project.id, detail.period.id);
  const lines = revisions.data ?? [];
  const before = [...lines].reverse().find((line) => line.revision < detail.revision);
  const [chosen, setChosen] = useState<{ first: string | undefined; second: string }>({ first: undefined, second: detail.id });
  const first = chosen.first ?? before?.id;
  return (
    <div className="card">
      <section aria-labelledby="history-list-title">
        <h2 id="history-list-title">{t('dis.reportHistory.list.title')}</h2>
        {revisions.isLoading ? (
          <p className="muted" role="status">
            {t('dis.reportHistory.list.loading.text')}
          </p>
        ) : (
          <ol className="dis-revisions" data-testid="revisions">
            {lines.map((line) => (
              <li key={line.id} data-revision={line.revision} data-current={line.id === detail.id && detail.isCurrent ? 'true' : undefined}>
                <Link to={`${DETAIL_PATH}?report=${line.id}`}>{t('dis.reportEdit.revision.value', { revision: line.revision })}</Link> <span className="pill gray">{reportStatusLabel(t, line.status)}</span>{' '}
                <Marker line={line} detail={detail} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="history-compare-title">
        <h2 id="history-compare-title">{t('dis.reportHistory.compare.title')}</h2>
        {lines.length < 2 ? (
          <p className="muted" data-testid="compare-none">
            {t('dis.reportHistory.compare.none.text')}
          </p>
        ) : (
          <>
            <Picker label={t('dis.reportHistory.compare.first.label')} id="compare-first" lines={lines} value={first} onChange={(value) => setChosen({ ...chosen, first: value })} />
            <Picker label={t('dis.reportHistory.compare.second.label')} id="compare-second" lines={lines} value={chosen.second} onChange={(value) => setChosen({ ...chosen, second: value })} />
            {first === undefined ? null : <Comparison firstId={first} secondId={chosen.second} />}
          </>
        )}
      </section>
    </div>
  );
}

/** The mark that says which revision the figures of the period are taken from: only the accepted one is current (BR-DIS-02). */
function Marker({ line, detail }: { line: ReportLine; detail: ReportDetail }) {
  const { t } = useTranslation();
  const current = line.id === detail.id ? detail.isCurrent : line.status === 'ACCEPTED' || line.status === 'AMENDMENT_REQUESTED';
  return current ? (
    <span className="pill" data-testid={`current-${line.revision}`}>
      {t('dis.reportHistory.current.mark')}
    </span>
  ) : null;
}

function Picker({ id, label, lines, value, onChange }: { id: string; label: string; lines: readonly ReportLine[]; value: string | undefined; onChange(value: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>
        {value === undefined ? <option value="" /> : null}
        {lines.map((line) => (
          <option key={line.id} value={line.id}>
            {t('dis.reportHistory.compare.option.text', { revision: line.revision, status: reportStatusLabel(t, line.status) })}
          </option>
        ))}
      </select>
    </div>
  );
}

function Comparison({ firstId, secondId }: { firstId: string; secondId: string }) {
  const { t } = useTranslation();
  const first = useReport(firstId);
  const second = useReport(secondId);
  if (first.data === undefined || second.data === undefined) {
    return (
      <p className="muted" role="status">
        {t('dis.reportHistory.compare.loading.text')}
      </p>
    );
  }
  const rows = compareRevisions(first.data, second.data);
  return (
    <div className="tablewrap">
      <table className="table dis-matrix" aria-label={t('dis.reportHistory.compare.aria')} data-testid="comparison">
        <thead>
          <tr>
            <th scope="col">{t('dis.reportHistory.compare.col.source')}</th>
            <th scope="col" className="num">
              {t('dis.reportEdit.revision.value', { revision: first.data.revision })}
            </th>
            <th scope="col" className="num">
              {t('dis.reportEdit.revision.value', { revision: second.data.revision })}
            </th>
            <th scope="col" className="num">
              {t('dis.reportHistory.compare.col.change')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.bucket}:${row.level}`}>
              <th scope="row">{cellLabel(t, { bucket: row.bucket as 'CURRENT_YEAR', level: row.level as 'CENTRAL' })}</th>
              <td className="num">{formatVnd(row.firstVnd)}</td>
              <td className="num">{formatVnd(row.secondVnd)}</td>
              <td className={row.changeVnd.startsWith('-') ? 'num dis-fall' : 'num'} data-testid={`compare-${row.bucket}:${row.level}`}>
                {signed(formatVnd(row.changeVnd))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {second.data.amendmentReason === null ? null : (
        <p data-testid="compare-reason">
          {t('dis.reportHistory.compare.reason.text', { revision: second.data.revision, reason: second.data.amendmentReason })}
        </p>
      )}
    </div>
  );
}
