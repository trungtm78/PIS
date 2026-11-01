import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useApply, useBatch, useBatches, useDryRun, useRegister, useRollback, useUploadFile } from './hooks';
import { problemMessage, statusLabel } from './labels';
import { APPROVE_PERMISSION, EMPTY_REGISTER, MANAGE_PERMISSION, MAPPINGS, canApply, canDryRun, canRollback, describeProblem, errorsCsv, isWorking, reasonProblem, validateRegister } from './model';
import type { Batch, FormProblem, RegisterField, RegisterForm, Totals, UploadedFile } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
const SHORT_HASH = 12;

function Field({ id, label, error, hint, children }: { id: string; label: string; error: string | undefined; hint?: string; children: ReactNode }) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

/** The file of the errors of a dry run, offered to the browser to save: it is made here from what the server listed, nothing more is asked of it. */
function downloadCsv(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * ADM-13: the conversion of legacy data in batches (ST-ADM-020, ADM 3.10, BR-ADM-12): a file is registered once for an entity (its hash is its identity), dry-run without a row written (the errors are listed row by row and
 * offered as a CSV), applied by somebody other than who registered it, with the control totals of the file set against what was written, and rolled back while nothing is built on its rows.
 */
export default function MigrationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form or batch of the one is left open for the other.
  return <MigrationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MigrationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const batches = useBatches();
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: batches.isLoading, error: batches.error, data: batches.data, isEmpty: () => false });
  const list = batches.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.migration.title')}</h1>
          <p>{t('adm.migration.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void batches.refetch()}>
        {holds(permissions, MANAGE_PERMISSION, mode) ? <RegisterPanel /> : null}
        {list.length === 0 ? (
          <p className="card" data-testid="no-batches">
            {t('adm.migration.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="batches" aria-label={t('adm.migration.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('adm.migration.col.entity')}</th>
                  <th scope="col">{t('adm.migration.col.source')}</th>
                  <th scope="col">{t('adm.migration.col.hash')}</th>
                  <th scope="col">{t('adm.migration.col.mapping')}</th>
                  <th scope="col">{t('adm.migration.col.rows')}</th>
                  <th scope="col">{t('adm.migration.col.errors')}</th>
                  <th scope="col">{t('adm.migration.col.status')}</th>
                  <th scope="col">{t('adm.migration.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((batch) => (
                  <tr key={batch.id} data-batch={batch.id} data-status={batch.status}>
                    <td>{batch.targetEntity}</td>
                    <td>{batch.sourceSystem}</td>
                    <td>
                      <code title={batch.fileSha256}>{batch.fileSha256.slice(0, SHORT_HASH)}</code>
                    </td>
                    <td>{batch.mappingVersion}</td>
                    <td>{batch.rowCount}</td>
                    <td>{batch.errorCount}</td>
                    <td>
                      <span className={`pill ${batch.status === 'Applied' ? 'green' : batch.status === 'Failed' || batch.status === 'DryRunFailed' ? 'red' : 'gray'}`} data-testid="status">
                        {statusLabel(t, batch.status)}
                      </span>
                    </td>
                    <td>
                      <button type="button" onClick={() => setOpened(batch.id)}>
                        {t('adm.migration.open.action', { entity: batch.targetEntity })}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {opened === undefined ? null : <BatchPanel key={opened} id={opened} onClose={() => setOpened(undefined)} />}
      </StateBoundary>
      <p className="prototype-note">{t('adm.migration.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RegisterPanel() {
  const { t } = useTranslation();
  const send = useRegister();
  const upload = useUploadFile();
  const [uploaded, setUploaded] = useState<UploadedFile | undefined>(undefined);
  const [form, setForm] = useState<RegisterForm>(EMPTY_REGISTER);
  const [problems, setProblems] = useState<Partial<Record<RegisterField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeProblem(send.error) : undefined;
  const uploadFailure = upload.isError ? describeProblem(upload.error) : undefined;
  const set = (patch: Partial<RegisterForm>): void => setForm((value) => ({ ...value, ...patch }));
  const choose = (file: File | undefined): void => {
    if (file === undefined) return;
    // The file that was chosen before is not the file of this form any more, whatever happens to the new one.
    setUploaded(undefined);
    set({ fileId: '' });
    upload.mutate(file, {
      onSuccess: (done) => {
        setUploaded(done);
        if (done !== undefined) set({ fileId: done.fileId });
      },
    });
  };
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('adm.migration.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateRegister(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending || upload.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setUploaded(undefined);
        setForm(EMPTY_REGISTER);
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('adm.migration.register.title')}>
      <h2>{t('adm.migration.register.title')}</h2>
      <Field id="migration-source" label={t('adm.migration.register.source')} error={message(problems.sourceSystem, t('adm.migration.register.source.invalid'))}>
        <input id="migration-source" value={form.sourceSystem} aria-invalid={problems.sourceSystem !== undefined} onChange={(event) => set({ sourceSystem: event.target.value })} />
      </Field>
      <Field
        id="migration-entity"
        label={t('adm.migration.register.entity')}
        hint={t('adm.migration.register.entity.hint')}
        error={message(problems.targetEntity, t('adm.migration.register.entity.invalid'))}
      >
        <input id="migration-entity" value={form.targetEntity} aria-invalid={problems.targetEntity !== undefined} onChange={(event) => set({ targetEntity: event.target.value })} />
      </Field>
      <Field id="migration-upload" label={t('adm.migration.upload.label')} hint={t('adm.migration.upload.hint')} error={undefined}>
        <input
          id="migration-upload"
          type="file"
          disabled={upload.isPending}
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => choose(event.target.files?.[0])}
        />
      </Field>
      {uploaded === undefined ? null : (
        <p className="callout" role="status" data-testid="upload-done">
          {t('adm.migration.upload.done', { rows: uploaded.rows, columns: uploaded.columns.join(', ') })}
        </p>
      )}
      {uploadFailure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="upload-refusal" data-reason={uploadFailure.reason}>
          {problemMessage(t, uploadFailure)}
        </p>
      )}
      <Field id="migration-file" label={t('adm.migration.register.file')} hint={t('adm.migration.register.file.hint')} error={message(problems.fileId, t('adm.migration.register.file.invalid'))}>
        <input id="migration-file" value={form.fileId} aria-invalid={problems.fileId !== undefined} onChange={(event) => set({ fileId: event.target.value })} />
      </Field>
      <Field id="migration-mapping" label={t('adm.migration.register.mapping')} error={undefined}>
        <select id="migration-mapping" value={form.mappingVersion} onChange={(event) => set({ mappingVersion: event.target.value })}>
          {MAPPINGS.map((mapping) => (
            <option key={mapping} value={mapping}>
              {mapping}
            </option>
          ))}
        </select>
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="register-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="register-saved">
          {t('adm.migration.register.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending || upload.isPending}>
          {t('adm.migration.register.submit')}
        </button>
      </div>
    </form>
  );
}

function TotalsLine({ label, totals, testId }: { label: string; totals: Totals | null; testId: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd>{totals === null ? '—' : t('adm.migration.detail.totals', { rows: totals.rows, amount: totals.amount })}</dd>
    </div>
  );
}

function BatchPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const detail = useBatch(id);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data, isEmpty: (batch) => batch === undefined });
  return (
    <section className="card" aria-label={t('adm.migration.detail.title')} data-testid="batch-detail">
      <div className="heading">
        <h2>{t('adm.migration.detail.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('adm.migration.detail.close')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void detail.refetch()}>
        {detail.data === undefined ? null : (
          <BatchDetail batch={detail.data} mayManage={holds(permissions, MANAGE_PERMISSION, mode)} mayApprove={holds(permissions, APPROVE_PERMISSION, mode)} me={tenant?.membershipId} />
        )}
      </StateBoundary>
    </section>
  );
}

function BatchDetail({ batch, mayManage, mayApprove, me }: { batch: Batch; mayManage: boolean; mayApprove: boolean; me: string | undefined }) {
  const { t } = useTranslation();
  const dryRun = useDryRun();
  const apply = useApply();
  const rollback = useRollback();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const mutation = [dryRun, apply, rollback].find((one) => one.isError);
  const failure = mutation === undefined ? undefined : describeProblem(mutation.error);
  const pending = dryRun.isPending || apply.isPending || rollback.isPending;
  const registeredByMe = me !== undefined && batch.createdBy === me;

  const run = (send: typeof dryRun | typeof apply | typeof rollback): void => {
    const found = reasonProblem(reason);
    setProblem(found);
    if (found !== undefined || pending) return;
    send.mutate({ batch, reason }, { onSuccess: () => setReason('') });
  };

  const showDryRun = mayManage && canDryRun(batch.status);
  const showApply = mayApprove && canApply(batch.status);
  const showRollback = mayApprove && canRollback(batch.status);

  return (
    <div>
      <dl>
        <div>
          <dt>{t('adm.migration.col.status')}</dt>
          <dd>
            <span className="pill gray" data-testid="detail-status">
              {statusLabel(t, batch.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('adm.migration.col.hash')}</dt>
          <dd>
            <code data-testid="detail-hash">{batch.fileSha256}</code>
          </dd>
        </div>
        <TotalsLine label={t('adm.migration.detail.expected')} totals={batch.totals.expected} testId="totals-expected" />
        <TotalsLine label={t('adm.migration.detail.actual')} totals={batch.totals.actual} testId="totals-actual" />
        {batch.totals.matched === null ? null : (
          <div>
            <dt>{t('adm.migration.detail.matched')}</dt>
            <dd data-testid="totals-matched">{batch.totals.matched ? t('adm.migration.detail.match') : t('adm.migration.detail.mismatch')}</dd>
          </div>
        )}
        {batch.status === 'RolledBack' ? (
          <div>
            <dt>{t('adm.migration.detail.rolledback')}</dt>
            <dd data-testid="rollback-reason">{batch.rollbackReason ?? '—'}</dd>
          </div>
        ) : null}
      </dl>
      {isWorking(batch.status) ? (
        <p className="callout" role="status" data-testid="working">
          {t('adm.migration.detail.working')}
        </p>
      ) : null}
      {batch.failureCode === null ? null : (
        <p className="callout warning" role="alert" data-testid="failure-code">
          {t('adm.migration.detail.failure', { code: batch.failureCode })}
        </p>
      )}
      <h3>{t('adm.migration.detail.errors')}</h3>
      {batch.errors.length === 0 ? (
        <p data-testid="no-errors">{t('adm.migration.errors.none')}</p>
      ) : (
        <>
          <div className="tablewrap">
            <table className="table" data-testid="errors" aria-label={t('adm.migration.detail.errors')}>
              <thead>
                <tr>
                  <th scope="col">{t('adm.migration.errors.row')}</th>
                  <th scope="col">{t('adm.migration.errors.line')}</th>
                  <th scope="col">{t('adm.migration.errors.field')}</th>
                  <th scope="col">{t('adm.migration.errors.code')}</th>
                  <th scope="col">{t('adm.migration.errors.message')}</th>
                </tr>
              </thead>
              <tbody>
                {batch.errors.map((error) => (
                  <tr key={`${error.rowNumber}:${error.field}:${error.code}`} data-row={error.rowNumber}>
                    <td>{error.rowNumber}</td>
                    <td>{error.lineNumber}</td>
                    <td>
                      <code>{error.field}</code>
                    </td>
                    <td>{error.code}</td>
                    <td>{error.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={() => downloadCsv(`migration-${batch.id}-errors.csv`, errorsCsv(batch.errors))}>
            {t('adm.migration.errors.download')}
          </button>
        </>
      )}
      {showDryRun || showApply || showRollback ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
          noValidate
          aria-label={t('adm.migration.detail.actions')}
        >
          <Field
            id={`migration-reason-${batch.id}`}
            label={t('adm.migration.detail.reason')}
            error={problem === undefined ? undefined : problem === 'required' ? t('adm.migration.form.required') : t('adm.migration.detail.reason.invalid')}
          >
            <input id={`migration-reason-${batch.id}`} value={reason} aria-invalid={problem !== undefined} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {showApply && registeredByMe ? (
            <p className="sub" data-testid="self-hint">
              {t('adm.migration.action.selfhint')}
            </p>
          ) : null}
          {failure === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="action-refusal" data-reason={failure.reason}>
              {problemMessage(t, failure)}
            </p>
          )}
          <div className="formfooter">
            {showDryRun ? (
              <button type="button" disabled={pending} onClick={() => run(dryRun)}>
                {t('adm.migration.action.dryrun')}
              </button>
            ) : null}
            {showApply ? (
              <button type="button" className="primary" disabled={pending || registeredByMe} onClick={() => run(apply)}>
                {t('adm.migration.action.apply')}
              </button>
            ) : null}
            {showRollback ? (
              <button type="button" disabled={pending} onClick={() => run(rollback)}>
                {t('adm.migration.action.rollback')}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
