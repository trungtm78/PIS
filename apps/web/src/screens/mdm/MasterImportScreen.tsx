import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { camel, toCsv } from './catalogues';
import { Field } from './components';
import { useApplyImport, useDecideImport, useImportBatch, useImportBatches, usePublishImport, useRecords, useStageImport, useUploadImportFile } from './hooks';
import { importStatusLabel, problemMessage, rowErrorLabel, rowFieldLabel } from './labels';
import { EMPTY_MAPPING, IMPORT_PERMISSION, PUBLISH_PERMISSION, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REVIEW_PERMISSION, describeProblem, mappingBody, mappingComplete, suggestMapping } from './model';
import type { ImportBatchView, ImportFileView, ImportMappingForm, ImportMode } from './model';
import { TYPE_FORMS } from './typeForms';

const APPROVAL_PATH = '/mdm/mdm-32';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_PARTS = ['key', 'label', 'valid_from'] as const;
const OPTIONAL_PARTS = ['parent_key', 'valid_until', 'legal_basis'] as const;
const NEVER_EMPTY = (): boolean => false;
const KIB = 1024;

type StepState = 'pending' | 'active' | 'done' | 'problem';

function stepLabel(t: ReturnType<typeof useTranslation>['t'], state: StepState): string {
  switch (state) {
    case 'pending':
      return t('mdm.import.step.pending.pill');
    case 'active':
      return t('mdm.import.step.active.pill');
    case 'done':
      return t('mdm.import.step.done.pill');
    case 'problem':
      return t('mdm.import.step.problem.pill');
  }
}

function sizeText(bytes: number): string {
  return bytes < KIB * KIB ? `${Math.max(1, Math.round(bytes / KIB))} KB` : `${(bytes / (KIB * KIB)).toFixed(1)} MB`;
}

/**
 * MDM-29: bulk import of a catalogue. The file is uploaded and read, its columns are mapped, a dry run says row by row what is wrong, and only
 * then is the batch applied: the records and their change requests are created together and wait for a reviewer and a publisher who did not
 * apply it, who decide the whole batch at once (ST-MDM-006).
 */
export default function MasterImportScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterImportContent key={tenantId ?? 'none'} route={route} />;
}

function MasterImportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, tenant, mode: sessionMode } = useSession();
  const frozen = sessionMode === 'READ_ONLY';
  const may = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const [params, setParams] = useSearchParams();
  const batchId = params.get('batch');
  const records = useRecords(undefined);
  const upload = useUploadImportFile();
  const stage = useStageImport();
  const apply = useApplyImport();
  const decide = useDecideImport();
  const publish = usePublishImport();
  const batch = useImportBatch(batchId);
  const recent = useImportBatches();
  const [masterType, setMasterType] = useState('');
  const [mode, setMode] = useState<ImportMode>('ATOMIC');
  const [file, setFile] = useState<File | undefined>(undefined);
  const [uploaded, setUploaded] = useState<ImportFileView | undefined>(undefined);
  const [mapping, setMapping] = useState<ImportMappingForm>(EMPTY_MAPPING);
  const [sawSkipped, setSawSkipped] = useState(false);
  const [reason, setReason] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [invalid, setInvalid] = useState<'reason' | 'document' | undefined>(undefined);
  const state = useScreenState({ isLoading: recent.isLoading, error: recent.error, data: recent.data, isEmpty: NEVER_EMPTY });
  const types = useMemo(() => [...new Set((records.data ?? []).map((record) => record.masterType))].sort(), [records.data]);
  const attributeNames = useMemo(() => (TYPE_FORMS[masterType.trim()] ?? []).map((spec) => spec.name), [masterType]);
  // Only a column that is mapped can hold codes of another system.
  const translatable = [...(mapping.parent_key === '' ? [] : ['parent_key']), ...attributeNames.filter((name) => (mapping.attributes[name] ?? '') !== '').map((name) => `attributes.${name}`)];
  const toggleTranslated = (field: string): void =>
    setMapping((previous) => ({ ...previous, crosswalk_fields: previous.crosswalk_fields.includes(field) ? previous.crosswalk_fields.filter((item) => item !== field) : [...previous.crosswalk_fields, field] }));
  const current = batch.data ?? undefined;
  const problem = [upload, stage, apply, decide, publish].flatMap((mutation) => (mutation.isError ? [describeProblem(mutation.error)] : []))[0];

  const choose = (batchOf: string | undefined): void => setParams(batchOf === undefined ? {} : { batch: batchOf });

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (file === undefined || !may(IMPORT_PERMISSION) || upload.isPending) return;
    upload.mutate(file, {
      onSuccess: (result) => {
        setUploaded(result);
        setMapping(result === undefined ? EMPTY_MAPPING : suggestMapping(result.columns, attributeNames));
        choose(undefined);
      },
    });
  };

  const check = (): void => {
    if (uploaded === undefined || !mappingComplete(mapping) || masterType.trim() === '' || stage.isPending) return;
    stage.mutate(
      { master_type: masterType.trim(), file_object_key: uploaded.fileObjectKey, file_sha256: uploaded.fileSha256, mapping: mappingBody(mapping), mode },
      { onSuccess: (answer) => choose((answer as { resource_id?: string }).resource_id) },
    );
  };

  const exportErrors = (): void => {
    if (current === undefined) return;
    const csv = toCsv([t('mdm.import.errors.row.column'), t('mdm.import.errors.field.column'), t('mdm.import.errors.problem.column')], current.errors.map((error) => [String(error.row), rowFieldLabel(t, error.field), rowErrorLabel(t, error.code)]));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `import-errors-${current.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const decideBatch = (decision: 'approve' | 'reject'): void => {
    if (current === undefined || decide.isPending) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setInvalid('reason');
      return;
    }
    decide.mutate({ id: current.id, version: current.version, decision, reason: trimmed }, { onSuccess: () => setReason('') });
  };

  const publishBatch = (event: FormEvent): void => {
    event.preventDefault();
    if (current === undefined || publish.isPending) return;
    if (!UUID.test(documentId.trim())) {
      setInvalid('document');
      return;
    }
    publish.mutate({ id: current.id, version: current.version, decisionDocumentId: documentId.trim().toLowerCase() }, { onSuccess: () => setDocumentId('') });
  };

  const stepStates = ((): StepState[] => {
    const filed: StepState = uploaded === undefined && current === undefined ? 'active' : 'done';
    const mapped: StepState = current !== undefined ? 'done' : uploaded === undefined ? 'pending' : 'active';
    const dry: StepState = current === undefined ? 'pending' : 'done';
    const errored: StepState = current === undefined ? 'pending' : current.errorRows > 0 ? 'problem' : 'done';
    const approval: StepState = current === undefined ? 'pending' : current.status === 'APPLIED' ? 'done' : current.status === 'CANCELLED' || current.status === 'FAILED' ? 'problem' : 'active';
    return [filed, mapped, dry, errored, approval];
  })();
  const steps = [t('mdm.import.step.file.title'), t('mdm.import.step.mapping.title'), t('mdm.import.step.dryRun.title'), t('mdm.import.step.errors.title'), t('mdm.import.step.approval.title')];

  const mine = current !== undefined && current.createdBy === tenant?.membershipId;
  const approved = current !== undefined && current.status === 'IN_REVIEW' && current.reviewedBy !== null;
  const pendingReview = current !== undefined && current.status === 'IN_REVIEW' && current.reviewedBy === null;
  const blocked = current !== undefined && current.mode === 'ATOMIC' && current.errorRows > 0;
  const readyToApply = current !== undefined && current.status === 'VALIDATED' && !blocked && (current.errorRows === 0 || sawSkipped);

  const batchSummary = (item: ImportBatchView) => (
    <dl data-testid="batch">
      <dt>{t('mdm.import.batch.status.label')}</dt>
      <dd data-status={item.status}>{importStatusLabel(t, item.status)}</dd>
      <dt>{t('mdm.import.batch.type.label')}</dt>
      <dd>{item.masterType}</dd>
      <dt>{t('mdm.import.batch.mode.label')}</dt>
      <dd>{item.mode === 'ATOMIC' ? t('mdm.import.mode.atomic.label') : t('mdm.import.mode.partial.label')}</dd>
      <dt>{t('mdm.import.batch.rows.label')}</dt>
      <dd>{t('mdm.import.batch.rows.text', { total: item.totalRows, errors: item.errorRows })}</dd>
      {Object.keys(item.changes).length === 0 ? null : (
        <>
          <dt>{t('mdm.import.batch.changes.label')}</dt>
          <dd data-testid="changes">{Object.entries(item.changes).map(([status, count]) => `${status}: ${count}`).join(' · ')}</dd>
        </>
      )}
    </dl>
  );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.import.page.title')}</h1>
          <p>{t('mdm.catalogue.page.subtitle')}</p>
        </div>
        <div className="row-actions">
          <button type="button" onClick={exportErrors} disabled={current === undefined || current.errors.length === 0}>
            {t('mdm.import.export.action')}
          </button>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('mdm.readOnly.frozen.notice')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, problem)}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void recent.refetch()}>
        <div className="mdm-grid">
          <div className="card" data-testid="steps">
            <h2>{t('mdm.import.steps.title')}</h2>
            <ol className="plain mdm-steps">
              {steps.map((title, index) => (
                <li key={title} data-step={index + 1} data-state={stepStates[index]}>
                  <strong>{title}</strong> <span className="pill gray">{stepLabel(t, stepStates[index] ?? 'pending')}</span>
                </li>
              ))}
            </ol>

            <form onSubmit={send} noValidate aria-label={t('mdm.import.step.file.title')} className="mdm-step-panel">
              <fieldset className="formgrid" disabled={!may(IMPORT_PERMISSION)}>
                <Field id="import-type" label={t('mdm.import.type.label')} error={undefined}>
                  <input id="import-type" list="mdm-import-types" value={masterType} onChange={(event) => setMasterType(event.target.value)} />
                  <datalist id="mdm-import-types">
                    {types.map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                </Field>
                <Field id="import-file" label={t('mdm.import.file.label')} error={undefined} hint={t('mdm.import.file.hint')}>
                  <input id="import-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0])} />
                </Field>
              </fieldset>
              <fieldset className="mdm-modes" disabled={!may(IMPORT_PERMISSION)}>
                <legend>{t('mdm.import.mode.label')}</legend>
                {(['ATOMIC', 'PARTIAL'] as const).map((item) => (
                  <label key={item} className="check">
                    <input type="radio" name="import-mode" value={item} checked={mode === item} onChange={() => setMode(item)} />
                    {item === 'ATOMIC' ? t('mdm.import.mode.atomic.label') : t('mdm.import.mode.partial.label')}
                  </label>
                ))}
                <small className="sub">{mode === 'ATOMIC' ? t('mdm.import.mode.atomic.hint') : t('mdm.import.mode.partial.hint')}</small>
              </fieldset>
              {!may(IMPORT_PERMISSION) ? (
                <p className="callout warning" role="status">
                  {t('mdm.readOnly.denied.notice')}
                </p>
              ) : (
                <div className="formfooter">
                  <button type="submit" className="primary" disabled={file === undefined || upload.isPending}>
                    {t('mdm.import.upload.action')}
                  </button>
                </div>
              )}
            </form>

            {uploaded === undefined || current !== undefined ? null : (
              <section className="mdm-step-panel" aria-label={t('mdm.import.step.mapping.title')} data-testid="mapping">
                <h3>{t('mdm.import.step.mapping.title')}</h3>
                <div className="formgrid">
                  {REQUIRED_PARTS.map((part) => (
                    <Field key={part} id={`map-${part}`} label={t(`mdm.import.map.${camel(part)}.label`)} error={undefined}>
                      <select id={`map-${part}`} value={mapping[part]} onChange={(event) => setMapping((previous) => ({ ...previous, [part]: event.target.value }))}>
                        <option value="">{t('mdm.import.map.choose.option')}</option>
                        {uploaded.columns.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                  {OPTIONAL_PARTS.map((part) => (
                    <Field key={part} id={`map-${part}`} label={t(`mdm.import.map.${camel(part)}.label`)} error={undefined}>
                      <select id={`map-${part}`} value={mapping[part]} onChange={(event) => setMapping((previous) => ({ ...previous, [part]: event.target.value }))}>
                        <option value="">{t('mdm.import.map.unused.option')}</option>
                        {uploaded.columns.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                  {attributeNames.map((name) => (
                    <Field key={name} id={`map-attribute-${name}`} label={t('mdm.import.map.attribute.label', { name })} error={undefined}>
                      <select
                        id={`map-attribute-${name}`}
                        value={mapping.attributes[name] ?? ''}
                        onChange={(event) => setMapping((previous) => ({ ...previous, attributes: { ...previous.attributes, [name]: event.target.value } }))}
                      >
                        <option value="">{t('mdm.import.map.unused.option')}</option>
                        {uploaded.columns.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
                <fieldset className="mdm-crosswalk-map" data-testid="crosswalk-map">
                  <legend>{t('mdm.import.crosswalk.title')}</legend>
                  <p className="sub">{t('mdm.import.crosswalk.help')}</p>
                  <div className="formgrid">
                    <Field id="map-crosswalk-system" label={t('mdm.import.crosswalk.system.label')} error={undefined}>
                      <input id="map-crosswalk-system" value={mapping.crosswalk_system} onChange={(event) => setMapping((previous) => ({ ...previous, crosswalk_system: event.target.value }))} />
                    </Field>
                    <Field id="map-crosswalk-type" label={t('mdm.import.crosswalk.type.label')} error={undefined}>
                      <input id="map-crosswalk-type" value={mapping.crosswalk_type} onChange={(event) => setMapping((previous) => ({ ...previous, crosswalk_type: event.target.value }))} />
                    </Field>
                  </div>
                  <ul className="plain">
                    {translatable.map((field) => (
                      <li key={field}>
                        <label>
                          <input type="checkbox" checked={mapping.crosswalk_fields.includes(field)} onChange={() => toggleTranslated(field)} />
                          {field === 'parent_key' ? t('mdm.import.crosswalk.parent.label') : t('mdm.import.crosswalk.attribute.label', { name: field.slice('attributes.'.length) })}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
                <div className="formfooter">
                  <button type="button" className="primary" onClick={check} disabled={!mappingComplete(mapping) || masterType.trim() === '' || stage.isPending}>
                    {t('mdm.import.check.action')}
                  </button>
                </div>
              </section>
            )}

            {current === undefined ? null : (
              <section className="mdm-step-panel" aria-label={t('mdm.import.step.dryRun.title')}>
                <h3>{t('mdm.import.step.dryRun.title')}</h3>
                {batchSummary(current)}
                {current.errors.length === 0 ? (
                  <p className="callout" role="status" data-testid="no-errors">
                    {t('mdm.import.errors.none.text')}
                  </p>
                ) : (
                  <>
                    <h3>{t('mdm.import.step.errors.title')}</h3>
                    <table className="table" data-testid="errors">
                      <thead>
                        <tr>
                          <th>{t('mdm.import.errors.row.column')}</th>
                          <th>{t('mdm.import.errors.field.column')}</th>
                          <th>{t('mdm.import.errors.problem.column')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {current.errors.map((error) => (
                          <tr key={`${error.row}:${error.field}:${error.code}`} data-row={error.row}>
                            <td>{error.row}</td>
                            <td>{rowFieldLabel(t, error.field)}</td>
                            <td>{rowErrorLabel(t, error.code)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {current.errorRows > current.errors.length ? <p className="sub">{t('mdm.import.errors.truncated.text', { shown: current.errors.length, total: current.errorRows })}</p> : null}
                  </>
                )}
              </section>
            )}

            {current === undefined ? null : (
              <section className="mdm-step-panel" aria-label={t('mdm.import.step.approval.title')} data-testid="approval">
                <h3>{t('mdm.import.step.approval.title')}</h3>
                {current.status === 'VALIDATED' ? (
                  <>
                    {blocked ? (
                      <p className="callout warning" role="status" data-testid="blocked">
                        {t('mdm.import.apply.blocked.notice')}
                      </p>
                    ) : null}
                    {current.mode === 'PARTIAL' && current.errorRows > 0 ? (
                      <label className="check">
                        <input type="checkbox" checked={sawSkipped} onChange={(event) => setSawSkipped(event.target.checked)} />
                        {t('mdm.import.apply.skipped.label', { count: current.errorRows })}
                      </label>
                    ) : null}
                    {may(IMPORT_PERMISSION) ? (
                      <div className="formfooter">
                        <button type="button" className="primary" disabled={!readyToApply || apply.isPending} onClick={() => apply.mutate({ id: current.id, version: current.version })}>
                          {t('mdm.import.apply.action')}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {pendingReview ? (
                  mine ? (
                    <p className="callout" role="status" data-testid="own-batch">
                      {t('mdm.import.review.own.hint')}
                    </p>
                  ) : may(REVIEW_PERMISSION) ? (
                    <form noValidate aria-label={t('mdm.import.review.title')} onSubmit={(event) => event.preventDefault()}>
                      <Field id="import-reason" label={t('mdm.approval.reason.label')} error={invalid === 'reason' ? t('mdm.field.tooShort.error') : undefined}>
                        <textarea id="import-reason" rows={2} value={reason} aria-invalid={invalid === 'reason'} onChange={(event) => { setReason(event.target.value); setInvalid(undefined); }} />
                      </Field>
                      <div className="formfooter">
                        <button type="button" className="primary" data-decision="approve" disabled={decide.isPending} onClick={() => decideBatch('approve')}>
                          {t('mdm.import.review.approve.action')}
                        </button>
                        <button type="button" data-decision="reject" disabled={decide.isPending} onClick={() => decideBatch('reject')}>
                          {t('mdm.import.review.reject.action')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <p className="muted">{t('mdm.import.review.waiting.text')}</p>
                  )
                ) : null}
                {approved ? (
                  mine ? (
                    <p className="callout" role="status" data-testid="own-batch">
                      {t('mdm.import.review.own.hint')}
                    </p>
                  ) : may(PUBLISH_PERMISSION) ? (
                    <form noValidate aria-label={t('mdm.import.publish.title')} onSubmit={publishBatch}>
                      <Field id="import-document" label={t('mdm.approval.document.label')} error={invalid === 'document' ? t('mdm.approval.document.error') : undefined} hint={t('mdm.approval.document.hint')}>
                        <input id="import-document" value={documentId} aria-invalid={invalid === 'document'} onChange={(event) => { setDocumentId(event.target.value); setInvalid(undefined); }} />
                      </Field>
                      <div className="formfooter">
                        <button type="submit" className="primary" disabled={publish.isPending}>
                          {t('mdm.import.publish.action')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <p className="muted">{t('mdm.import.publish.waiting.text')}</p>
                  )
                ) : null}
                {current.status === 'APPLIED' ? (
                  <p className="callout" role="status">
                    {t('mdm.import.applied.notice')}
                  </p>
                ) : null}
                {current.status === 'CANCELLED' ? (
                  <p className="callout warning" role="status">
                    {t('mdm.import.cancelled.notice')}
                  </p>
                ) : null}
                {current.status === 'IN_REVIEW' ? <Link to={APPROVAL_PATH}>{t('mdm.import.queue.link')}</Link> : null}
              </section>
            )}
          </div>

          <aside className="card" aria-label={t('mdm.import.preview.title')}>
            <h2>{t('mdm.import.preview.title')}</h2>
            {uploaded === undefined ? (
              <p className="muted">{t('mdm.import.preview.empty.text')}</p>
            ) : (
              <dl data-testid="file">
                <dt>{t('mdm.import.preview.format.label')}</dt>
                <dd>
                  {uploaded.format} · {sizeText(uploaded.sizeBytes)}
                </dd>
                <dt>{t('mdm.import.preview.rows.label')}</dt>
                <dd>{uploaded.rowCount}</dd>
                <dt>{t('mdm.import.preview.columns.label')}</dt>
                <dd>{uploaded.columns.filter((column) => column !== '').join(', ')}</dd>
                <dt>{t('mdm.import.preview.hash.label')}</dt>
                <dd>
                  <code>{uploaded.fileSha256.slice(0, 16)}</code>
                </dd>
              </dl>
            )}
            <h2>{t('mdm.import.recent.title')}</h2>
            {(recent.data ?? []).length === 0 ? (
              <p className="muted">{t('mdm.import.recent.empty.text')}</p>
            ) : (
              <ul className="plain" data-testid="recent">
                {(recent.data ?? []).map((item) => (
                  <li key={item.id} data-batch={item.id}>
                    <button type="button" aria-pressed={item.id === batchId} onClick={() => choose(item.id)}>
                      {item.masterType} · {importStatusLabel(t, item.status)} · {t('mdm.import.batch.rows.text', { total: item.totalRows, errors: item.errorRows })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('mdm.catalogue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
