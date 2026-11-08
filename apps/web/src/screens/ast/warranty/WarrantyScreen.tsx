import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { amountText } from '../../ctr/model';
import { useHandovers } from '../handover/hooks';
import { ExpiringWarranties } from './ExpiringWarranties';
import { useWarranties } from './hooks';
import { gradeLabel, statusLabel } from './labels';
import { canManage, daysLeft, vietnamToday } from './model';
import type { WarrantyLine } from './model';
import { CloseDialog, CreateDialog } from './WarrantyDialogs';
import '../../qms/qms.css';

/**
 * AST-04: the warranty a work carries after its handover (ST-AST-003, AST 3.3, BR-AST-03, BR-AST-05). Each obligation shows what it covers, when it starts and ends, the guarantee and the amount held
 * back, the claims still open and its status; the term is judged by the minimum the rule data states for the grade of the work, and the screen says when that rule still waits for the
 * confirmation of its source. The project office creates an obligation for an accepted handover and closes it once it has run out and no claim is open: that is what lets the retention and the
 * guarantee be released. The server judges every command again.
 */
export default function WarrantyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The dossier and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <WarrantyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'create' } | { kind: 'close'; warranty: WarrantyLine };

function WarrantyContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const handovers = useHandovers('');
  // Whoever may read the warranty and not the handovers still reads it: only the filter and the choice of a handover are missing.
  const accepted = useMemo(() => (handovers.data ?? []).filter((handover) => handover.status === 'ACCEPTED'), [handovers.data]);
  const wanted = search.get('handover') ?? '';
  const handoverId = accepted.some((handover) => handover.id === wanted) ? wanted : '';
  const warranties = useWarranties(handoverId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // A tenant with no obligation is not an empty screen: the project office still creates the first.
  const state = useScreenState({ isLoading: warranties.isLoading, error: warranties.error, data: warranties.data, isEmpty: () => false });
  const lines = warranties.data ?? [];
  const choose = (id: string): void => setSearch(id === '' ? {} : { handover: id });
  const writable = mode !== 'READ_ONLY';
  const today = vietnamToday();
  const money = (value: string): string => t('ctr.value.amount', { amount: amountText(value, locale) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.warranty.page.title')}</h1>
          <p>{t('ast.warranty.page.subtitle')}</p>
        </div>
        {canManage(permissions, mode) && accepted.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'create' })}>
              {t('ast.warranty.create.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ExpiringWarranties />
      {accepted.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="warranty-filter">{t('ast.warranty.filter.handover')}</label>
            <select id="warranty-filter" value={handoverId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('ast.warranty.filter.all')}</option>
              {accepted.map((handover) => (
                <option key={handover.id} value={handover.id}>
                  {`${handover.handoverNo} · ${handover.contract.code}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void warranties.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-warranties">
              {t('ast.warranty.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="warranties">
              <thead>
                <tr>
                  <th scope="col">{t('ast.warranty.column.obligation')}</th>
                  <th scope="col">{t('ast.warranty.column.term')}</th>
                  <th scope="col">{t('ast.warranty.column.guarantee')}</th>
                  <th scope="col">{t('ast.warranty.column.retention')}</th>
                  <th scope="col">{t('ast.warranty.column.claims')}</th>
                  <th scope="col">{t('ast.warranty.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('ast.warranty.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const left = daysLeft(line.endsOn, today);
                  return (
                    <tr key={line.id} data-warranty={line.id} data-status={line.status}>
                      <td>
                        <strong data-testid="scope">{line.scope}</strong>
                        <small className="sub qms-regime" data-testid="handover">{`${line.handover.handoverNo ?? ''} · ${line.contract.code}`}</small>
                        {line.asset === null ? null : <small className="sub qms-regime" data-testid="asset">{`${line.asset.assetCode} · ${line.asset.name ?? ''}`}</small>}
                      </td>
                      <td>
                        <span data-testid="term">{t('ast.warranty.term.range', { from: line.startsOn, to: line.endsOn })}</span>
                        <small className="sub qms-regime">{`${t('ast.warranty.term.months', { months: line.periodMonths })} · ${gradeLabel(t, line.constructionGrade)}`}</small>
                        {line.status === 'CLOSED' ? null : (
                          <small className="sub qms-regime" data-testid="left">
                            {left > 0 ? t('ast.warranty.term.left', { days: left }) : t('ast.warranty.term.over')}
                          </small>
                        )}
                        {line.rule?.awaitingConfirmation === true ? (
                          <small className="sub qms-regime" role="status" data-testid="rule-waiting">
                            {t('ast.warranty.rule.waiting', { months: line.minimumMonths ?? '', cxn: line.rule.cxn ?? '' })}
                          </small>
                        ) : null}
                      </td>
                      <td data-testid="guarantee">
                        {line.guarantee === null ? (
                          t('ast.warranty.guarantee.none')
                        ) : (
                          <>
                            {`${line.guarantee.issuer}${line.guarantee.guaranteeNo === null ? '' : ` · ${line.guarantee.guaranteeNo}`}`}
                            <small className="sub qms-regime">{money(line.guarantee.amountVnd)}</small>
                          </>
                        )}
                      </td>
                      <td data-testid="retention">{money(line.retentionAmountVnd)}</td>
                      <td data-testid="claims">{t('ast.warranty.claims.count', { open: line.openClaims, total: line.totalClaims })}</td>
                      <td>
                        <span className={line.status === 'CLOSED' ? 'qms-badge ok' : line.status === 'EXPIRED' ? 'qms-badge warning' : 'qms-badge'} data-testid="status">
                          {statusLabel(t, line.status)}
                        </span>
                        {line.closedAt === null ? null : <small className="sub qms-regime">{t('ast.warranty.closed.on', { day: line.closedAt.slice(0, 10) })}</small>}
                      </td>
                      <td>
                        {writable && line.canClose ? (
                          <button type="button" data-close={line.id} onClick={() => setDialog({ kind: 'close', warranty: line })}>
                            {t('ast.warranty.close.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      {dialog?.kind === 'create' ? <CreateDialog handovers={accepted} initialHandoverId={handoverId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'close' ? <CloseDialog warranty={dialog.warranty} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('ast.warranty.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
