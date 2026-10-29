import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { CommandFrame } from '../../qms/CommandFrame';
import { Field } from '../components';
import { NO_FILTER, useCatalog } from '../hooks';
import { useDecideMapping, useMappings, useProposeMapping } from './hooks';
import { formProblemMessage, mappingStatusLabel, mappingStatusTone, problemMessage, unitLabel } from './labels';
import { MAPPING_STATUSES, UNITS, decideBody, describeProblem, emptyDecide, emptyPropose, proposeBody, validatePropose } from './model';
import type { DecideForm, MappingView, ProposeForm } from './model';
import '../dgv.css';

type Dialog = { kind: 'propose' } | { kind: 'decide'; mapping: MappingView; decision: DecideForm['decision'] };

/**
 * DGV-20: the mappings of the fields of a source into a dataset (ST-DGV-004, DGV 3.3 F7, D04). A steward proposes a mapping with the unit the source writes the field in; somebody who did not propose it confirms or rejects it. The
 * pipeline reads only the confirmed ones. What each person may do comes from the server (`actions`); the server judges every command again and says why it refuses.
 */
export default function MappingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the open forms belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MappingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MappingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const [filter, setFilter] = useState({ datasetId: search.get('dataset') ?? '', status: '' });
  const list = useMappings(filter);
  const catalog = useCatalog(NO_FILTER);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const rows = (list.data?.pages ?? []).flatMap((entry) => entry.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const acting = mode !== 'READ_ONLY';
  const moment = (iso: string): string => (iso === '' ? t('dgv.source.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.source.title')}</h1>
          <p>{t('dgv.source.subtitle')}</p>
        </div>
        {acting ? (
          <button type="button" className="primary" data-action="propose" onClick={() => setDialog({ kind: 'propose' })}>
            {t('dgv.source.propose.action')}
          </button>
        ) : null}
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="mapping-filter-dataset">{t('dgv.source.column.dataset')}</label>
          <select id="mapping-filter-dataset" value={filter.datasetId} onChange={(event) => setFilter({ ...filter, datasetId: event.target.value })}>
            <option value="">{t('dgv.source.filter.all')}</option>
            {(catalog.data ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.datasetCode}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mapping-filter-status">{t('dgv.source.column.status')}</label>
          <select id="mapping-filter-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}>
            <option value="">{t('dgv.source.filter.all')}</option>
            {MAPPING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {mappingStatusLabel(t, status)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="card">
          {rows.length === 0 ? (
            <p className="callout" role="status" data-testid="no-mappings">
              {t('dgv.source.none.notice')}
            </p>
          ) : (
            <table className="table" data-testid="mappings">
              <thead>
                <tr>
                  <th scope="col">{t('dgv.source.column.dataset')}</th>
                  <th scope="col">{t('dgv.source.column.system')}</th>
                  <th scope="col">{t('dgv.source.column.sourceField')}</th>
                  <th scope="col">{t('dgv.source.column.targetField')}</th>
                  <th scope="col">{t('dgv.source.column.transform')}</th>
                  <th scope="col">{t('dgv.source.column.unit')}</th>
                  <th scope="col">{t('dgv.source.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('dgv.source.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-mapping={row.id} data-status={row.status}>
                    <td>{row.datasetCode}</td>
                    <td>{row.sourceSystem}</td>
                    <td>{row.sourceField}</td>
                    <td>{row.targetField}</td>
                    <td>{row.transformRule ?? t('dgv.source.none')}</td>
                    <td data-testid="unit">{unitLabel(t, row.unit)}</td>
                    <td>
                      <span className={`pill ${mappingStatusTone(row.status)}`} data-testid="status">
                        {mappingStatusLabel(t, row.status)}
                      </span>
                      <small className="sub">
                        {row.status === 'PROPOSED' ? t('dgv.source.proposedBy', { name: row.proposedByName ?? t('dgv.source.none'), at: moment(row.createdAt) }) : t('dgv.source.decidedBy', { name: row.decidedByName ?? t('dgv.source.none') })}
                        {row.decisionNote === null ? null : ` · ${row.decisionNote}`}
                      </small>
                    </td>
                    <td>
                      {acting && row.canDecide ? (
                        <>
                          <button type="button" className="primary" data-action="confirm" onClick={() => setDialog({ kind: 'decide', mapping: row, decision: 'CONFIRMED' })}>
                            {t('dgv.source.confirm.action')}
                          </button>{' '}
                          <button type="button" data-action="reject" onClick={() => setDialog({ kind: 'decide', mapping: row, decision: 'REJECTED' })}>
                            {t('dgv.source.reject.action')}
                          </button>
                        </>
                      ) : null}
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
      {dialog?.kind === 'propose' ? <ProposeDialog datasetId={filter.datasetId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'decide' ? <DecideDialog mapping={dialog.mapping} decision={dialog.decision} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('dgv.source.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ProposeDialog({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const propose = useProposeMapping();
  const catalog = useCatalog(NO_FILTER);
  const [form, setForm] = useState<ProposeForm>(() => emptyPropose(datasetId));
  const [submitted, setSubmitted] = useState(false);
  const problems = validatePropose(form);
  const shown = (field: keyof ProposeForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ProposeForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (propose.isPending || Object.keys(problems).length > 0) return;
    propose.mutate({ body: proposeBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('dgv.source.propose.title')}
      refusal={propose.isError ? problemMessage(t, describeProblem(propose.error)) : undefined}
      pending={propose.isPending}
      submitLabel={t('dgv.source.propose.submit')}
      words={{ close: t('dgv.source.dialog.close'), cancel: t('dgv.source.dialog.cancel'), pending: t('dgv.source.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset className="incident-fields" disabled={propose.isPending}>
        <Field id="propose-dataset" label={t('dgv.source.column.dataset')} error={shown('datasetId')}>
          <select id="propose-dataset" value={form.datasetId} onChange={(event) => set({ datasetId: event.target.value })}>
            <option value="">{t('dgv.source.choose')}</option>
            {(catalog.data ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.datasetCode}
              </option>
            ))}
          </select>
        </Field>
        <Field id="propose-system" label={t('dgv.source.column.system')} error={shown('sourceSystem')}>
          <input id="propose-system" value={form.sourceSystem} maxLength={120} onChange={(event) => set({ sourceSystem: event.target.value })} />
        </Field>
        <Field id="propose-source" label={t('dgv.source.column.sourceField')} error={shown('sourceField')}>
          <input id="propose-source" value={form.sourceField} maxLength={200} onChange={(event) => set({ sourceField: event.target.value })} />
        </Field>
        <Field id="propose-target" label={t('dgv.source.column.targetField')} error={shown('targetField')}>
          <input id="propose-target" value={form.targetField} maxLength={200} onChange={(event) => set({ targetField: event.target.value })} />
        </Field>
        <Field id="propose-transform" label={t('dgv.source.column.transform')} error={undefined}>
          <input id="propose-transform" value={form.transformRule} maxLength={2000} onChange={(event) => set({ transformRule: event.target.value })} />
        </Field>
        <Field id="propose-unit" label={t('dgv.source.column.unit')} error={undefined} hint={t('dgv.source.unit.hint')}>
          <select id="propose-unit" value={form.unit} onChange={(event) => set({ unit: event.target.value })}>
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unitLabel(t, unit)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

function DecideDialog({ mapping, decision, onClose }: { mapping: MappingView; decision: DecideForm['decision']; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = useDecideMapping();
  // The version read when the dialog opened is the one the decision is made at: a mapping that changed meanwhile is refused, not decided blindly.
  const [opened] = useState(() => ({ id: mapping.id, version: mapping.version }));
  const [form, setForm] = useState<DecideForm>(() => emptyDecide(decision));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (decide.isPending) return;
    decide.mutate({ id: opened.id, version: opened.version, body: decideBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={decision === 'CONFIRMED' ? t('dgv.source.confirm.title') : t('dgv.source.reject.title')}
      refusal={decide.isError ? problemMessage(t, describeProblem(decide.error)) : undefined}
      pending={decide.isPending}
      submitLabel={decision === 'CONFIRMED' ? t('dgv.source.confirm.submit') : t('dgv.source.reject.submit')}
      words={{ close: t('dgv.source.dialog.close'), cancel: t('dgv.source.dialog.cancel'), pending: t('dgv.source.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset className="incident-fields" disabled={decide.isPending}>
        <p data-testid="decide-summary">
          {mapping.datasetCode} · {mapping.sourceSystem}.{mapping.sourceField} → {mapping.targetField} · {unitLabel(t, mapping.unit)}
        </p>
        <Field id="decide-note" label={t('dgv.source.decide.note')} error={undefined}>
          <textarea id="decide-note" value={form.note} maxLength={1000} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
