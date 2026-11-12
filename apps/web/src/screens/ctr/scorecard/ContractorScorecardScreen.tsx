import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { holds } from '../../../session/holds';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { amountText } from '../model';
import '../../qms/qms.css';
import { ApproveDialog, ConfirmDialog, EvaluateDialog, RecordDialog } from './Dialogs';
import { useScorecard, useScorecardContractors } from './hooks';
import type { Range } from './hooks';
import { criterionLabel, evaluationStatusLabel, kindLabel, penaltyLabel, ratingLabel, severityLabel, violationKindLabel, violationStatusLabel } from './labels';
import { APPROVE_PERMISSION, CONFIRM_PERMISSION, CRITERIA, EVALUATE_PERMISSION, READ_PERMISSION, RECORD_PERMISSION, SEVERITIES, rangeProblem, shownError } from './model';
import type { EvaluationLine, Scorecard, ViolationLine } from './model';

type Dialog = { kind: 'evaluate' } | { kind: 'record' } | { kind: 'approve'; evaluation: EvaluationLine } | { kind: 'confirm'; violation: ViolationLine };

/**
 * CTR-23: the scorecard of a contractor and the log of its violations over the contracts the caller reads (ST-CTR-014, CTR 3.6, BR-CTR-11). The evaluations show the five scores, the overall score the rule `CTR.SCORECARD` gives
 * them and the rating; the thresholds of the rating await the signature of the business owner and the screen says so. Another person approves an evaluation, and another confirms a violation, with the document that decides
 * a sanction. The server judges every command again.
 */
