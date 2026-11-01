import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { statusLabel } from '../../ast/warranty/labels';
import { READ_PERMISSION } from '../../ast/warranty/model';
import { amountText } from '../model';
import { ViewFrame } from './ViewFrame';
import { useViewScope, useWarranties } from './hooks';
import { ownerLink, runningWarranties } from './model';

/**
 * CTR-16: the warranty of the work of a contract and the defects left to put right, read-only (ST-CTR-017, CTR section 7). AST owns the obligations and their claims (AST-04, AST-05). The
 * release of the retention and of the warranty guarantee is done on CTR-05 and CTR-21, not here; the amounts of the guarantee and of the retention are the financial columns, which a guest
 * contractor does not see.
 */
export default function WarrantyViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <WarrantyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WarrantyContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const scope = useViewScope(READ_PERMISSION);
  const warranties = useWarranties(scope);
  return (
    <ViewFrame
      route={route}
      title={t('ctr.warrantyView.page.title')}
      subtitle={t('ctr.warrantyView.page.subtitle')}
      module="AST"
      scope={scope}
      loaded={warranties}
      isEmpty={(rows) => rows.length === 0}
      owners={[{ id: 'AST-04', to: ownerLink.warranties() }]}
    >
      {({ data, financial }) => (
        <>
          <p className="callout" role="status" data-testid="running">
            {t('ctr.warrantyView.running.notice', { running: runningWarranties(data).length, total: data.length })}
          </p>
          <article className="card" aria-label={t('ctr.warrantyView.table.label')}>
            <table className="table" data-testid="warranties">
              <thead>
                <tr>
                  <th scope="col">{t('ctr.warrantyView.column.scope')}</th>
                  <th scope="col">{t('ctr.warrantyView.column.handover')}</th>
                  <th scope="col">{t('ctr.warrantyView.column.starts')}</th>
                  <th scope="col">{t('ctr.warrantyView.column.ends')}</th>
                  <th scope="col" className="ctr-amount">
                    {t('ctr.warrantyView.column.months')}
                  </th>
                  <th scope="col">{t('ctr.warrantyView.column.status')}</th>
                  <th scope="col" className="ctr-amount">
                    {t('ctr.warrantyView.column.claims')}
                  </th>
                  {financial ? (
                    <>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.warrantyView.column.guarantee')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.warrantyView.column.retention')}
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {data.map((warranty) => (
                  <tr key={warranty.id} data-warranty={warranty.id}>
                    <td>
                      <Link to={ownerLink.warranties(warranty.handover.id)} data-testid="open">
                        {warranty.asset === null ? warranty.scope : `${warranty.asset.assetCode} · ${warranty.asset.name ?? ''}`}
                      </Link>
                    </td>
                    <td data-testid="handover">{warranty.handover.handoverNo ?? '–'}</td>
                    <td data-testid="starts">{warranty.startsOn}</td>
                    <td data-testid="ends">{warranty.endsOn}</td>
                    <td className="ctr-amount" data-testid="months">
                      {warranty.periodMonths}
                    </td>
                    <td data-testid="status">{statusLabel(t, warranty.status)}</td>
                    <td className="ctr-amount" data-testid="claims">
                      {t('ctr.warrantyView.claims.value', { open: warranty.openClaims, total: warranty.totalClaims })}
                    </td>
                    {financial ? (
                      <>
                        <td className="ctr-amount" data-testid="guarantee">
                          {warranty.guarantee === null ? '–' : amountText(warranty.guarantee.amountVnd, locale)}
                        </td>
                        <td className="ctr-amount" data-testid="retention">
                          {amountText(warranty.retentionAmountVnd, locale)}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
          <p className="sub" data-testid="release-note">
            {t('ctr.warrantyView.release.notice')}
          </p>
        </>
      )}
    </ViewFrame>
  );
}
