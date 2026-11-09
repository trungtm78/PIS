import { useTranslation } from '../../i18n';
import type { ReportRead, StepRead, Unavailable } from './approval-detail-hooks';
import { compareRevisions, differenceDong, isNegative, kilobytes, orderedCells, planShareTenths } from './approval-detail-model';
import type { Cell, ReportFigures } from './approval-detail-model';
import { clockAndDay } from '../../ui/alerts/format';

/** A whole amount of dong with thousands separators (exact for any size). */
export const money = (value: string, locale: string): string => BigInt(value).toLocaleString(locale);

/** A change as a person reads it: a rise has a plus, a fall a minus. */
export function signed(change: string, locale: string): string {
  if (change === '0') return '0';
  return isNegative(change) ? `−${money(change.slice(1), locale)}` : `+${money(change, locale)}`;
}

function unavailableText(t: ReturnType<typeof useTranslation>['t'], reason: Unavailable): string {
  switch (reason) {
    case 'denied':
      return t('pwa2.approvalDetail.unavailable.denied');
    case 'notFound':
      return t('pwa2.approvalDetail.unavailable.notFound');
    case 'unreadable':
      return t('pwa2.approvalDetail.unavailable.unreadable');
  }
}

function CellCard({ cell, locale }: { cell: Cell; locale: string }) {
  const { t } = useTranslation();
  const change = cell.previousVnd === null ? null : differenceDong(cell.cumulativeVnd, cell.previousVnd);
  return (
    <li className="pwa-subcard" data-cell={`${cell.bucket}:${cell.level}`}>
      <h3>{t('pwa2.report.cell.title', { bucket: t(`pwa2.report.bucket.${cell.bucket}`), level: t(`pwa2.report.level.${cell.level}`) })}</h3>
      <dl className="pwa-facts">
        <dt>{t('pwa2.approvalDetail.plan.allocated')}</dt>
        <dd>{money(cell.allocatedVnd, locale)}</dd>
        <dt>{t('pwa2.approvalDetail.plan.previous')}</dt>
        <dd>{cell.previousVnd === null ? t('pwa2.approvalDetail.plan.noPrevious') : money(cell.previousVnd, locale)}</dd>
        <dt>{t('pwa2.approvalDetail.plan.current')}</dt>
        <dd>
          <strong>{money(cell.cumulativeVnd, locale)}</strong>
        </dd>
        {change === null ? null : (
          <>
            <dt>{t('pwa2.approvalDetail.plan.change')}</dt>
            <dd data-sign={change === '0' ? 'zero' : isNegative(change) ? 'down' : 'up'}>{change === '0' ? t('pwa2.approvalDetail.plan.unchanged') : signed(change, locale)}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

/** The figures of the report against the plan it rests on and the period before: the six cells of the funding form and the total. */
export function PlanComparison({ read, locale }: { read: ReportRead; locale: string }) {
  const { t } = useTranslation();
  if (read.kind === 'unavailable') return <p role="status">{unavailableText(t, read.reason)}</p>;
  const report: ReportFigures = read.figures;
  const cells = orderedCells(report).filter((cell) => cell.cumulativeVnd !== '0' || cell.allocatedVnd !== '0' || (cell.previousVnd !== null && cell.previousVnd !== '0'));
  const share = planShareTenths(report.cumulativeVnd, report.allocatedVnd);
  const known = report.cells.filter((cell) => cell.previousVnd !== null);
  const previousTotal = known.length === 0 ? null : known.reduce((sum, cell) => sum + BigInt(cell.previousVnd ?? '0'), 0n).toString();
  const change = previousTotal === null ? null : differenceDong(report.cumulativeVnd, previousTotal);
  return (
    <div data-testid="plan-comparison">
      {report.planYear === null ? null : <p className="sub">{t('pwa2.approvalDetail.plan.version', { year: report.planYear, revision: report.planRevision ?? 0 })}</p>}
      <ul className="pwa-cards pwa-cards--inner" aria-label={t('pwa2.approvalDetail.plan.aria')}>
        {cells.map((cell) => (
          <CellCard key={`${cell.bucket}:${cell.level}`} cell={cell} locale={locale} />
        ))}
      </ul>
      <dl className="pwa-facts pwa-total" data-testid="plan-total">
        <dt>{t('pwa2.approvalDetail.plan.total')}</dt>
        <dd>
          <strong>{money(report.cumulativeVnd, locale)}</strong> <span className="pwa-unit">{t('pwa.approvals.unit.vnd')}</span>
        </dd>
        <dt>{t('pwa2.approvalDetail.plan.allocated')}</dt>
        <dd>{report.allocatedVnd === null ? '—' : money(report.allocatedVnd, locale)}</dd>
        <dt>{t('pwa2.approvalDetail.plan.shareLabel')}</dt>
        <dd data-testid="plan-share">{share === null ? t('pwa2.approvalDetail.plan.noPlan') : t('pwa2.approvalDetail.plan.share', { percent: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(share / 10) })}</dd>
        {change === null ? null : (
          <>
            <dt>{t('pwa2.approvalDetail.plan.change')}</dt>
            <dd>{change === '0' ? t('pwa2.approvalDetail.plan.unchanged') : signed(change, locale)}</dd>
          </>
        )}
        <dt>{t('pwa2.approvalDetail.plan.ctmtqg')}</dt>
        <dd>{money(report.ctmtqgVnd, locale)}</dd>
      </dl>
    </div>
  );
}

/** The cells a corrected revision changed, against the revision before it (as MOB-24 shows them). */
export function RevisionComparison({ report, previous, locale }: { report: ReportFigures; previous: ReportRead | undefined; locale: string }) {
  const { t } = useTranslation();
  if (report.supersedesId === null) return <p role="status">{t('pwa2.approvalDetail.revision.first')}</p>;
  if (previous === undefined || previous.kind === 'unavailable') return <p role="status">{t('pwa2.approvalDetail.revision.unavailable')}</p>;
  const changes = compareRevisions(previous.figures, report).filter((change) => change.changed);
  return (
    <div data-testid="revision-comparison">
      <p>{t('pwa2.approvalDetail.revision.line', { current: report.revision, previous: previous.figures.revision })}</p>
      {report.amendmentReason === null ? null : <p className="sub">{t('pwa2.approvalDetail.revision.amendment', { reason: report.amendmentReason })}</p>}
      {changes.length === 0 ? (
        <p>{t('pwa2.approvalDetail.revision.none')}</p>
      ) : (
        <ul className="pwa-lines">
          {changes.map((change) => (
            <li key={`${change.bucket}:${change.level}`}>
              <strong>{t('pwa2.report.cell.title', { bucket: t(`pwa2.report.bucket.${change.bucket}`), level: t(`pwa2.report.level.${change.level}`) })}</strong>
              <br />
              {money(change.previousVnd, locale)} → {money(change.currentVnd, locale)} ({signed(change.changeVnd, locale)})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The files attached to the report as evidence: name, type, size and the head of the digest to match them with the original. */
export function EvidenceList({ read }: { read: ReportRead }) {
  const { t } = useTranslation();
  if (read.kind === 'unavailable') return <p role="status">{unavailableText(t, read.reason)}</p>;
  const files = read.figures.evidence;
  if (files.length === 0) return <p role="status">{t('pwa2.approvalDetail.evidence.none')}</p>;
  return (
    <>
      <ul className="pwa-lines" aria-label={t('pwa2.approvalDetail.evidence.aria')}>
        {files.map((file) => (
          <li key={file.id} data-evidence={file.id}>
            <strong>{file.fileName}</strong>
            <br />
            {t('pwa2.approvalDetail.evidence.file', { type: file.contentType, size: kilobytes(file.sizeBytes) })}
            {file.hashHead === '' ? null : (
              <>
                <br />
                <span className="sub">{t('pwa2.approvalDetail.evidence.hash', { hash: file.hashHead })}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="sub">{t('pwa2.approvalDetail.evidence.note')}</p>
    </>
  );
}

/** The steps of the approval of the record with who decided what and when; only what the server shows the reader. */
export function StepHistory({ read }: { read: StepRead }) {
  const { t } = useTranslation();
  return (
    <>
      {read.limited ? <p className="callout warning" role="status">{t('pwa2.approvalDetail.steps.limited')}</p> : null}
      {read.steps.length === 0 ? (
        <p role="status">{t('pwa2.approvalDetail.steps.none')}</p>
      ) : (
        <ol className="pwa-lines" aria-label={t('pwa2.approvalDetail.steps.aria')}>
          {read.steps.map((step) => (
            <li key={step.id} data-step={step.id} data-status={step.status}>
              <strong>{step.stepName === '' ? '—' : step.stepName}</strong>
              <br />
              {step.assigneeName === null ? null : <span>{step.assigneeName} · </span>}
              {step.decidedAt === null ? t('pwa2.approvalDetail.steps.waiting') : t('pwa2.approvalDetail.steps.decided', { decision: step.decision === 'approve' ? t('pwa2.approvalDetail.steps.approve') : t('pwa2.approvalDetail.steps.return'), time: clockAndDay(step.decidedAt) })}
              {step.reason === null ? null : (
                <>
                  <br />
                  <span className="sub">{t('pwa2.approvalDetail.steps.reason', { reason: step.reason })}</span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
