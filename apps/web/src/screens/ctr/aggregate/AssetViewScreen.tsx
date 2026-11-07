import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { basisLabel, statusLabel } from '../../ast/asset/labels';
import { READ_PERMISSION } from '../../ast/asset/model';
import { amountText } from '../model';
import { ViewFrame } from './ViewFrame';
import { useAssets, useViewScope } from './hooks';
import { assetsTotal, ownerLink, withinContractValue } from './model';
import { SectionCard } from '../../../ui';

/**
 * CTR-18: the asset dossier and the transfer to operation of a contract, read-only (ST-CTR-017, CTR section 7). AST owns the assets (AST-03, AST-06). The value of the assets is a financial
 * column: a guest contractor does not see it, and for whoever sees it the view checks that it does not exceed the value of the contract (FR-CTR-18).
 */
export default function AssetViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <AssetContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AssetContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const scope = useViewScope(READ_PERMISSION);
  const assets = useAssets(scope);
  return (
    <ViewFrame
      route={route}
      title={t('ctr.assetView.page.title')}
      subtitle={t('ctr.assetView.page.subtitle')}
      module="AST"
      scope={scope}
      loaded={assets}
      isEmpty={(rows) => rows.length === 0}
      owners={[{ id: 'AST-03', to: ownerLink.assets() }]}
    >
      {({ contract, data, financial }) => {
        const total = assetsTotal(data);
        const within = withinContractValue(total, contract.contractValueVnd);
        const figures = { total: amountText(total.toString(), locale), contract: amountText(contract.contractValueVnd, locale) };
        return (
          <>
            {financial ? (
              <p className={within ? 'callout' : 'callout warning'} role="status" data-testid="total">
                {within ? t('ctr.assetView.total.within', figures) : t('ctr.assetView.total.over', figures)}
              </p>
            ) : null}
            <SectionCard title={t('ctr.assetView.table.label')}>
              <table className="table" data-testid="assets">
                <thead>
                  <tr>
                    <th scope="col">{t('ctr.assetView.column.code')}</th>
                    <th scope="col">{t('ctr.assetView.column.name')}</th>
                    <th scope="col">{t('ctr.assetView.column.handover')}</th>
                    <th scope="col">{t('ctr.assetView.column.unit')}</th>
                    <th scope="col">{t('ctr.assetView.column.status')}</th>
                    <th scope="col">{t('ctr.assetView.column.registered')}</th>
                    <th scope="col">{t('ctr.assetView.column.transferred')}</th>
                    <th scope="col">{t('ctr.assetView.column.warranty')}</th>
                    {financial ? (
                      <>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.assetView.column.value')}
                        </th>
                        <th scope="col">{t('ctr.assetView.column.basis')}</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.map((asset) => (
                    <tr key={asset.id} data-asset={asset.id}>
                      <td>
                        <Link to={ownerLink.assets(asset.handover.id)} data-testid="open">
                          {asset.assetCode}
                        </Link>
                      </td>
                      <td data-testid="name">{asset.name ?? '–'}</td>
                      <td data-testid="handover">{asset.handover.handoverNo ?? '–'}</td>
                      <td data-testid="unit">{asset.recipientUnit.name}</td>
                      <td data-testid="status">{statusLabel(t, asset.status)}</td>
                      <td data-testid="registered">{asset.registeredOn ?? '–'}</td>
                      <td data-testid="transferred">{asset.transferredOn ?? '–'}</td>
                      <td data-testid="warranty">{asset.warrantyUntil ?? '–'}</td>
                      {financial ? (
                        <>
                          <td className="ctr-amount" data-testid="value">
                            {asset.valueVnd === null ? '–' : amountText(asset.valueVnd, locale)}
                          </td>
                          <td data-testid="basis">{asset.valueBasis === null ? '–' : basisLabel(t, asset.valueBasis)}</td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          </>
        );
      }}
    </ViewFrame>
  );
}
