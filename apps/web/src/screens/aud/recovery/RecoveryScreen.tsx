import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../aud.css';
import { EngagementPicker } from '../conclusion/components';
import { formatVnd } from '../conclusion/model';
import { recommendationStatusLabel } from '../conclusion/labels';
import type { RecommendationStatus } from '../conclusion/model';
import { ENGAGEMENT_PATH } from '../model';
import { RateText } from './components';
import { LinkDialog, ReverseDialog } from './dialogs';
import { useRecoveryLines, useRecoverySummary } from './hooks';
import { exceptionKindLabel, sourceKindLabel } from './labels';
import { canRecordRecovery, canReverse, recoverable } from './model';
import type { RecoveryLine, RecoverySummary } from './model';

type Dialog = { kind: 'link'; recommendationId: string | undefined } | { kind: 'reverse'; line: RecoveryLine };

/**
 * AUD-08: the ledger of the recoveries of an engagement and its reconciliation with PAY (ST-AUD-004, AUD 3.4): what was recommended, what was recovered and what is left, the two rates each with
 * their numerator and their denominator, every line of the ledger with what was recovered up to it, and what the ledger could not take from PAY, kept for the accountant. A line is entered by
 * hand with the document that proves it and put right by a line of the opposite sign, never deleted. The data are confidential: an engagement outside the scope of the caller is not found.
 */
