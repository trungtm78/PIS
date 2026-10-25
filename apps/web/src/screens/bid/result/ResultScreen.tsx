import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { formatVnd } from '../plan-model';
import { useTrackedPackages } from '../procurement/hooks';
import { useResults } from './hooks';
import { outcomeLabel, statusLabel } from './labels';
import { canApprove, canDecide, canSubmit, canSubmitFor, resultPackages } from './model';
import type { ResultLine } from './model';
import { DecideDialog, SubmitDialog } from './ResultDialogs';
import '../bid.css';

/**
 * BID-18: the result of the selection of a contractor (ST-BID-006, BID 3 F7). A proposer submits the result of a package whose plan is in force (the award is no more than the price
 * of the package, goes to a contractor no restriction stops, and rests on an evaluation that was issued); an authority who did not submit it approves it on a decision document or
 * turns it down with the reason. The screen says in words that the decision is a person's and offers nothing a machine produced.
 */
export default function ResultScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages, the results and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ResultContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'submit' } | { kind: 'decide'; line: ResultLine };

function ResultContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const packages = useTrackedPackages();
  const options = useMemo(() => resultPackages(packages.data ?? []), [packages.data]);
  const wanted = search.get('package') ?? '';
  const packageId = options.some((pack) => pack.id === wanted) ? wanted : '';
  const pack = options.find((candidate) => candidate.id === packageId);
  const results = useResults(packageId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({
    isLoading: packages.isLoading,
    error: packages.error,
    data: packages.data,
    isEmpty: (data) => resultPackages(data as typeof options).length === 0,
  });
  // A package with no result is not an empty screen: the proposer still submits the first.
  const resultState = useScreenState({ isLoading: results.isLoading, error: results.error, data: results.data, isEmpty: () => false });
  const lines = results.data ?? [];
  const when = (moment: string | null): string => (moment === null ? t('bid.results.none.text') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(moment)));
  const choose = (id: string): void => setSearch(id === '' ? {} : { package: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.results.page.title')}</h1>
          <p>{t('bid.results.page.subtitle')}</p>
        </div>
        {pack !== undefined && canSubmit(permissions, mode) && canSubmitFor(pack, lines) ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'submit' })}>
              {t('bid.results.submit.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="no-ai">
        {t('bid.results.noAi.notice')}
      </p>
      <StateBoundary state={state} onRetry={() => void packages.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="results-package">{t('bid.results.package.label')}</label>
            <select id="results-package" value={packageId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('bid.results.package.choose')}</option>
              {options.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          {pack === undefined ? (
            <p className="sub" data-testid="choose-package">
              {t('bid.results.package.hint')}
            </p>
          ) : (
            <p className="sub" data-testid="package-status">
              {t('bid.results.package.status', { project: pack.project.code, status: pack.status })}
            </p>
          )}
        </div>
        {pack === undefined ? null : (
          <StateBoundary state={resultState} onRetry={() => void results.refetch()}>
            <div className="card">
              {lines.length === 0 ? (
                <p className="callout" role="status" data-testid="no-results">
                  {t('bid.results.none.notice')}
                </p>
              ) : (
                <table className="table" data-testid="results">
                  <thead>
                    <tr>
                      <th scope="col">{t('bid.results.column.outcome')}</th>
                      <th scope="col">{t('bid.results.column.winner')}</th>
                      <th scope="col">{t('bid.results.column.price')}</th>
                      <th scope="col">{t('bid.results.column.minutes')}</th>
                      <th scope="col">{t('bid.results.column.submitted')}</th>
                      <th scope="col">{t('bid.results.column.decided')}</th>
                      <th scope="col">{t('bid.results.column.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('bid.results.column.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id} data-result={line.id} data-status={line.status}>
                        <td data-testid="outcome">{outcomeLabel(t, line.outcome)}</td>
                        <td data-testid="winner">{line.winner === null ? t('bid.results.none.text') : line.winner.legalName}</td>
                        <td data-testid="price">
                          {line.awardPriceVnd === null ? t('bid.results.none.text') : t('bid.results.price.value', { price: formatVnd(line.awardPriceVnd), budget: formatVnd(line.package.budgetVnd) })}
                        </td>
                        <td data-testid="minutes">{line.evaluationMinutes === null ? t('bid.results.none.text') : line.evaluationMinutes.title}</td>
                        <td data-testid="submitted">
                          {line.submittedBy === null ? t('bid.results.none.text') : t('bid.results.person.value', { name: line.submittedBy.displayName, at: when(line.submittedAt) })}
                        </td>
                        <td data-testid="decided">
                          {line.decidedBy === null ? t('bid.results.none.text') : t('bid.results.person.value', { name: line.decidedBy.displayName, at: when(line.decidedAt) })}
                          {line.comment === null ? null : <span className="sub"> {line.comment}</span>}
                        </td>
                        <td>
                          <span className={line.status === 'APPROVED' ? 'bid-badge ok' : line.status === 'REJECTED' ? 'bid-badge danger' : 'bid-badge warning'} data-testid="status">
                            {statusLabel(t, line.status)}
                          </span>
                        </td>
                        <td>
                          {canDecide(line, tenant?.membershipId, permissions, mode) ? (
                            <button type="button" data-decide={line.id} onClick={() => setDialog({ kind: 'decide', line })}>
                              {t('bid.results.decide.action')}
                            </button>
                          ) : line.status === 'SUBMITTED' && canApprove(permissions, mode) ? (
                            <small className="sub" data-testid="own-result">
                              {t('bid.results.own.notice')}
                            </small>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </StateBoundary>
        )}
      </StateBoundary>
      {dialog?.kind === 'submit' && pack !== undefined ? <SubmitDialog pack={pack} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'decide' ? <DecideDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('bid.results.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
