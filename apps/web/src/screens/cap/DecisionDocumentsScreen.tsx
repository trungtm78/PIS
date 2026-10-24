import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { APPROVAL_PATH, BOOK_PATH } from './approval-model';
import { Money } from './components';
import { decisionRows } from './decision-model';
import type { DecisionRow } from './decision-model';
import { useAppropriations } from './hooks';
import { originLabel } from './labels';
import { PlanStatusBadge } from './plan-components';
import { usePlans } from './plan-hooks';
import './cap.css';

/**
 * CAP-05: the decisions that give capital out. Every row is a decision document (its number, the authority that issued it, its date) and the
 * thing it backs: capital assigned to the province, which opens in the register, or a capital plan revision, which opens on its approval
 * screen. The value is exact; a revision that was replaced stays in the list with its note.
 */
export default function DecisionDocumentsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DecisionDocumentsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DecisionDocumentsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const appropriations = useAppropriations();
  const plans = usePlans();
  const rows = useMemo(() => decisionRows(appropriations.data ?? [], plans.data ?? []), [appropriations.data, plans.data]);
  const state = useScreenState({
    isLoading: appropriations.isLoading || plans.isLoading,
    error: appropriations.error ?? plans.error,
    data: appropriations.data === undefined || plans.data === undefined ? undefined : rows,
  });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.decisions.page.title')}</h1>
          <p>{t('cap.decisions.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void appropriations.refetch();
          void plans.refetch();
        }}
      >
        <div className="card">
          <div className="cap-scroll">
            <table className="table cap-table" data-testid="decisions" aria-label={t('cap.decisions.table.aria')}>
              <caption className="sr-only">{t('cap.decisions.table.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('cap.decisions.column.symbol')}</th>
                  <th scope="col">{t('cap.decisions.column.authority')}</th>
                  <th scope="col">{t('cap.decisions.column.date')}</th>
                  <th scope="col" className="cap-number">
                    {t('cap.decisions.column.value')}
                  </th>
                  <th scope="col">{t('cap.decisions.column.basis')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DecisionLine key={row.key} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('cap.decisions.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DecisionLine({ row }: { row: DecisionRow }) {
  const { t } = useTranslation();
  const { basis } = row;
  return (
    <tr data-document-id={row.documentId} data-basis={basis.kind}>
      <th scope="row">{row.symbol ?? t('cap.decision.noSymbol.label')}</th>
      <td>{row.authority ?? t('cap.decisions.authority.none')}</td>
      <td>{row.issuedOn ?? t('cap.decisions.date.none')}</td>
      <td className="cap-number">
        <Money vnd={row.valueVnd} />
      </td>
      <td>
        {basis.kind === 'APPROPRIATION' ? (
          <Link to={BOOK_PATH}>
            {t('cap.decisions.basis.appropriation.label', { fund: basis.line.fundSource.businessKey, year: basis.line.planYear, origin: originLabel(t, basis.line.origin) })}
          </Link>
        ) : (
          <>
            <Link to={`${APPROVAL_PATH}?plan=${basis.plan.id}`}>{t('cap.decisions.basis.plan.label', { code: basis.plan.planCode, revision: basis.plan.revision })}</Link>{' '}
            <PlanStatusBadge plan={basis.plan} />
            {basis.plan.status === 'SUPERSEDED' ? <small className="sub"> {t('cap.approval.superseded.label')}</small> : null}
          </>
        )}
      </td>
    </tr>
  );
}
