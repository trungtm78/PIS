import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CommandFrame } from '../../qms/CommandFrame';
import { Field } from '../components';
import { NO_FILTER, useCatalog } from '../hooks';
import { useReconciliation, useReconciliations, useRunReconciliation } from './hooks';
import { formProblemMessage, kindLabel, problemMessage, resultLabel, resultTone, sideLabel } from './labels';
import { DIFFERENCE_KINDS, RECON_BASIS, RECON_RESULTS, RECON_SOURCE_A, RECON_SOURCE_B, describeProblem, emptyRecon, formatDong, reconBody, resourceIdOf, validateRecon } from './model';
import type { ReconForm, ReconView } from './model';
import '../dgv.css';

const RECON_PARAM = 'recon';
const INCIDENT_PATH = '/dgv/dgv-08';

/**
 * DGV-09: the reconciliation of the Treasury of PAY with the report DIS accepted for a month (ST-DGV-004, DGV 3.3 F7, BR-DGV-09). Both are read on the same period and basis, project by project; the two totals stay apart, the
 * difference is classified (missing, timing, reversal, mapping, amount) and the bigger side is never taken as right. A difference opens one incident for the owner of the dataset.
 */
export default function ReconciliationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ReconciliationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReconciliationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const chosen = search.get(RECON_PARAM) ?? undefined;
  const [result, setResult] = useState('');
  const [running, setRunning] = useState(false);
  const list = useReconciliations(result);
  const detail = useReconciliation(chosen);
  const rows = (list.data?.pages ?? []).flatMap((entry) => entry.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const acting = mode !== 'READ_ONLY';
  const dong = (value: string): string => formatDong(value, locale);
  const open = (id: string | undefined): void => {
    const next = new URLSearchParams(search);
    if (id === undefined) next.delete(RECON_PARAM);
    else next.set(RECON_PARAM, id);
    setSearch(next, { replace: true });
  };
  const recon = detail.data ?? undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.recon.title')}</h1>
          <p>{t('dgv.recon.subtitle')}</p>
        </div>
        {acting ? (
          <button type="button" className="primary" data-action="run" onClick={() => setRunning(true)}>
            {t('dgv.recon.run.action')}
          </button>
        ) : null}
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="recon-filter-result">{t('dgv.recon.column.result')}</label>
          <select id="recon-filter-result" value={result} onChange={(event) => setResult(event.target.value)}>
            <option value="">{t('dgv.source.filter.all')}</option>
            {RECON_RESULTS.map((value) => (
              <option key={value} value={value}>
                {resultLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {rows.length === 0 ? (
            <p className="callout" role="status" data-testid="no-reconciliations">
              {t('dgv.recon.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="reconciliations">
              <thead>
                <tr>
                  <th scope="col">{t('dgv.recon.column.code')}</th>
                  <th scope="col">{t('dgv.recon.column.period')}</th>
                  <th scope="col">{t('dgv.recon.column.result')}</th>
                  <th scope="col">{t('dgv.recon.column.totalA')}</th>
                  <th scope="col">{t('dgv.recon.column.totalB')}</th>
                  <th scope="col">{t('dgv.recon.column.difference')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('dgv.source.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-recon={row.id} data-selected={row.id === chosen ? 'yes' : 'no'}>
                    <td>{row.reconCode}</td>
                    <td>{row.asOfPeriod}</td>
                    <td>
                      <span className={`pill ${resultTone(row.result)}`} data-testid="result">
                        {resultLabel(t, row.result)}
                      </span>
                    </td>
                    <td>{dong(row.totalA)}</td>
                    <td>{dong(row.totalB)}</td>
                    <td data-testid="difference">{dong(row.difference)}</td>
                    <td>
                      <button type="button" data-action="open" onClick={() => open(row.id)}>
                        {t('dgv.recon.open.action')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list.hasNextPage ? (
            <button type="button" data-testid="more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('dgv.source.more')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      {chosen === undefined ? null : detail.isLoading ? (
        <p className="callout" role="status">
          {t('dgv.recon.loading')}
        </p>
      ) : recon === undefined ? (
        <p className="callout warning" role="alert" data-testid="detail-missing">
          {t('dgv.recon.detail.missing')}
        </p>
      ) : (
        <Detail recon={recon} dong={dong} onClose={() => open(undefined)} />
      )}
      {running ? (
        <RunDialog
          onClose={() => setRunning(false)}
          onDone={(id) => {
            setRunning(false);
            // The one just made is opened: its totals and its differences are what the person asked for.
            if (id !== undefined) open(id);
          }}
        />
      ) : null}
      <p className="prototype-note">{t('dgv.recon.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Detail({ recon, dong, onClose }: { recon: ReconView; dong: (value: string) => string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="detail" data-result={recon.result}>
      <div className="dgv-score-head">
        <div>
          <h2 data-testid="detail-title">
            {recon.reconCode} · {recon.asOfPeriod}
          </h2>
          <p>
            <span className={`pill ${resultTone(recon.result)}`}>{resultLabel(t, recon.result)}</span> <small className="sub">{t('dgv.recon.detail.tolerance', { amount: dong(recon.tolerance) })}</small>
          </p>
        </div>
        <button type="button" onClick={onClose}>
          {t('dgv.recon.detail.close')}
        </button>
      </div>
      <dl className="dgv-facts" data-testid="totals">
        <div data-testid="side-a">
          <dt>{t('dgv.recon.side.a', { source: recon.sourceA })}</dt>
          <dd>
            <strong>{dong(recon.totalA)}</strong> · {t('dgv.recon.count', { count: recon.countA })}
          </dd>
        </div>
        <div data-testid="side-b">
          <dt>{t('dgv.recon.side.b', { source: recon.sourceB })}</dt>
          <dd>
            <strong>{dong(recon.totalB)}</strong> · {t('dgv.recon.count', { count: recon.countB })}
          </dd>
        </div>
        <div data-testid="gap">
          <dt>{t('dgv.recon.column.difference')}</dt>
          <dd>
            <strong>{dong(recon.difference)}</strong>
          </dd>
        </div>
        <div>
          <dt>{t('dgv.recon.basis')}</dt>
          <dd>{recon.basis}</dd>
        </div>
        <div>
          <dt>{t('dgv.recon.owner')}</dt>
          <dd>{recon.ownerName ?? t('dgv.source.none')}</dd>
        </div>
      </dl>
      <ul className="dgv-tiles" data-testid="kinds">
        {DIFFERENCE_KINDS.map((kind) => (
          <li key={kind} className="dgv-tile" data-kind={kind}>
            <span>{kindLabel(t, kind)}</span>
            <strong>{recon.byKind[kind]}</strong>
          </li>
        ))}
      </ul>
      {recon.incidentId === null ? null : (
        <p>
          <Link to={`${INCIDENT_PATH}?incident=${recon.incidentId}`} data-testid="to-incident">
            {t('dgv.recon.incident.link')}
          </Link>
        </p>
      )}
      {recon.differences.length === 0 ? (
        <p className="callout" role="status" data-testid="no-differences">
          {t('dgv.recon.differences.none')}
        </p>
      ) : (
        <table className="table" data-testid="differences">
          <thead>
            <tr>
              <th scope="col">{t('dgv.recon.column.project')}</th>
              <th scope="col">{t('dgv.recon.column.kind')}</th>
              <th scope="col">{t('dgv.recon.column.side')}</th>
              <th scope="col">{t('dgv.recon.column.totalA')}</th>
              <th scope="col">{t('dgv.recon.column.totalB')}</th>
              <th scope="col">{t('dgv.recon.column.difference')}</th>
            </tr>
          </thead>
          <tbody>
            {recon.differences.map((entry) => (
              <tr key={entry.key} data-difference={entry.key} data-kind={entry.kind}>
                <td>{entry.key}</td>
                <td data-testid="kind">{kindLabel(t, entry.kind)}</td>
                <td>{sideLabel(t, entry.side)}</td>
                <td>{dong(entry.amountA)}</td>
                <td>{dong(entry.amountB)}</td>
                <td>{dong(entry.difference)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {recon.differencesTruncated ? (
        <p className="callout warning" role="note" data-testid="truncated">
          {t('dgv.recon.differences.truncated', { shown: recon.differences.length, total: recon.differencesCount })}
        </p>
      ) : null}
    </div>
  );
}

function RunDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string | undefined) => void }) {
  const { t } = useTranslation();
  const run = useRunReconciliation();
  const catalog = useCatalog(NO_FILTER);
  const [form, setForm] = useState<ReconForm>(emptyRecon);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRecon(form);
  const shown = (field: keyof ReconForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ReconForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (run.isPending || Object.keys(problems).length > 0) return;
    run.mutate({ body: reconBody(form) }, { onSuccess: (done) => onDone(resourceIdOf(done)) });
  };
  return (
    <CommandFrame
      title={t('dgv.recon.run.title')}
      refusal={run.isError ? problemMessage(t, describeProblem(run.error)) : undefined}
      pending={run.isPending}
      submitLabel={t('dgv.recon.run.submit')}
      words={{ close: t('dgv.source.dialog.close'), cancel: t('dgv.source.dialog.cancel'), pending: t('dgv.source.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset className="incident-fields" disabled={run.isPending}>
        <Field id="run-code" label={t('dgv.recon.column.code')} error={shown('reconCode')}>
          <input id="run-code" value={form.reconCode} maxLength={80} onChange={(event) => set({ reconCode: event.target.value })} />
        </Field>
        <Field id="run-period" label={t('dgv.recon.column.period')} error={shown('asOfPeriod')} hint={t('dgv.recon.period.hint')}>
          <input id="run-period" value={form.asOfPeriod} placeholder="2026-10" maxLength={7} onChange={(event) => set({ asOfPeriod: event.target.value })} />
        </Field>
        <Field id="run-tolerance" label={t('dgv.recon.tolerance')} error={shown('toleranceVnd')} hint={t('dgv.recon.tolerance.hint')}>
          <input id="run-tolerance" inputMode="numeric" value={form.toleranceVnd} maxLength={24} onChange={(event) => set({ toleranceVnd: event.target.value })} />
        </Field>
        <Field id="run-dataset" label={t('dgv.recon.dataset')} error={shown('datasetId')} hint={t('dgv.recon.dataset.hint')}>
          <select id="run-dataset" value={form.datasetId} onChange={(event) => set({ datasetId: event.target.value })}>
            <option value="">{t('dgv.recon.dataset.auto')}</option>
            {(catalog.data ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.datasetCode}
              </option>
            ))}
          </select>
        </Field>
        <dl className="dgv-facts" data-testid="run-basis">
          <div>
            <dt>{t('dgv.recon.source.a')}</dt>
            <dd>{RECON_SOURCE_A}</dd>
          </div>
          <div>
            <dt>{t('dgv.recon.source.b')}</dt>
            <dd>{RECON_SOURCE_B}</dd>
          </div>
          <div>
            <dt>{t('dgv.recon.basis')}</dt>
            <dd>{RECON_BASIS}</dd>
          </div>
        </dl>
      </fieldset>
    </CommandFrame>
  );
}
