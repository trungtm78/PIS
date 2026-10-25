import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePeriods } from '../../dis/hooks';
import { useBoqLines } from '../boq-hooks';
import { linesOf } from '../boq-model';
import type { BoqLine } from '../boq-model';
import { BackLink, StatusBadge } from '../components';
import { useContract } from '../hooks';
import type { ContractView } from '../model';
import { useMeasurements, useSubmitMeasurement } from './hooks';
import { measurementProblemMessage, statusLabel } from './labels';
import { CorrectDialog, DecideDialog, RecordDialog } from './MeasurementDialogs';
import { describeMeasurementProblem, itemRows, mayRecord, quantityText } from './model';
import type { ItemRow, Measurement } from './model';
import '../ctr.css';

/** The screen CTR-10 hangs under (the site diary), which the back link of a detail screen names. */
const PARENT_PATH = '/ctr/ctr-09';

type Dialog = { kind: 'record'; itemKey: string } | { kind: 'correct'; id: string } | { kind: 'decide'; id: string };

/**
 * CTR-10: record the work done under a contract (ST-CTR-008, CTR 3.4). The grid has a row for each item of the revision in force, with its quantity, what has been approved and what is
 * left; the person records the quantity of an item in a period with its evidence, sends it, and someone else approves it. What was approved is corrected with a reason, never edited.
 * The server judges every quantity again against the revision in force, the numbers of record, the permits of the start of construction and the people.
 */
