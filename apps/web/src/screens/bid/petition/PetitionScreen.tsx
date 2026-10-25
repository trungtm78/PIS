import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useTrackedPackages } from '../procurement/hooks';
import { DeclarationPanel } from '../proposal/DeclarationPanel';
import { canEvaluate } from '../proposal/model';
import { usePetitions } from './hooks';
import { kindLabel, statusLabel } from './labels';
import { canReceive } from './model';
import type { PetitionLine } from './model';
import { ReceiveDialog, ResolveDialog } from './PetitionDialogs';
import '../bid.css';

/**
 * BID-20: the petitions of contractors and the conflicts of interest of a package (ST-BID-007, BID 3 F7, BR-BID-14). A planner logs a petition of a contractor about the process or the
 * result; the last day to answer is counted from the rule data in force on the day it arrived, and a petition that waits past that day is shown overdue with the days past it. The petition
 * is answered with a document, or passed on to the level above with one; whoever has a conflict of interest with the contractor or the package is told that another person answers.
 * Below the petitions the screen shows the declarations of conflict of interest of the package, which whoever decides them decides there.
 */
export default function PetitionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages, the petitions and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PetitionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'receive' } | { kind: 'resolve'; line: PetitionLine };

function PetitionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const packages = useTrackedPackages();
  const options = useMemo(() => packages.data ?? [], [packages.data]);
  const wanted = search.get('package') ?? '';
  const packageId = options.some((pack) => pack.id === wanted) ? wanted : '';
  const pack = options.find((candidate) => candidate.id === packageId);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const petitions = usePetitions(packageId, overdueOnly);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: packages.isLoading, error: packages.error, data: packages.data, isEmpty: (data) => (data as typeof options).length === 0 });
  // A package with no petition is not an empty screen: the planner still logs the first.
  const petitionState = useScreenState({ isLoading: petitions.isLoading, error: petitions.error, data: petitions.data, isEmpty: () => false });
  const lines = petitions.data ?? [];
  const day = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const choose = (id: string): void => setSearch(id === '' ? {} : { package: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.petitions.page.title')}</h1>
          <p>{t('bid.petitions.page.subtitle')}</p>
        </div>
        {pack !== undefined && canReceive(permissions, mode) ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'receive' })}>
              {t('bid.petitions.receive.action')}
            </button>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void packages.refetch()}>
        <div className="card">
          <div className="field">
            <label htmlFor="petitions-package">{t('bid.petitions.package.label')}</label>
            <select id="petitions-package" value={packageId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('bid.petitions.package.choose')}</option>
              {options.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title === null ? candidate.code : `${candidate.code} · ${candidate.title}`}
                </option>
              ))}
            </select>
          </div>
          {pack === undefined ? (
            <p className="sub" data-testid="choose-package">
              {t('bid.petitions.package.hint')}
            </p>
          ) : (
            <label className="checkbox">
              <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} /> {t('bid.petitions.overdueOnly.label')}
            </label>
          )}
        </div>
        {pack === undefined ? null : (
          <>
            <StateBoundary state={petitionState} onRetry={() => void petitions.refetch()}>
              <div className="card">
                {lines.length === 0 ? (
                  <p className="callout" role="status" data-testid="no-petitions">
                    {overdueOnly ? t('bid.petitions.none.overdue') : t('bid.petitions.none.notice')}
                  </p>
                ) : (
                  <table className="table" data-testid="petitions">
                    <thead>
                      <tr>
                        <th scope="col">{t('bid.petitions.column.kind')}</th>
                        <th scope="col">{t('bid.petitions.column.contractor')}</th>
                        <th scope="col">{t('bid.petitions.column.received')}</th>
                        <th scope="col">{t('bid.petitions.column.due')}</th>
                        <th scope="col">{t('bid.petitions.column.status')}</th>
                        <th scope="col">{t('bid.petitions.column.handler')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('bid.petitions.column.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.id} data-petition={line.id} data-status={line.status} data-overdue={line.overdue ? 'true' : 'false'}>
                          <td data-testid="kind">{kindLabel(t, line.petitionKind)}</td>
                          <td data-testid="contractor">{line.contractor.legalName}</td>
                          <td data-testid="received">{day(line.receivedOn)}</td>
                          <td data-testid="due">
                            {day(line.dueOn)} <small className="sub">{t('bid.petitions.due.days', { days: line.daysApplied })}</small>
                            {line.overdue ? (
                              <span className="bid-badge danger" data-testid="overdue">
                                {t('bid.petitions.overdue.badge', { days: line.daysOverdue })}
                              </span>
                            ) : null}
                          </td>
                          <td>
                            <span className={line.status === 'RESOLVED' ? 'bid-badge ok' : 'bid-badge warning'} data-testid="status">
                              {statusLabel(t, line.status)}
                            </span>
                          </td>
                          <td data-testid="handler">{line.handledBy === null ? t('bid.petitions.none.text') : line.handledBy.displayName}</td>
                          <td>
                            {line.canResolve && mode !== 'READ_ONLY' ? (
                              <button type="button" data-resolve={line.id} onClick={() => setDialog({ kind: 'resolve', line })}>
                                {t('bid.petitions.resolve.action')}
                              </button>
                            ) : line.viewerInConflict && (line.status === 'RECEIVED' || line.status === 'PROCESSING' || line.status === 'ESCALATED') ? (
                              <small className="sub" data-testid="conflict-note">
                                {t('bid.petitions.conflict.notice')}
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
            <DeclarationPanel pack={pack} mayEvaluate={canEvaluate(permissions, mode)} />
          </>
        )}
      </StateBoundary>
      {dialog?.kind === 'receive' && pack !== undefined ? <ReceiveDialog pack={pack} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'resolve' ? <ResolveDialog line={dialog.line} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('bid.petitions.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
