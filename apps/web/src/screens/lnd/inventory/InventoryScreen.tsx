import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { householdStatusLabel } from '../household/labels';
import { todayInVietnam } from '../model';
import { useProjectOptions } from '../read-hooks';
import { AnswerDialog, RecordDialog } from './dialogs';
import { useInventory } from './hooks';
import { inventoryStatusLabel, itemKindLabel } from './labels';
import { INVENTORY_STATUSES, canAnswer, canCount, confirmedTotal, formatVnd, recordsOf } from './model';
import type { InventoryLine, InventoryStatus } from './model';
import { ScrollRegion } from '../../scroll-region';
import '../lnd.css';

type Dialog = { kind: 'record' } | { kind: 'answer'; record: InventoryLine };

/**
 * LND-04: the inventory of the assets of an affected household (ST-LND-004, BR-LND-04). A record counts one kind of asset on a parcel the household holds a right on, at the unit price of the decision on
 * land prices that was in force on the day of the survey; it is a draft until the household has answered and someone other than the person who counted records the answer. Only the confirmed
 * records add up to what a plan may rest on, and the page says so. The server judges every request again.
 */
export default function InventoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The records and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <InventoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InventoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const householdId = params.get('household') ?? undefined;
  const projects = useProjectOptions();
  const households = useHouseholds(projectId);
  const household = households.data?.find((line) => line.id === householdId);
  const records = useInventory(household?.id);
  const mayCount = canCount(permissions, mode);
  const [status, setStatus] = useState<'' | InventoryStatus>('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const today = todayInVietnam();
  const state = useScreenState({ isLoading: records.isLoading, error: records.error, data: records.data, isEmpty: () => false });
  const shown = useMemo(() => recordsOf(records.data ?? [], status), [records.data, status]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.inventory.page.title')}</h1>
          <p>{t('lnd.inventory.page.subtitle')}</p>
        </div>
        {mayCount && household !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'record' })}>
              {t('lnd.inventory.record.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.inventory.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="inventory-project">{t('lnd.inventory.project.label')}</label>
          <select
            id="inventory-project"
            value={projectId ?? ''}
            onChange={(event) => {
              setStatus('');
              setParams(event.target.value === '' ? {} : { project: event.target.value });
            }}
          >
            <option value="">{t('lnd.inventory.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
        {projectId === undefined ? null : (
          <div className="field">
            <label htmlFor="inventory-household">{t('lnd.inventory.household.label')}</label>
            <select
              id="inventory-household"
              value={household?.id ?? ''}
              onChange={(event) => {
                setStatus('');
                setParams(event.target.value === '' ? { project: projectId } : { project: projectId, household: event.target.value });
              }}
            >
              <option value="">{t('lnd.inventory.household.choose')}</option>
              {(households.data ?? []).map((line) => (
                <option key={line.id} value={line.id}>
                  {`${line.householdCode} · ${line.headNameMasked}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {household === undefined ? (
        <div className="card">
          <RecordsTable empty={projectId === undefined ? t('lnd.inventory.project.notice') : t('lnd.inventory.household.notice')} emptyTestId="choose-household">
            {null}
          </RecordsTable>
        </div>
      ) : (
        <StateBoundary state={state} onRetry={() => void records.refetch()}>
          <div className="card">
            <p data-testid="household-summary">
              {t('lnd.inventory.household.summary', { code: household.householdCode, head: household.headNameMasked, status: householdStatusLabel(t, household.status) })}
            </p>
            <form className="lnd-filters" role="search" aria-label={t('lnd.inventory.filters.title')} onSubmit={(event) => event.preventDefault()}>
              <div className="field">
                <label htmlFor="inventory-status">{t('lnd.inventory.status.label')}</label>
                <select id="inventory-status" value={status} onChange={(event) => setStatus(event.target.value as '' | InventoryStatus)}>
                  <option value="">{t('lnd.inventory.status.all')}</option>
                  {INVENTORY_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {inventoryStatusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>
            </form>
            <RecordsTable empty={shown.length === 0 ? ((records.data ?? []).length === 0 ? t('lnd.inventory.empty.notice') : t('lnd.inventory.noMatch.notice')) : undefined} emptyTestId="no-match">
              {shown.map((record) => (
                <RecordRow key={record.id} record={record} canConfirm={canAnswer(record, tenant?.membershipId, permissions, mode)} onAnswer={() => setDialog({ kind: 'answer', record })} />
              ))}
            </RecordsTable>
            <p data-testid="confirmed-total">{t('lnd.inventory.total.text', { amount: formatVnd(confirmedTotal(records.data ?? [])) })}</p>
          </div>
        </StateBoundary>
      )}
      {dialog?.kind === 'record' && household !== undefined ? <RecordDialog householdId={household.id} parcels={household.parcels.map((parcel) => ({ id: parcel.parcelId, parcelCode: parcel.parcelCode }))} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'answer' ? <AnswerDialog record={dialog.record} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.inventory.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The columns of the records, for the one row that stands in for none. */
const COLUMNS = 11;

/** The table of the records of a household: its columns stand even before a household is chosen, the one row then says what to choose. */
function RecordsTable({ empty, emptyTestId, children }: { empty: string | undefined; emptyTestId: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ScrollRegion label={t('lnd.inventory.page.title')}>
      <table className="table" data-testid="records">
        <thead>
          <tr>
            <th scope="col">{t('lnd.inventory.column.parcel')}</th>
            <th scope="col">{t('lnd.inventory.column.kind')}</th>
            <th scope="col">{t('lnd.inventory.column.description')}</th>
            <th scope="col">{t('lnd.inventory.column.quantity')}</th>
            <th scope="col">{t('lnd.inventory.column.price')}</th>
            <th scope="col">{t('lnd.inventory.column.amount')}</th>
            <th scope="col">{t('lnd.inventory.column.decision')}</th>
            <th scope="col">{t('scr2.lnd.inventory.column.confirmed')}</th>
            <th scope="col">{t('lnd.inventory.column.answer')}</th>
            <th scope="col">{t('lnd.inventory.column.status')}</th>
            <th scope="col">{t('lnd.inventory.column.action')}</th>
          </tr>
        </thead>
        <tbody>
          {empty === undefined ? null : (
            <tr>
              <td colSpan={COLUMNS} role="status" data-testid={emptyTestId}>
                {empty}
              </td>
            </tr>
          )}
          {children}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function RecordRow({ record, canConfirm, onAnswer }: { record: InventoryLine; canConfirm: boolean; onAnswer(): void }) {
  const { t } = useTranslation();
  return (
    <tr data-record-id={record.id}>
      <th scope="row">{record.parcelCode}</th>
      <td>{itemKindLabel(t, record.itemKind)}</td>
      <td data-testid="description">{record.description}</td>
      <td className="lnd-numeric">{t('lnd.inventory.quantity.line', { quantity: record.quantity, unit: record.unitCode })}</td>
      <td className="lnd-numeric">{formatVnd(record.unitPriceVnd)}</td>
      <td className="lnd-numeric" data-testid="amount">
        {formatVnd(record.amountVnd)}
      </td>
      <td data-testid="decision">{record.priceDecisionRevision === null ? record.priceDecisionRef : t('lnd.inventory.decision.line', { ref: record.priceDecisionRef, revision: record.priceDecisionRevision })}</td>
      <td data-testid="confirmed">{record.householdConfirmedOn === null ? t('lnd.inventory.answer.none') : t('lnd.inventory.answer.line', { on: record.householdConfirmedOn })}</td>
      <td data-testid="answer">
        {record.note === null ? null : (
          <small className="sub" data-testid="note">
            {record.note}
          </small>
        )}
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {inventoryStatusLabel(t, record.status)}
        </span>
      </td>
      <td>
        {canConfirm ? (
          <button type="button" className="button" aria-label={t('lnd.inventory.answer.aria', { code: record.parcelCode })} onClick={onAnswer}>
            {t('lnd.inventory.answer.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