export default function MeasurementScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The measurements and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MeasurementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MeasurementContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const contractId = search.get('contract');
  const contract = useContract(contractId);
  const lines = useBoqLines(contractId);
  const measurements = useMeasurements(contractId);
  const state = useScreenState({
    isLoading: contract.isLoading || lines.isLoading || measurements.isLoading,
    // Whoever may read the measurements and not the BOQ still reads them: only the grid of the items is missing.
    error: contract.error ?? measurements.error,
    data: contractId === null ? null : contract.data === undefined || measurements.data === undefined || (lines.data === undefined && !lines.isError) ? undefined : contract.data,
    isEmpty: (data) => data === null,
  });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={PARENT_PATH}>{t('ctr.measurement.back.title')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.measurement.title')}</h1>
          <p>{t('ctr.measurement.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.measurement.none.notice')}
        </p>
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void contract.refetch();
            void lines.refetch();
            void measurements.refetch();
          }}
        >
          {contract.data === null || contract.data === undefined ? null : <Measurements contract={contract.data} lines={lines.data} measurements={measurements.data ?? []} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.measurement.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface MeasurementsProps {
  contract: ContractView;
  /** The lines of the BOQ; undefined when the caller may not read them. */
  lines: readonly BoqLine[] | undefined;
  measurements: readonly Measurement[];
}

function Measurements({ contract, lines, measurements }: MeasurementsProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  // The periods are read for the picker; a caller without the right to read them types the identifier of the period.
  const periods = usePeriods();
  // The commands that send a measurement are made here, not in a row: the register is read again when one is done and the row, now another version, is drawn afresh.
  const submit = useSubmitMeasurement();
  const effective = contract.revisions.find((revision) => revision.status === 'EFFECTIVE');
  const rows = effective === undefined || lines === undefined ? [] : itemRows(linesOf(lines, effective.id), measurements);
  const mayEnter = mayRecord(permissions, mode) && contract.status === 'ACTIVE' && effective !== undefined;
  const close = (): void => setDialog(undefined);
  const finished = (message: string) => (): void => {
    setDone(message);
    close();
  };
  const sendNow = (measurement: Measurement): void => {
    submit.mutate({ id: measurement.id, version: measurement.version }, { onSuccess: () => setDone(t('ctr.measurement.done.submitted')) });
  };
  const target = dialog?.kind === 'record' ? rows.find((row) => row.line.businessKey === dialog.itemKey) : undefined;
  const subject = dialog === undefined || dialog.kind === 'record' ? undefined : measurements.find((measurement) => measurement.id === dialog.id);

  return (
    <>
      <article className="card" aria-label={t('ctr.measurement.contract.title')}>
        <h2>{t('ctr.measurement.contract.title')}</h2>
        <p>
          <strong data-testid="contract-code">{contract.code}</strong> <StatusBadge status={contract.status} />
          {effective === undefined ? null : <span data-testid="revision-no"> · {t('ctr.measurement.contract.revision', { revision: effective.revision })}</span>}
        </p>
        {contract.status === 'ACTIVE' ? null : (
          <p className="callout" role="status" data-testid="not-active">
            {t('ctr.measurement.contract.notActive')}
          </p>
        )}
      </article>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {submit.isError ? (
        <p className="callout warning" role="alert" data-testid="submit-refusal">
          {measurementProblemMessage(t, describeMeasurementProblem(submit.error), locale)}
        </p>
      ) : null}
      <article className="card" aria-label={t('ctr.measurement.items.title')}>
        <h2>{t('ctr.measurement.items.title')}</h2>
        {rows.length === 0 ? (
          <p className="sub" data-testid="no-items">
            {lines === undefined ? t('ctr.measurement.items.denied') : t('ctr.measurement.items.empty')}
          </p>
        ) : (
          <table className="table" data-testid="items">
            <thead>
              <tr>
                <th scope="col">{t('ctr.measurement.items.item')}</th>
                <th scope="col">{t('ctr.measurement.items.unit')}</th>
                <th scope="col" className="ctr-amount">
                  {t('ctr.measurement.items.quantity')}
                </th>
                <th scope="col" className="ctr-amount">
                  {t('ctr.measurement.items.approved')}
                </th>
                <th scope="col" className="ctr-amount">
                  {t('ctr.measurement.items.remaining')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('ctr.measurement.items.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ItemLine key={row.line.id} row={row} locale={locale} mayEnter={mayEnter} onRecord={() => setDialog({ kind: 'record', itemKey: row.line.businessKey })} />
              ))}
            </tbody>
          </table>
        )}
      </article>
      <article className="card" aria-label={t('ctr.measurement.list.title')}>
        <h2>{t('ctr.measurement.list.title')}</h2>
        {measurements.length === 0 ? (
          <p className="sub" data-testid="no-measurements">
            {t('ctr.measurement.list.empty')}
          </p>
        ) : (
          <table className="table" data-testid="measurements">
            <thead>
              <tr>
                <th scope="col">{t('ctr.measurement.list.period')}</th>
                <th scope="col">{t('ctr.measurement.list.item')}</th>
                <th scope="col" className="ctr-amount">
                  {t('ctr.measurement.list.quantity')}
                </th>
                <th scope="col" className="ctr-amount">
                  {t('ctr.measurement.list.cumulative')}
                </th>
                <th scope="col">{t('ctr.measurement.list.revision')}</th>
                <th scope="col">{t('ctr.measurement.list.reference')}</th>
                <th scope="col">{t('ctr.measurement.list.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('ctr.measurement.items.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {measurements.map((measurement) => (
                <tr key={measurement.id} data-measurement={measurement.id} data-status={measurement.status}>
                  <th scope="row">{measurement.period.code}</th>
                  <td>{`${measurement.boqItem.businessKey} · ${measurement.boqItem.description}`}</td>
                  <td className="ctr-amount">{`${quantityText(measurement.quantityPeriod, locale)} ${measurement.boqItem.unitCode}`}</td>
                  <td className="ctr-amount">{quantityText(measurement.quantityCumulative, locale)}</td>
                  <td>{measurement.revision}</td>
                  <td>{measurement.referenceNo ?? ''}</td>
                  <td>
                    <span className={measurement.status === 'REJECTED' ? 'ctr-badge warning' : 'ctr-badge'} data-testid="measurement-status">
                      {statusLabel(t, measurement.status)}
                    </span>
                  </td>
                  <td>
                    {measurement.actions.submit && mode !== 'READ_ONLY' ? (
                      <button type="button" data-action="submit" disabled={submit.isPending} onClick={() => sendNow(measurement)}>
                        {t('ctr.measurement.action.submit')}
                      </button>
                    ) : null}
                    {measurement.actions.decide && mode !== 'READ_ONLY' ? (
                      <button type="button" data-action="decide" onClick={() => setDialog({ kind: 'decide', id: measurement.id })}>
                        {t('ctr.measurement.action.decide')}
                      </button>
                    ) : null}
                    {measurement.actions.correct && mode !== 'READ_ONLY' ? (
                      <button type="button" data-action="correct" onClick={() => setDialog({ kind: 'correct', id: measurement.id })}>
                        {t('ctr.measurement.action.correct')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
      {target === undefined || effective === undefined ? null : (
        <RecordDialog contractId={contract.id} revisionId={effective.id} row={target} periods={periods.data} onDone={finished(t('ctr.measurement.done.recorded'))} onClose={close} />
      )}
      {subject === undefined || dialog?.kind !== 'correct' ? null : <CorrectDialog measurement={subject} onDone={finished(t('ctr.measurement.done.corrected'))} onClose={close} />}
      {subject === undefined || dialog?.kind !== 'decide' ? null : <DecideDialog measurement={subject} onDone={finished(t('ctr.measurement.done.decided'))} onClose={close} />}
    </>
  );
}

interface ItemLineProps {
  row: ItemRow;
  locale: string;
  mayEnter: boolean;
  onRecord(): void;
}

function ItemLine({ row, locale, mayEnter, onRecord }: ItemLineProps) {
  const { t } = useTranslation();
  return (
    <tr data-item={row.line.businessKey}>
      <th scope="row">{`${row.line.businessKey} · ${row.line.description}`}</th>
      <td>{row.line.unitCode}</td>
      <td className="ctr-amount">{quantityText(row.line.quantity, locale)}</td>
      <td className="ctr-amount">{quantityText(row.approved, locale)}</td>
      <td className="ctr-amount" data-testid="remaining">
        {quantityText(row.remaining, locale)}
      </td>
      <td>
        {mayEnter && row.itemId !== null ? (
          <button type="button" data-action="record" onClick={onRecord}>
            {t('ctr.measurement.action.record')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
