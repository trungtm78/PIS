import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { useNonconformances } from './hooks';
import { actionStatusLabel, laneLabel, severityLabel, sourceLabel, statusLabel } from './labels';
import { LANES, answerable, canRaise, inLane, verifiable } from './model';
import type { ActionLine, NcrLine } from './model';
import { AssignDialog, CloseDialog, EvidenceDialog, RaiseDialog, ReopenDialog, VerifyDialog } from './NonconformanceDialogs';
import '../qms.css';

/**
 * QMS-07: the non-conformances of the work under a contract and the actions that put them right (ST-QMS-006, QMS 3.3, BR-QMS-07). A board of lanes: raised, being put right, awaiting
 * verification, verified and closed. A critical non-conformance holds back the quality acceptance until it is closed. The person given an action answers it with evidence; someone other
 * than the people responsible verifies it or gives it back; a non-conformance whose actions are all verified is closed by someone who is none of them, and a closed one can be reopened.
 * The server judges every command again.
 */
export default function NonconformanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <NonconformanceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog =
  | { kind: 'raise' }
  | { kind: 'assign'; line: NcrLine }
  | { kind: 'evidence'; line: NcrLine; action: ActionLine }
  | { kind: 'verify'; line: NcrLine; action: ActionLine }
  | { kind: 'close'; line: NcrLine }
  | { kind: 'reopen'; line: NcrLine };

function NonconformanceContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const me = tenant?.membershipId;
  const [search, setSearch] = useSearchParams();
  const contracts = useContracts();
  // Whoever may read non-conformances and not the register still reads them: only the filter and the choice of a contract are missing.
  const options = useMemo(() => contracts.data ?? [], [contracts.data]);
  const wanted = search.get('contract') ?? '';
  const contractId = options.some((contract) => contract.id === wanted) ? wanted : '';
  const board = useNonconformances(contractId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // A tenant with no non-conformance is not an empty screen: the supervisor still raises the first.
  const state = useScreenState({ isLoading: board.isLoading, error: board.error, data: board.data, isEmpty: () => false });
  const lines = board.data ?? [];
  const active = useMemo(() => options.filter((contract) => contract.status === 'ACTIVE'), [options]);
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const choose = (id: string): void => setSearch(id === '' ? {} : { contract: id });
  const writable = mode !== 'READ_ONLY';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.ncr.page.title')}</h1>
          <p>{t('qms.ncr.page.subtitle')}</p>
        </div>
        {canRaise(permissions, mode) && active.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'raise' })}>
              {t('qms.ncr.raise.action')}
            </button>
          </div>
        ) : null}
      </div>
      {options.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="ncr-filter-contract">{t('qms.ncr.filter.contract')}</label>
            <select id="ncr-filter-contract" value={contractId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('qms.ncr.filter.all')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void board.refetch()}>
        {lines.length === 0 ? (
          <div className="card">
            <p className="callout" role="status" data-testid="no-nonconformances">
              {t('qms.ncr.none.notice')}
            </p>
          </div>
        ) : (
          <div className="qms-board" data-testid="board">
            {LANES.map((lane) => {
              const cards = inLane(lines, lane);
              const headingId = `ncr-lane-${lane}`;
              return (
                <section key={lane} className="card qms-lane" data-lane={lane} aria-labelledby={headingId}>
                  <h2 id={headingId}>
                    {laneLabel(t, lane)} <span className="qms-badge">{cards.length}</span>
                  </h2>
                  {cards.map((line) => (
                    <article key={line.id} className="qms-card" data-ncr={line.id} data-status={line.status} data-severity={line.severity}>
                      <header>
                        <strong data-testid="no">{line.ncrNo}</strong> <span data-testid="title">{line.title}</span>
                      </header>
                      <p className="sub qms-regime">
                        {line.contract.code}
                        {line.sourceKind === null ? '' : ` · ${sourceLabel(t, line.sourceKind)}`}
                      </p>
                      <p>
                        <span className={line.severity === 'CRITICAL' ? 'qms-badge danger' : line.severity === 'MAJOR' ? 'qms-badge warning' : 'qms-badge'} data-testid="severity">
                          {severityLabel(t, line.severity)}
                        </span>{' '}
                        <span className="qms-badge" data-testid="status">
                          {statusLabel(t, line.status)}
                        </span>
                        {line.blocksAcceptance && line.status !== 'CLOSED' ? (
                          <>
                            {' '}
                            <span className="qms-badge danger" data-testid="blocks" role="status">
                              {t('qms.ncr.blocks.badge')}
                            </span>
                          </>
                        ) : null}
                        {line.overdue ? (
                          <>
                            {' '}
                            <span className="qms-badge warning" data-testid="overdue" role="status">
                              {t('qms.ncr.overdue.badge')}
                            </span>
                          </>
                        ) : null}
                      </p>
                      <p className="sub qms-regime" data-testid="due">
                        {t('qms.ncr.due.label', { at: moment(line.dueAt), owner: line.actionOwner.displayName })}
                      </p>
                      <details>
                        <summary>{t('qms.ncr.description.summary')}</summary>
                        <p>{line.description}</p>
                        {line.rootCause === null ? null : <p data-testid="root-cause">{t('qms.ncr.rootCause.label', { cause: line.rootCause })}</p>}
                        {line.closureNote === null ? null : <p data-testid="closure-note">{t('qms.ncr.closureNote.label', { note: line.closureNote })}</p>}
                        {line.reopenReason === null ? null : <p data-testid="reopen-reason">{t('qms.ncr.reopenReason.label', { reason: line.reopenReason, count: line.reopenCount })}</p>}
                      </details>
                      {line.actions.length === 0 ? null : (
                        <ul className="qms-actions" data-testid="actions">
                          {line.actions.map((action) => (
                            <li key={action.id} data-action={action.id} data-status={action.status}>
                              {action.description} — {action.owner.displayName} ·{' '}
                              <span className="qms-badge" data-testid="action-status">
                                {actionStatusLabel(t, action.status)}
                              </span>
                              {action.overdue ? (
                                <span className="qms-badge warning" data-testid="action-overdue" role="status">
                                  {' '}
                                  {t('qms.ncr.overdue.badge')}
                                </span>
                              ) : null}
                              {action.verificationNote !== null && action.status === 'REJECTED' ? (
                                <small className="sub qms-regime">{t('qms.ncr.action.rejected.note', { note: action.verificationNote })}</small>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      {writable ? (
                        <div className="actions">
                          {line.allowed.assign ? (
                            <button type="button" data-assign={line.id} onClick={() => setDialog({ kind: 'assign', line })}>
                              {t('qms.ncr.assign.action')}
                            </button>
                          ) : null}
                          {answerable(line, me).map((action) => (
                            <button key={action.id} type="button" data-evidence={action.id} onClick={() => setDialog({ kind: 'evidence', line, action })}>
                              {t('qms.ncr.evidence.action')}
                            </button>
                          ))}
                          {verifiable(line, me).map((action) => (
                            <button key={action.id} type="button" data-verify={action.id} onClick={() => setDialog({ kind: 'verify', line, action })}>
                              {t('qms.ncr.verify.action')}
                            </button>
                          ))}
                          {line.allowed.close ? (
                            <button type="button" data-close={line.id} onClick={() => setDialog({ kind: 'close', line })}>
                              {t('qms.ncr.close.action')}
                            </button>
                          ) : null}
                          {line.allowed.reopen ? (
                            <button type="button" data-reopen={line.id} onClick={() => setDialog({ kind: 'reopen', line })}>
                              {t('qms.ncr.reopen.action')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'raise' ? <RaiseDialog contracts={active} initialContractId={contractId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'assign' ? <AssignDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'evidence' ? <EvidenceDialog line={dialog.line} action={dialog.action} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'verify' ? <VerifyDialog line={dialog.line} action={dialog.action} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'close' ? <CloseDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'reopen' ? <ReopenDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('qms.ncr.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