export default function RecoveryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The ledger and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RecoveryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RecoveryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const summary = useRecoverySummary(engagementId);
  const lines = useRecoveryLines(engagementId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const missing = summary.error instanceof ApiError && summary.error.status === 404;
  const loaded = useScreenState({
    isLoading: summary.isLoading || lines.isLoading,
    error: missing ? undefined : (summary.error ?? lines.error),
    data: summary.data,
    isEmpty: (data) => data === undefined,
  });
  // An engagement that is not found is told as empty: whoever asked cannot tell one of another scope from one that is not there. With none chosen there is nothing to load.
  const state: ScreenState = engagementId === undefined ? 'default' : missing ? 'empty' : loaded;
  const mayRecord = canRecordRecovery(permissions, mode);
  const close = (): void => setDialog(undefined);
  const data = summary.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.recovery.page.title')}</h1>
          <p>{t('aud.recovery.page.subtitle')}</p>
        </div>
        {mayRecord && data !== undefined && recoverable(data.recommendations).length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'link', recommendationId: undefined })}>
              {t('aud.recovery.link.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="recovery-rule">
        {t('aud.recovery.rule.note')}
      </p>
      <EngagementPicker selected={engagementId} />
      <StateBoundary state={state} onRetry={() => void Promise.all([summary.refetch(), lines.refetch()])}>
        {data === undefined ? (
          <p className="muted" data-testid="recovery-choose">
            {t('aud.recovery.choose.text')}
          </p>
        ) : (
          <>
            <Totals summary={data} />
            <Recommendations summary={data} mayRecord={mayRecord} onLink={(recommendationId) => setDialog({ kind: 'link', recommendationId })} />
            <Ledger lines={lines.data ?? []} mayRecord={mayRecord} onReverse={(line) => setDialog({ kind: 'reverse', line })} />
            <Exceptions summary={data} />
          </>
        )}
      </StateBoundary>
      {dialog?.kind === 'link' && data !== undefined ? <LinkDialog recommendations={data.recommendations} preselected={dialog.recommendationId} onClose={close} /> : null}
      {dialog?.kind === 'reverse' ? <ReverseDialog line={dialog.line} onClose={close} /> : null}
      <p className="prototype-note">{t('aud.recovery.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Totals({ summary }: { summary: RecoverySummary }) {
  const { t } = useTranslation();
  return (
    <div className="aud-cards" data-testid="recovery-totals">
      <div className="card">
        <h2>{t('aud.recovery.totals.title')}</h2>
        <dl className="aud-facts">
          <dt>{t('aud.recovery.totals.amount')}</dt>
          <dd data-testid="total-amount">{formatVnd(summary.amountVnd)}</dd>
          <dt>{t('aud.recovery.totals.recovered')}</dt>
          <dd data-testid="total-recovered">{formatVnd(summary.recoveredVnd)}</dd>
          <dt>{t('aud.recovery.totals.remaining')}</dt>
          <dd data-testid="total-remaining">{formatVnd(summary.remainingVnd)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>{t('aud.recovery.rates.title')}</h2>
        <dl className="aud-facts">
          <dt>{t('aud.recovery.rates.money')}</dt>
          <dd>
            <RateText rate={summary.moneyRate} testId="rate-money" />
          </dd>
          <dt>{t('aud.recovery.rates.count')}</dt>
          <dd>
            <RateText rate={summary.countRate} testId="rate-count" />
          </dd>
        </dl>
      </div>
    </div>
  );
}

function Recommendations({ summary, mayRecord, onLink }: { summary: RecoverySummary; mayRecord: boolean; onLink(recommendationId: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('aud.recovery.recommendations.title')}</h2>
      {summary.recommendations.length === 0 ? (
        <p className="muted" data-testid="no-financial">
          {t('aud.recovery.recommendations.none')}
        </p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('aud.recovery.recommendations.col.code')}</th>
                <th>{t('aud.recovery.recommendations.col.status')}</th>
                <th>{t('aud.recovery.recommendations.col.amount')}</th>
                <th>{t('aud.recovery.recommendations.col.recovered')}</th>
                <th>{t('aud.recovery.recommendations.col.remaining')}</th>
                <th>{t('aud.recovery.recommendations.col.lines')}</th>
                <th>{t('aud.recovery.recommendations.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.recommendations.map((item) => (
                <tr key={item.recommendationId} data-recommendation-id={item.recommendationId}>
                  <td>
                    <strong>{item.code}</strong>
                  </td>
                  <td>
                    <span className="aud-badge">{recommendationStatusLabel(t, item.status as RecommendationStatus)}</span>
                  </td>
                  <td>{formatVnd(item.amountVnd)}</td>
                  <td>{formatVnd(item.recoveredVnd)}</td>
                  <td>{formatVnd(item.remainingVnd)}</td>
                  <td>{item.lineCount}</td>
                  <td>
                    {mayRecord && item.remainingVnd !== '0' && item.status !== 'CANCELLED' ? (
                      <button type="button" onClick={() => onLink(item.recommendationId)}>
                        {t('aud.recovery.link.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Ledger({ lines, mayRecord, onReverse }: { lines: readonly RecoveryLine[]; mayRecord: boolean; onReverse(line: RecoveryLine): void }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('aud.recovery.ledger.title')}</h2>
      {lines.length === 0 ? (
        <p className="muted" data-testid="no-lines">
          {t('aud.recovery.ledger.none')}
        </p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('aud.recovery.ledger.col.code')}</th>
                <th>{t('aud.recovery.ledger.col.source')}</th>
                <th>{t('aud.recovery.ledger.col.amount')}</th>
                <th>{t('aud.recovery.ledger.col.day')}</th>
                <th>{t('aud.recovery.ledger.col.cumulative')}</th>
                <th>{t('aud.recovery.ledger.col.remaining')}</th>
                <th>{t('aud.recovery.ledger.col.reversal')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} data-link-id={line.id}>
                  <td>
                    <strong>{line.code}</strong>
                    {line.note === null ? null : <div className="sub">{line.note}</div>}
                  </td>
                  <td>{sourceKindLabel(t, line.sourceKind)}</td>
                  <td>{formatVnd(line.amountVnd)}</td>
                  <td>{line.recordedOn}</td>
                  <td>{formatVnd(line.cumulativeVnd)}</td>
                  <td>{formatVnd(line.remainingVnd)}</td>
                  <td>
                    {line.reversalOfId !== null ? <span className="aud-badge">{t('aud.recovery.ledger.reversal.line')}</span> : null}
                    {line.reversed ? <span className="aud-badge warning">{t('aud.recovery.ledger.reversed')}</span> : null}
                    {mayRecord && canReverse(line) ? (
                      <button type="button" onClick={() => onReverse(line)}>
                        {t('aud.recovery.reverse.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Exceptions({ summary }: { summary: RecoverySummary }) {
  const { t } = useTranslation();
  if (summary.exceptions.length === 0) return null;
  return (
    <div className="card" data-testid="exceptions">
      <h2>{t('aud.recovery.exceptions.title')}</h2>
      <p className="callout warning" role="status">
        {t('aud.recovery.exceptions.note', { count: summary.exceptions.length })}
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{t('aud.recovery.exceptions.col.code')}</th>
              <th>{t('aud.recovery.exceptions.col.kind')}</th>
              <th>{t('aud.recovery.exceptions.col.source')}</th>
              <th>{t('aud.recovery.exceptions.col.amount')}</th>
              <th>{t('aud.recovery.exceptions.col.day')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.exceptions.map((entry) => (
              <tr key={entry.id} data-exception-id={entry.id}>
                <td>
                  <strong>{entry.code}</strong>
                </td>
                <td>{exceptionKindLabel(t, entry.kind)}</td>
                <td>{sourceKindLabel(t, entry.sourceKind)}</td>
                <td>{formatVnd(entry.amountVnd)}</td>
                <td>{entry.recordedOn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sub">
        <Link to={`${ENGAGEMENT_PATH}?engagement=${summary.engagementId}`}>{t('aud.recovery.exceptions.file.link')}</Link>
      </p>
    </div>
  );
}
