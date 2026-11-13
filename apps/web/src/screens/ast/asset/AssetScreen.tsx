import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { amountText } from '../../ctr/model';
import { useHandovers } from '../handover/hooks';
import { useAssets } from './hooks';
import { basisLabel, statusLabel } from './labels';
import { canRegister, remainingVnd } from './model';
import type { AssetLine, AssetStatus } from './model';
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
  const { permissions, mode, tenant } = useSession();
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
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'register' })}>
              {t('ast.asset.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ContextBar items={[{ label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') }]} unit={t('w2iss.ast.unit')} />
      {accepted.length === 0 ? null : (
        <FilterPanel applied={handoverId === '' ? 0 : 1}>
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
        </FilterPanel>
      )}
      <StateBoundary state={state} onRetry={() => void assets.refetch()}>
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-assets">
            {t('ast.asset.none.notice')}
          </p>
        ) : (
          <div data-testid="assets">
            <AssetTable lines={lines} writable={writable} money={money} onTransfer={(asset) => setDialog({ kind: 'transfer', asset })} />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'register' ? <RegisterDialog handovers={accepted} initialHandoverId={handoverId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'transfer' ? <TransferDialog asset={dialog.asset} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('ast.asset.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const STATUS_TONE: Readonly<Record<AssetStatus, 'neutral' | 'info' | 'success' | 'warning'>> = {
  DRAFT: 'neutral',
  REGISTERED: 'info',
  TRANSFERRED: 'success',
  IN_OPERATION: 'success',
  DISPOSED: 'neutral',
};

interface AssetTableProps {
  lines: AssetLine[];
  writable: boolean;
  money(value: string | null): string;
  onTransfer(asset: AssetLine): void;
}

/** The assets as a table: the code and the name, the handover, the unit that receives the asset, the value (right aligned, in dong) with its basis and what is left of the contract, the code in the public assets system, the status. */
function AssetTable({ lines, writable, money, onTransfer }: AssetTableProps) {
  const { t, locale } = useTranslation();
  const columns: DataTableColumn<AssetLine>[] = [
    {
      key: 'asset',
      header: t('ast.asset.column.code'),
      pinned: true,
      render: (line) => (
        <>
          <strong data-testid="code">{line.assetCode}</strong>
          {line.warrantyUntil === null ? null : <small className="sub qms-regime">{t('ast.asset.warranty.until', { day: line.warrantyUntil })}</small>}
        </>
      ),
    },
    { key: 'name', header: t('ast.asset.column.name'), render: (line) => <span data-testid="name">{line.name ?? ''}</span> },
    {
      key: 'group',
      header: t('ast.asset.column.group'),
      render: (line) => <span data-testid="group">{line.assetClassId === null ? t('ast.asset.group.none') : <code title={line.assetClassId}>{line.assetClassId.slice(0, 8)}</code>}</span>,
    },
    {
      key: 'origin',
      header: t('ast.asset.column.origin'),
      render: (line) => (
        <>
          <span data-testid="origin">{line.fundingOrigin ?? t('ast.asset.origin.none')}</span>
          <small className="sub qms-regime" data-testid="handover">{`${line.handover.handoverNo ?? ''} · ${line.contract.code}`}</small>
        </>
      ),
    },
    { key: 'unit', header: t('ast.asset.column.unit'), render: (line) => <span data-testid="unit">{line.recipientUnit.name}</span> },
    {
      key: 'value',
      header: t('ast.asset.column.value'),
      align: 'right',
      render: (line) => {
        const left = remainingVnd(line);
        return (
          <span data-testid="value">
            {money(line.valueVnd)}
            {line.valueBasis === null ? null : <small className="sub qms-regime">{basisLabel(t, line.valueBasis)}</small>}
            {left === undefined ? null : (
              <small className="sub qms-regime" data-testid="remaining">
                {t('ast.asset.remaining.label', { left: amountText(left, locale), contract: amountText(line.contract.valueVnd ?? '0', locale) })}
              </small>
            )}
          </span>
        );
      },
    },
    {
      key: 'external',
      header: t('ast.asset.column.external'),
      render: (line) => <span data-testid="external">{line.externalAssetId ?? <StatusPill tone="warning">{t('ast.asset.external.manual')}</StatusPill>}</span>,
    },
    {
      key: 'status',
      header: t('ast.asset.column.status'),
      render: (line) => (
        <>
          <span data-testid="status" data-status={line.status}>
            <StatusPill tone={STATUS_TONE[line.status]}>{statusLabel(t, line.status)}</StatusPill>
          </span>
          {line.transferredOn === null ? null : <small className="sub qms-regime">{t('ast.asset.transferred.on', { day: line.transferredOn })}</small>}
        </>
      ),
    },
    {
      key: 'actions',
      header: t('ast.asset.column.actions'),
      render: (line) => (
        <span className="qms-row-actions">
          {line.status === 'TRANSFERRED' || line.status === 'IN_OPERATION' ? (
            <Link to={`/ast/ast-06?id=${line.id}`} data-om-link={line.id}>
              {t('ast.asset.omlink.action')}
            </Link>
          ) : null}
          {writable && line.canTransfer ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-transfer={line.id} onClick={() => onTransfer(line)}>
              {t('ast.asset.transfer.action')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  return <DataTable caption={t('w2iss.ast.assets.aria')} columns={columns} rows={lines} rowKey={(line) => line.id} rowAttrs={(line) => ({ 'data-asset': line.id, 'data-status': line.status })} />;
}