export default function ContractorScorecardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The dialogs belong to one membership: a switch of tenant or of membership starts the screen over, so nothing typed for one is sent for another.
  return <ScorecardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScorecardContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const namedId = search.get('id') ?? undefined;
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  // Opened without a contractor in the address (the menu, a typed URL), the first contractor of the list is read, and the picker stays to change it.
  const choices = useScorecardContractors(canRead && namedId === undefined);
  const contractorId = namedId ?? choices.data?.[0]?.id;
  const writable = mode !== 'READ_ONLY';
  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [draft, setDraft] = useState<Range>({ from: '', to: '' });
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [badRange, setBadRange] = useState(false);
  const card = useScorecard(contractorId, range, canRead);
  const state = useScreenState({
    isLoading: card.isLoading,
    // A refresh that fails for a break in the network while there is something to show keeps it; a refusal takes it away.
    error: shownError(card.error, card.data != null),
    data: card.data,
    isEmpty: (data: unknown) => data === null,
  });
  const view = card.data ?? undefined;
  const apply = (event: FormEvent): void => {
    event.preventDefault();
    // A range whose start is after its end is told here and is not asked of the server, so the filter is never taken away by a refusal.
    setBadRange(rangeProblem(draft));
    if (!rangeProblem(draft)) setRange(draft);
  };
  const evaluable = view?.contracts.filter((contract) => contract.mayEvaluate) ?? [];
  const recordable = view?.contracts.filter((contract) => contract.mayRecord) ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.scorecard.page.title')}</h1>
          <p>{view === undefined ? t('ctr.scorecard.page.subtitle') : t('ctr.scorecard.page.contractor', { name: view.contractor.legalName })}</p>
        </div>
      </div>
      {namedId === undefined && canRead ? <ContractorPicker current={contractorId} onPick={(id) => setSearch({ id })} /> : null}
      <StateBoundary state={!canRead ? 'denied' : contractorId === undefined ? (choices.isLoading ? 'loading' : 'empty') : state} onRetry={() => void card.refetch()}>
        {view === undefined ? null : (
          <>
            <form className="card" onSubmit={apply} aria-label={t('ctr.scorecard.range.aria')} data-testid="range">
              <label htmlFor="range-from">{t('ctr.scorecard.range.from')}</label>
              <input id="range-from" type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
              <label htmlFor="range-to">{t('ctr.scorecard.range.to')}</label>
              <input id="range-to" type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
              <button type="submit">{t('ctr.scorecard.range.apply')}</button>
              {badRange ? (
                <small role="alert" className="field-error" data-testid="range-problem">
                  {t('ctr.scorecard.range.invalid')}
                </small>
              ) : null}
            </form>
            <Summary view={view} />
            <section className="card" aria-labelledby="evaluations-title">
              <div className="heading">
                <h2 id="evaluations-title">{t('ctr.scorecard.evaluations.title')}</h2>
                {writable && holds(permissions, EVALUATE_PERMISSION) && evaluable.length > 0 ? (
                  <button type="button" className="primary" data-evaluate onClick={() => setDialog({ kind: 'evaluate' })}>
                    {t('ctr.scorecard.evaluate.action')}
                  </button>
                ) : null}
              </div>
              {view.summary.evaluationCount > view.evaluations.length ? (
                <p className="callout" role="note" data-testid="evaluations-cut">
                  {t('ctr.scorecard.list.cut', { shown: view.evaluations.length, total: view.summary.evaluationCount })}
                </p>
              ) : null}
              {view.evaluations.length === 0 ? (
                <p className="callout" role="status" data-testid="no-evaluations">
                  {t('ctr.scorecard.evaluations.empty')}
                </p>
              ) : (
                <table className="table" data-testid="evaluations">
                  <thead>
                    <tr>
                      <th scope="col">{t('ctr.scorecard.column.contract')}</th>
                      <th scope="col">{t('ctr.scorecard.column.period')}</th>
                      {CRITERIA.map((criterion) => (
                        <th key={criterion} scope="col">
                          {criterionLabel(t, criterion)}
                        </th>
                      ))}
                      <th scope="col">{t('ctr.scorecard.column.overall')}</th>
                      <th scope="col">{t('ctr.scorecard.column.rating')}</th>
                      <th scope="col">{t('ctr.scorecard.column.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ctr.scorecard.column.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.evaluations.map((line) => (
                      <tr key={line.id} data-evaluation={line.id} data-status={line.status}>
                        <td data-testid="contract">{line.contractCode}</td>
                        <td data-testid="period">
                          {kindLabel(t, line.kind)} · {line.periodLabel}
                          <small className="sub qms-regime">{t('ctr.scorecard.revision', { revision: line.revision })}</small>
                        </td>
                        {CRITERIA.map((criterion) => (
                          <td key={criterion} data-score={criterion}>
                            {line.scores[criterion]}
                          </td>
                        ))}
                        <td data-testid="overall">{line.overallScore}</td>
                        <td data-testid="rating">{ratingLabel(t, line.rating)}</td>
                        <td>
                          <span className={line.status === 'APPROVED' ? 'qms-badge ok' : 'qms-badge'} data-testid="status">
                            {evaluationStatusLabel(t, line.status)}
                          </span>
                        </td>
                        <td>
                          {writable && holds(permissions, APPROVE_PERMISSION) && line.canApprove ? (
                            <button type="button" data-approve={line.id} onClick={() => setDialog({ kind: 'approve', evaluation: line })}>
                              {t('ctr.scorecard.approve.action')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="callout" role="note" data-testid="rule">
                {t('ctr.scorecard.rule.weights', {
                  weights: CRITERIA.map((criterion) => `${criterionLabel(t, criterion)} ${view.rule.weights[criterion]}%`).join(', '),
                })}{' '}
                {view.rule.thresholds.map((threshold) => `${ratingLabel(t, threshold.rating)} ≥ ${threshold.min}`).join(', ')}
                {view.rule.awaitingConfirmation ? <strong data-testid="assumption"> {t('ctr.scorecard.rule.assumption')}</strong> : null}
              </p>
            </section>
            <section className="card" aria-labelledby="violations-title">
              <div className="heading">
                <h2 id="violations-title">{t('ctr.scorecard.violations.title')}</h2>
                {writable && holds(permissions, RECORD_PERMISSION) && recordable.length > 0 ? (
                  <button type="button" className="primary" data-record onClick={() => setDialog({ kind: 'record' })}>
                    {t('ctr.scorecard.record.action')}
                  </button>
                ) : null}
              </div>
              {view.summary.violationCount > view.violations.length ? (
                <p className="callout" role="note" data-testid="violations-cut">
                  {t('ctr.scorecard.list.cut', { shown: view.violations.length, total: view.summary.violationCount })}
                </p>
              ) : null}
              {view.violations.length === 0 ? (
                <p className="callout" role="status" data-testid="no-violations">
                  {t('ctr.scorecard.violations.empty')}
                </p>
              ) : (
                <table className="table" data-testid="violations">
                  <thead>
                    <tr>
                      <th scope="col">{t('ctr.scorecard.column.contract')}</th>
                      <th scope="col">{t('ctr.scorecard.column.violation')}</th>
                      <th scope="col">{t('ctr.scorecard.column.occurredOn')}</th>
                      <th scope="col">{t('ctr.scorecard.column.description')}</th>
                      <th scope="col">{t('ctr.scorecard.column.penalty')}</th>
                      <th scope="col">{t('ctr.scorecard.column.status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ctr.scorecard.column.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.violations.map((line) => (
                      <tr key={line.id} data-violation={line.id} data-status={line.status}>
                        <td data-testid="contract">{line.contractCode}</td>
                        <td data-testid="kind">
                          {violationKindLabel(t, line.kind)} · {severityLabel(t, line.severity)}
                        </td>
                        <td data-testid="day">{line.occurredOn}</td>
                        <td data-testid="description">{line.description}</td>
                        <td data-testid="penalty">
                          {penaltyLabel(t, line.penaltyKind)}
                          {line.penaltyAmountVnd === '0' ? null : <small className="sub qms-regime">{t('ctr.value.amount', { amount: amountText(line.penaltyAmountVnd, locale) })}</small>}
                        </td>
                        <td>
                          <span className={line.status === 'CONFIRMED' ? 'qms-badge ok' : 'qms-badge'} data-testid="status">
                            {violationStatusLabel(t, line.status)}
                          </span>
                        </td>
                        <td>
                          {writable && holds(permissions, CONFIRM_PERMISSION) && line.canConfirm ? (
                            <button type="button" data-confirm={line.id} onClick={() => setDialog({ kind: 'confirm', violation: line })}>
                              {t('ctr.scorecard.confirm.action')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {dialog?.kind === 'evaluate' ? <EvaluateDialog contracts={evaluable} rule={view.rule} onClose={() => setDialog(undefined)} /> : null}
            {dialog?.kind === 'record' ? <RecordDialog contracts={recordable} onClose={() => setDialog(undefined)} /> : null}
            {dialog?.kind === 'approve' ? <ApproveDialog evaluation={dialog.evaluation} onClose={() => setDialog(undefined)} /> : null}
            {dialog?.kind === 'confirm' ? <ConfirmDialog violation={dialog.violation} onClose={() => setDialog(undefined)} /> : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('ctr.scorecard.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The contractors that hold a contract (the verified ones), to choose the one whose scorecard is read: a person who reaches the screen from the menu has no contractor in the address yet. */
function ContractorPicker({ current, onPick }: { current: string | undefined; onPick(id: string): void }) {
  const { t } = useTranslation();
  const contractors = useScorecardContractors(true);
  const [picked, setPicked] = useState('');
  // Until the reader chooses, the select shows the contractor whose scorecard is on the screen.
  const chosen = picked !== '' ? picked : (current ?? '');
  const setChosen = setPicked;
  return (
    <form
      className="card"
      aria-label={t('ctr.scorecard.pick.aria')}
      data-testid="picker"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen !== '') onPick(chosen);
      }}
    >
      <label htmlFor="pick-contractor">{t('ctr.scorecard.pick.label')}</label>
      <select id="pick-contractor" value={chosen} onChange={(event) => setChosen(event.target.value)}>
        <option value="">{t('ctr.scorecard.pick.choose')}</option>
        {(contractors.data ?? []).map((contractor) => (
          <option key={contractor.id} value={contractor.id}>
            {t('ctr.scorecard.pick.option', { name: contractor.name, count: contractor.contracts })}
          </option>
        ))}
      </select>
      <button type="submit" disabled={chosen === ''}>
        {t('ctr.scorecard.pick.action')}
      </button>
      {contractors.isError ? (
        <small role="alert" className="field-error" data-testid="pick-failed">
          {t('ctr.scorecard.pick.failed')}
        </small>
      ) : null}
    </form>
  );
}

function Summary({ view }: { view: Scorecard }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="summary">
      <strong data-testid="approved">{t('ctr.scorecard.summary.approved', { count: view.summary.approvedCount })}</strong>
      <small className="sub qms-regime" data-testid="average">
        {view.summary.averageOverallScore === undefined ? t('ctr.scorecard.summary.average.none') : t('ctr.scorecard.summary.average', { score: view.summary.averageOverallScore })}
      </small>
      <small className="sub qms-regime" data-testid="confirmed">
        {t('ctr.scorecard.summary.confirmed', SEVERITIES.reduce<Record<string, number>>((all, severity) => ({ ...all, [severity.toLowerCase()]: view.summary.confirmed[severity] }), {}))}
      </small>
    </div>
  );
}
