import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StatusPill } from '../../../ui';
import { useNow, usePeriods } from '../hooks';
import { REPORTS_PATH } from './model';
import type { ReportDetail } from './model';
import { useReport } from './hooks';
import { reportStatusLabel } from './labels';
import { deadlineOf, dueMoment, nextStepOf, returnedOf, statusTone } from './weekly-model';
import type { Receipt } from './weekly-model';
import { dueText } from './weekly-text';
import { formatVnd } from './money';

/** The deadline of the period of a report (the periods are read once for all the screens), none until they are read. */
export function useDeadlineOf(periodId: string): string | undefined {
  return usePeriods().data?.find((period) => period.id === periodId)?.deadlineAt;
}

/**
 * The strip on top of a form of the weekly report: the state of the report as a pill, the period, the deadline with how many days are left (or late), the project and the version, and what the person has
 * to do first. A report that was sent back has the reason and what is to be fixed under it, so that nobody looks for them.
 */
export function StatusStrip({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const now = useNow();
  const dueAt = useDeadlineOf(detail.period.id);
  const view = dueAt === undefined ? undefined : deadlineOf(dueAt, now);
  const step = nextStepOf(detail.status);
  // A draft that corrects a report which was sent back carries the reason of that report, so the person is told what to fix where they fix it.
  const parent = useReport(detail.supersedesId ?? undefined);
  const returned = returnedOf(detail) ?? (parent.data === undefined ? undefined : returnedOf(parent.data));
  const late = detail.status === 'DRAFT' && view?.kind === 'late';
  return (
    <>
      <div className={`dis-wr-strip ui-tone-${late ? 'danger' : statusTone(detail.status)}`} data-testid="status-strip">
        <StatusPill tone={statusTone(detail.status)}>{reportStatusLabel(t, detail.status)}</StatusPill>
        <span className="dis-wr-strip__item">
          <span className="dis-wr-strip__label">{t('dis.wr.strip.period')}</span>
          <span className="dis-wr-strip__value" data-testid="fact-period-strip">
            {t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate })}
          </span>
        </span>
        {dueAt === undefined ? null : (
          <span className="dis-wr-strip__item">
            <span className="dis-wr-strip__label">{t('dis.wr.strip.deadline')}</span>
            <span className="dis-wr-strip__value" data-testid="strip-deadline">
              {dueText(t, dueAt, detail.status === 'DRAFT' || detail.status === 'RETURNED' ? view : undefined)}
            </span>
          </span>
        )}
        <span className="dis-wr-strip__item">
          <span className="dis-wr-strip__label">{t('dis.wr.strip.next')}</span>
          <span className="dis-wr-strip__value" data-testid="strip-next">
            {step === 'fixReturned' ? t('dis.wr.next.fixReturned') : step === 'finishDraft' ? t('dis.wr.next.finishDraft') : step === 'wait' ? t('dis.wr.next.wait') : t('dis.wr.next.done')}
          </span>
        </span>
      </div>
      {returned === undefined ? null : (
        <aside className="dis-wr-return" role="note" data-testid="returned-box">
          <h2>{t('dis.wr.returned.title')}</h2>
          <p>{returned.reason}</p>
          {returned.items.length === 0 ? null : (
            <>
              <p>
                <strong>{t('dis.wr.returned.items')}</strong>
              </p>
              <ul>
                {returned.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {returned.dueAt === null ? null : <p data-testid="returned-due">{t('dis.wr.returned.due', { due: dueMoment(returned.dueAt) })}</p>}
        </aside>
      )}
    </>
  );
}

export interface SummaryItem {
  /** The id of the control the message is about, so that the link can lead to it. */
  target: string;
  message: string;
}

/** The errors of a form in one place on top of it: the focus moves here when a person tries to go on with errors, and each line leads to its field. */
export function ErrorSummary({ items, attempt }: { items: SummaryItem[]; attempt: number }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  // The focus goes to the summary when the person tries again, not at every keystroke.
  useEffect(() => {
    if (attempt === seen.current) return;
    seen.current = attempt;
    if (items.length > 0) box.current?.focus();
  }, [attempt, items.length]);
  if (items.length === 0) return null;
  return (
    <div className="dis-wr-summary" role="alert" tabIndex={-1} ref={box} data-testid="error-summary">
      <h2>{t('dis.wr.summary.title', { count: items.length })}</h2>
      <ul>
        {items.map((item) => (
          <li key={`${item.target}:${item.message}`}>
            <a
              href={`#${item.target}`}
              onClick={(event) => {
                const field = document.getElementById(item.target);
                if (field === null) return;
                event.preventDefault();
                field.focus();
              }}
            >
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a person sees once the report is handed in: the code of the receipt, the time, who receives it, and what happens next. */
export function ReceiptCard({ detail, receipt }: { detail: ReportDetail; receipt: Receipt | undefined }) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="dis-wr-receipt" aria-labelledby="receipt-title" data-testid="receipt">
      <h2 id="receipt-title" tabIndex={-1} ref={heading}>
        {t('dis.wr.receipt.title')}
      </h2>
      <dl>
        {receipt === undefined ? null : (
          <>
            <dt>{t('dis.wr.receipt.code')}</dt>
            <dd data-testid="receipt-code">{receipt.code}</dd>
            <dt>{t('dis.wr.receipt.time')}</dt>
            <dd data-testid="receipt-time">{dueMoment(receipt.submittedAt)}</dd>
          </>
        )}
        <dt>{t('dis.wr.receipt.report')}</dt>
        <dd>{`${detail.project.code} · ${detail.period.code}`}</dd>
        <dt>{t('dis.wr.receipt.total')}</dt>
        <dd>{t('dis.wr.receipt.total.value', { amount: formatVnd(detail.totals.cumulativeVnd) })}</dd>
        <dt>{t('dis.wr.receipt.recipient')}</dt>
        <dd data-testid="receipt-recipient">{tenant?.name ?? t('dis.wr.receipt.recipient.default')}</dd>
        {receipt?.isLate === true ? (
          <>
            <dt>{t('dis.wr.receipt.late.label')}</dt>
            <dd>{t('dis.wr.receipt.late.value')}</dd>
          </>
        ) : null}
      </dl>
      <p data-testid="receipt-next">{t('dis.wr.receipt.next')}</p>
      <div className="dis-wr-actions-inline">
        <Link className="ui-button ui-button--primary" to={REPORTS_PATH}>
          {t('dis.wr.receipt.list')}
        </Link>
      </div>
    </section>
  );
}
