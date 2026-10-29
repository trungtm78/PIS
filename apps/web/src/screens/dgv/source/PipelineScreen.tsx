import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { NO_FILTER, useCatalog } from '../hooks';
import { NO_MAPPING_FILTER, useGates, useMappings } from './hooks';
import { gateOutcomeLabel, gateReasonLabel, mappingStatusLabel, mappingStatusTone, unitLabel } from './labels';
import { GATE_OUTCOMES } from './model';
import '../dgv.css';

const MAPPING_PATH = '/dgv/dgv-20';

/**
 * DGV-14: the pipeline of the sources and its gate (ST-DGV-004, DGV 3.3 F7). A batch of a source reaches a dataset only through mappings that were confirmed; while a field of it has none, the whole batch is kept out in quarantine
 * with the reason, and does not reach an official report. The screen shows what the gate did with the batches, the confirmed mappings the pipeline reads, and the proposals that still wait for an owner.
 */
export default function PipelineScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PipelineContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PipelineContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [datasetId, setDatasetId] = useState('');
  const [outcome, setOutcome] = useState('');
  const catalog = useCatalog(NO_FILTER);
  const gates = useGates({ datasetId, outcome });
  const confirmed = useMappings({ ...NO_MAPPING_FILTER, datasetId, status: 'CONFIRMED' });
  const waiting = useMappings({ ...NO_MAPPING_FILTER, datasetId, status: 'PROPOSED' });
  const batches = (gates.data?.pages ?? []).flatMap((entry) => entry.items);
  const usable = (confirmed.data?.pages ?? []).flatMap((entry) => entry.items);
  const proposals = (waiting.data?.pages ?? []).flatMap((entry) => entry.items);
  const state = useScreenState({ isLoading: gates.isLoading, error: gates.error, data: gates.data, isEmpty: () => false });
  const codeOf = (id: string): string => (catalog.data ?? []).find((dataset) => dataset.id === id)?.datasetCode ?? t('dgv.source.none');
  const moment = (iso: string): string => (iso === '' ? t('dgv.source.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const kept = batches.filter((batch) => batch.outcome === 'QUARANTINED').length;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.pipeline.title')}</h1>
          <p>{t('dgv.pipeline.subtitle')}</p>
        </div>
        <Link className="button" to={datasetId === '' ? MAPPING_PATH : `${MAPPING_PATH}?dataset=${datasetId}`} data-testid="to-mappings">
          {t('dgv.pipeline.mappings.link')}
        </Link>
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="pipeline-dataset">{t('dgv.source.column.dataset')}</label>
          <select id="pipeline-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
            <option value="">{t('dgv.source.filter.all')}</option>
            {(catalog.data ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.datasetCode}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pipeline-outcome">{t('dgv.pipeline.column.outcome')}</label>
          <select id="pipeline-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
            <option value="">{t('dgv.source.filter.all')}</option>
            {GATE_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {gateOutcomeLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="callout" role="note">
        {t('dgv.pipeline.rule')}
      </p>
      <StateBoundary state={state} onRetry={() => void gates.refetch()}>
        <div className="dgv-tiles" data-testid="pipeline-tiles">
          <div className="dgv-tile" data-testid="tile-confirmed">
            <span>{t('dgv.pipeline.tile.confirmed')}</span>
            <strong>
              {usable.length}
              {confirmed.hasNextPage ? '+' : ''}
            </strong>
          </div>
          <div className="dgv-tile" data-testid="tile-waiting">
            <span>{t('dgv.pipeline.tile.waiting')}</span>
            <strong>
              {proposals.length}
              {waiting.hasNextPage ? '+' : ''}
            </strong>
          </div>
          <div className="dgv-tile" data-testid="tile-quarantined">
            <span>{t('dgv.pipeline.tile.quarantined')}</span>
            <strong>{kept}</strong>
          </div>
        </div>
        <div className="card">
          <h2>{t('dgv.pipeline.batches.title')}</h2>
          {batches.length === 0 ? (
            <p className="callout" role="status" data-testid="no-batches">
              {t('dgv.pipeline.batches.none')}
            </p>
          ) : (
            <table className="table" data-testid="batches">
              <thead>
                <tr>
                  <th scope="col">{t('dgv.pipeline.column.batch')}</th>
                  <th scope="col">{t('dgv.source.column.dataset')}</th>
                  <th scope="col">{t('dgv.source.column.system')}</th>
                  <th scope="col">{t('dgv.pipeline.column.rows')}</th>
                  <th scope="col">{t('dgv.pipeline.column.outcome')}</th>
                  <th scope="col">{t('dgv.pipeline.column.at')}</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} data-batch={batch.id} data-outcome={batch.outcome}>
                    <td>{batch.batchRef}</td>
                    <td>{codeOf(batch.datasetId)}</td>
                    <td>{batch.sourceSystem}</td>
                    <td>{batch.rowCount}</td>
                    <td>
                      <span className={`pill ${batch.outcome === 'APPLIED' ? 'green' : 'red'}`} data-testid="outcome">
                        {gateOutcomeLabel(t, batch.outcome)}
                      </span>
                      {batch.outcome === 'QUARANTINED' ? (
                        <small className="sub" data-testid="reason">
                          {gateReasonLabel(t, batch.reason)}
                          {batch.missing.length === 0 ? '' : `: ${batch.missing.join(', ')}`}
                        </small>
                      ) : null}
                    </td>
                    <td>{moment(batch.gatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {gates.hasNextPage ? (
            <button type="button" data-testid="more-batches" disabled={gates.isFetchingNextPage} onClick={() => void gates.fetchNextPage()}>
              {t('dgv.source.more')}
            </button>
          ) : null}
        </div>
        <div className="card">
          <h2>{t('dgv.pipeline.confirmed.title')}</h2>
          {usable.length === 0 ? (
            <p className="callout" role="status" data-testid="no-confirmed">
              {t('dgv.pipeline.confirmed.none')}
            </p>
          ) : (
            <ul data-testid="confirmed-mappings">
              {usable.map((mapping) => (
                <li key={mapping.id} data-mapping={mapping.id}>
                  <span className={`pill ${mappingStatusTone(mapping.status)}`}>{mappingStatusLabel(t, mapping.status)}</span> {mapping.datasetCode} · {mapping.sourceSystem}.{mapping.sourceField} → {mapping.targetField} · {unitLabel(t, mapping.unit)}
                </li>
              ))}
            </ul>
          )}
          {confirmed.hasNextPage ? (
            <button type="button" data-testid="more-confirmed" disabled={confirmed.isFetchingNextPage} onClick={() => void confirmed.fetchNextPage()}>
              {t('dgv.source.more')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.pipeline.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
