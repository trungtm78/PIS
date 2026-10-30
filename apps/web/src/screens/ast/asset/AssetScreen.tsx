import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { amountText } from '../../ctr/model';
import { useHandovers } from '../handover/hooks';
import { useAssets } from './hooks';
import { basisLabel, statusLabel } from './labels';
import { canRegister, remainingVnd } from './model';
import type { AssetLine } from './model';
import { RegisterDialog, TransferDialog } from './AssetDialogs';
import '../../qms/qms.css';

/**
 * AST-03: the assets a work produces (ST-AST-002, AST 3.2, BR-AST-02). Each shows its code, name, the unit that receives it, the value it is booked at and the basis, and, for whoever registers or
 * transfers assets, what the assets of its contract come to against what the contract is worth. The accountant registers an asset of an accepted handover; the receiving unit transfers it with the
 * dossier of the commissioning and the code it has in the system of public assets, typed by hand because none is connected. The server judges every command again.
 */
export default function AssetScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The dossier and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <AssetContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'register' } | { kind: 'transfer'; asset: AssetLine };

function AssetContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const handovers = useHandovers('');
  // Whoever may read assets and not the handovers still reads them: only the filter and the choice of a handover are missing.
  const accepted = useMemo(() => (handovers.data ?? []).filter((handover) => handover.status === 'ACCEPTED'), [handovers.data]);
  const wanted = search.get('handover') ?? '';
  const handoverId = accepted.some((handover) => handover.id === wanted) ? wanted : '';
  const assets = useAssets(handoverId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  // A tenant with no asset is not an empty screen: the accountant still registers the first.
  const state = useScreenState({ isLoading: assets.isLoading, error: assets.error, data: assets.data, isEmpty: () => false });
  const lines = assets.data ?? [];
  const choose = (id: string): void => setSearch(id === '' ? {} : { handover: id });
  const writable = mode !== 'READ_ONLY';
  const money = (value: string | null): string => (value === null ? t('ast.asset.value.hidden') : t('ctr.value.amount', { amount: amountText(value, locale) }));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.asset.page.title')}</h1>
          <p>{t('ast.asset.page.subtitle')}</p>
        </div>
        {canRegister(permissions, mode) && accepted.length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'register' })}>
              {t('ast.asset.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      {accepted.length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="assets-handover">{t('ast.asset.filter.handover')}</label>
            <select id="assets-handover" value={handoverId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('ast.asset.filter.all')}</option>
              {accepted.map((handover) => (
                <option key={handover.id} value={handover.id}>
                  {`${handover.handoverNo} · ${handover.contract.code}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void assets.refetch()}>
        <div className="card">
          {lines.length === 0 ? (
            <p className="callout" role="status" data-testid="no-assets">
              {t('ast.asset.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="assets">
              <thead>
                <tr>
                  <th scope="col">{t('ast.asset.column.asset')}</th>
                  <th scope="col">{t('ast.asset.column.handover')}</th>
                  <th scope="col">{t('ast.asset.column.unit')}</th>
                  <th scope="col">{t('ast.asset.column.value')}</th>
                  <th scope="col">{t('ast.asset.column.external')}</th>
                  <th scope="col">{t('ast.asset.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('ast.asset.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const left = remainingVnd(line);
                  return (
                    <tr key={line.id} data-asset={line.id} data-status={line.status}>
                      <td>
                        <strong data-testid="code">{line.assetCode}</strong> <span data-testid="name">{line.name ?? ''}</span>
                        {line.warrantyUntil === null ? null : <small className="sub qms-regime">{t('ast.asset.warranty.until', { day: line.warrantyUntil })}</small>}
                      </td>
                      <td data-testid="handover">{`${line.handover.handoverNo ?? ''} · ${line.contract.code}`}</td>
                      <td data-testid="unit">{line.recipientUnit.name}</td>
                      <td data-testid="value">
                        {money(line.valueVnd)}
                        {line.valueBasis === null ? null : <small className="sub qms-regime">{basisLabel(t, line.valueBasis)}</small>}
                        {left === undefined ? null : (
                          <small className="sub qms-regime" data-testid="remaining">
                            {t('ast.asset.remaining.label', { left: amountText(left, locale), contract: amountText(line.contract.valueVnd ?? '0', locale) })}
                          </small>
                        )}
                      </td>
                      <td data-testid="external">
                        {line.externalAssetId ?? (
                          <span className="qms-badge warning" role="status">
                            {t('ast.asset.external.manual')}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={line.status === 'TRANSFERRED' || line.status === 'IN_OPERATION' ? 'qms-badge ok' : 'qms-badge'} data-testid="status">
                          {statusLabel(t, line.status)}
                        </span>
                        {line.transferredOn === null ? null : <small className="sub qms-regime">{t('ast.asset.transferred.on', { day: line.transferredOn })}</small>}
                      </td>
                      <td>
                        {line.status === 'TRANSFERRED' || line.status === 'IN_OPERATION' ? (
                          <Link to={`/ast/ast-06?id=${line.id}`} data-om-link={line.id}>
                            {t('ast.asset.omlink.action')}
                          </Link>
                        ) : null}
                        {writable && line.canTransfer ? (
                          <button type="button" data-transfer={line.id} onClick={() => setDialog({ kind: 'transfer', asset: line })}>
                            {t('ast.asset.transfer.action')}
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
      {dialog?.kind === 'register' ? <RegisterDialog handovers={accepted} initialHandoverId={handoverId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'transfer' ? <TransferDialog asset={dialog.asset} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('ast.asset.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
