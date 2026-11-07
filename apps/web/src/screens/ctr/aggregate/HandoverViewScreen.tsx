import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { kindLabel, statusLabel } from '../../ast/handover/labels';
import { READ_PERMISSION } from '../../ast/handover/model';
import { ViewFrame } from './ViewFrame';
import { useHandovers, useViewScope } from './hooks';
import { acceptedHandovers, ownerLink } from './model';
import { SectionCard } from '../../../ui';

/**
 * CTR-15: the completion and handover of a contract, read-only (ST-CTR-017, CTR section 7). AST owns the handovers and their minutes (AST-01, AST-02). The completion of a contract needs an
 * accepted handover and no critical item left (FR-CTR-15): the view shows the handovers with the items that are still critical, and how many have been accepted.
 */
export default function HandoverViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <HandoverContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HandoverContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const scope = useViewScope(READ_PERMISSION);
  const handovers = useHandovers(scope);
  return (
    <ViewFrame
      route={route}
      title={t('ctr.handoverView.page.title')}
      subtitle={t('ctr.handoverView.page.subtitle')}
      module="AST"
      scope={scope}
      loaded={handovers}
      isEmpty={(rows) => rows.length === 0}
      owners={[{ id: 'AST-01', to: ownerLink.handovers() }]}
    >
      {({ data }) => (
        <>
          <p className="callout" role="status" data-testid="accepted">
            {t('ctr.handoverView.accepted.notice', { accepted: acceptedHandovers(data).length, total: data.length })}
          </p>
          <SectionCard title={t('ctr.handoverView.table.label')}>
            <table className="table" data-testid="handovers">
              <thead>
                <tr>
                  <th scope="col">{t('ctr.handoverView.column.no')}</th>
                  <th scope="col">{t('ctr.handoverView.column.kind')}</th>
                  <th scope="col">{t('ctr.handoverView.column.status')}</th>
                  <th scope="col">{t('ctr.handoverView.column.unit')}</th>
                  <th scope="col">{t('ctr.handoverView.column.planned')}</th>
                  <th scope="col">{t('ctr.handoverView.column.handed')}</th>
                  <th scope="col">{t('ctr.handoverView.column.accepted')}</th>
                  <th scope="col" className="ctr-amount">
                    {t('ctr.handoverView.column.items')}
                  </th>
                  <th scope="col" className="ctr-amount">
                    {t('ctr.handoverView.column.critical')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((handover) => (
                  <tr key={handover.id} data-handover={handover.id}>
                    <td>
                      <Link to={ownerLink.handover(handover.id)} data-testid="open">
                        {handover.handoverNo}
                      </Link>
                    </td>
                    <td data-testid="kind">{kindLabel(t, handover.kind)}</td>
                    <td data-testid="status">{statusLabel(t, handover.status)}</td>
                    <td data-testid="unit">{handover.recipientUnit.name}</td>
                    <td data-testid="planned">{handover.plannedOn ?? '–'}</td>
                    <td data-testid="handed">{handover.handedOn ?? '–'}</td>
                    <td data-testid="accepted-at">{handover.acceptedAt === null ? '–' : handover.acceptedAt.slice(0, 10)}</td>
                    <td className="ctr-amount" data-testid="items">
                      {handover.itemCount}
                    </td>
                    <td className="ctr-amount" data-testid="critical">
                      {handover.openCriticalCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        </>
      )}
    </ViewFrame>
  );
}
