import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Field } from '../components';
import { usePeriods } from '../hooks';
import { periodsOf, yearsOf } from '../model';
import '../dis.css';
import { useApplyImport, useCreateImport, useImportBatch, useUploadImportFile } from './hooks';
import { IMPORT_PATH, MAPPING_VERSION, canApply, canImport, codesOf, describeImport, filterFaults, importIdOf } from './import-model';
import type { ImportBatch, ImportFault, ImportProblem, StoredWorkbook } from './import-model';
import { REPORTS_PATH } from './model';

type T = Translator['t'];

function problemMessage(t: T, problem: ImportProblem): string {
  switch (problem) {
    case 'alreadyApplied':
      return t('dis.reportImport.problem.alreadyApplied');
    case 'hasErrors':
      return t('dis.reportImport.problem.hasErrors');
    case 'mappingUnknown':
      return t('dis.reportImport.problem.mappingUnknown');
    case 'schemaInvalid':
      return t('dis.reportImport.problem.schemaInvalid');
    case 'periodLocked':
      return t('dis.reportImport.problem.periodLocked');
    case 'versionConflict':
      return t('dis.reportImport.problem.versionConflict');
    case 'scopeDenied':
      return t('dis.reportImport.problem.scopeDenied');
    case 'fileInfected':
      return t('dis.reportImport.problem.fileInfected');
    case 'fileType':
      return t('dis.reportImport.problem.fileType');
    case 'fileTooLarge':
      return t('dis.reportImport.problem.fileTooLarge');
    case 'scanPending':
      return t('dis.reportImport.problem.scanPending');
    case 'validation':
      return t('dis.reportImport.problem.validation');
    case 'notFound':
      return t('dis.reportImport.problem.notFound');
    case 'general':
      return t('dis.reportImport.problem.general');
  }
}

/** The sentence of one fault of a row: what is wrong, in the words of the person who has to fix the file. */
function faultMessage(t: T, code: string): string {
  switch (code) {
    case 'PROJECT_CODE_REQUIRED':
      return t('dis.reportImport.fault.projectRequired');
    case 'PROJECT_DUPLICATE_IN_FILE':
      return t('dis.reportImport.fault.projectDuplicate');
    case 'AMOUNT_INVALID':
      return t('dis.reportImport.fault.amountInvalid');
    case 'SUBSET_EXCEEDS_PARENT':
      return t('dis.reportImport.fault.subsetExceeds');
    case 'TOTAL_MISMATCH':
      return t('dis.reportImport.fault.totalMismatch');
    case 'VOLUMES_INVALID':
      return t('dis.reportImport.fault.volumesInvalid');
    case 'EXPLANATION_INVALID':
      return t('dis.reportImport.fault.explanationInvalid');
    case 'PROJECT_NOT_FOUND':
      return t('dis.reportImport.fault.projectNotFound');
    case 'PROJECT_STAGE_INVALID':
      return t('dis.reportImport.fault.projectStage');
    case 'PLAN_VERSION_NOT_EFFECTIVE':
      return t('dis.reportImport.fault.planNotEffective');
    case 'REPORT_STATE_INVALID':
      return t('dis.reportImport.fault.reportExists');
    case 'PERIOD_LOCKED':
      return t('dis.reportImport.fault.periodLocked');
    default:
      return t('dis.reportImport.fault.other');
  }
}

function statusMessage(t: T, batch: ImportBatch): string {
  switch (batch.status) {
    case 'VALIDATED':
      return t('dis.reportImport.status.validated');
    case 'DRY_RUN':
      return t('dis.reportImport.status.dryRun');
    case 'APPLIED':
      return t('dis.reportImport.status.applied');
    case 'FAILED':
      return t('dis.reportImport.status.failed');
    case 'CANCELLED':
      return t('dis.reportImport.status.cancelled');
  }
}

const NEVER_EMPTY = (): boolean => false;

/**
 * DIS-10: the bulk import of weekly reports (ST-DIS-008, DIS 3 F1): the workbook is uploaded (judged by its bytes, scanned), read with the layout named, and every row is judged in a dry run that tells
 * its faults with the line, the column and the reason. Only a file without a fault is applied; it makes the draft of every project, never hands one in, and cannot be applied twice.
 */
export default function ReportImportScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ReportImportContent key={tenantId ?? 'none'} route={route} />;
}

function ReportImportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { permissions, mode } = useSession();
  const periods = usePeriods();
  const upload = useUploadImportFile();
  const create = useCreateImport();
  const batchId = params.get('import') ?? undefined;
  const state = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: NEVER_EMPTY });
  const [year, setYear] = useState<number | undefined>(undefined);
  const [periodId, setPeriodId] = useState('');
  const [stored, setStored] = useState<StoredWorkbook | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const all = periods.data ?? [];
  const currentYear = new Date().getFullYear();
  const shownYear = year ?? currentYear;
  // A weekly workbook is for a week: the other kinds of period are not offered.
  const weeks = periodsOf(all, shownYear, '').filter((period) => period.periodType === 'WEEK');
  const allowed = canImport(permissions, mode);
  const failure = upload.isError ? describeImport(upload.error) : create.isError ? describeImport(create.error) : undefined;

  const choose = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined || !allowed || upload.isPending) return;
    setStored(undefined);
    try {
      setStored(await upload.mutateAsync(file));
    } catch {
      // The refusal is shown from the state of the upload.
    }
  };
  const check = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!allowed || create.isPending || periodId === '' || stored === undefined) return;
    create.mutate(
      { periodId, file: stored },
      {
        onSuccess: (done) => {
          const made = importIdOf(done);
          if (made !== undefined) void navigate(`${IMPORT_PATH}?import=${made}`);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{t('dis.reportImport.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reportImport.page.title')}</h1>
          <p>{t('dis.reportImport.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        <form className="card" onSubmit={check} noValidate aria-labelledby="import-form-title" data-testid="import-form">
          <h2 id="import-form-title">{t('dis.reportImport.form.title')}</h2>
          {allowed ? null : (
            <p className="callout warning" role="status" data-testid="import-denied">
              {t('dis.reportImport.denied.note')}
            </p>
          )}
          {failure === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="import-refusal">
              {problemMessage(t, failure)}
            </p>
          )}
          <div className="formgrid">
            <Field id="import-year" label={t('dis.reportImport.year.label')} error={undefined}>
              <select
                id="import-year"
                value={shownYear}
                onChange={(event) => {
                  setYear(Number(event.target.value));
                  setPeriodId('');
                }}
              >
                {yearsOf(all, currentYear).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="import-period" label={t('dis.reportImport.period.label')} error={submitted && periodId === '' ? t('dis.reportImport.period.required.error') : undefined}>
              <select id="import-period" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
                <option value="">{t('dis.reportImport.period.choose.option')}</option>
                {weeks.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="import-mapping" label={t('dis.reportImport.mapping.label')} hint={t('dis.reportImport.mapping.hint')} error={undefined}>
              <select id="import-mapping" value={MAPPING_VERSION} disabled onChange={() => undefined}>
                <option value={MAPPING_VERSION}>{t('dis.reportImport.mapping.option', { name: MAPPING_VERSION })}</option>
              </select>
            </Field>
            <Field id="import-file" label={t('dis.reportImport.file.label')} hint={t('dis.reportImport.file.hint')} error={submitted && stored === undefined ? t('dis.reportImport.file.required.error') : undefined}>
              <input id="import-file" type="file" accept=".csv,.xlsx" disabled={!allowed || upload.isPending} onChange={(event) => void choose(event)} />
            </Field>
          </div>
          {upload.isPending ? (
            <p role="status" data-testid="import-uploading">
              {t('dis.reportImport.file.uploading.text')}
            </p>
          ) : null}
          {stored === undefined ? null : (
            <p className="sub" data-testid="import-stored">
              {t('dis.reportImport.file.stored.text', { name: stored.fileName, rows: stored.rowCount, columns: stored.columns.length })}
            </p>
          )}
          <div className="formfooter">
            <button type="submit" disabled={!allowed || create.isPending}>
              {create.isPending ? t('dis.reportImport.check.pending') : t('dis.reportImport.check.action')}
            </button>
          </div>
        </form>
        {batchId === undefined ? null : <Batch key={batchId} id={batchId} />}
      </StateBoundary>
      <p className="prototype-note">{t('dis.reportImport.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** What the dry run found, and the button that applies a file that has no fault. */
function Batch({ id }: { id: string }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const batch = useImportBatch(id);
  const apply = useApplyImport();
  const [code, setCode] = useState('');
  const [project, setProject] = useState('');
  const state = useScreenState({ isLoading: batch.isLoading, error: batch.error, data: batch.data, isEmpty: (data) => data === undefined });
  const data = batch.data;
  const refusal = apply.isError ? describeImport(apply.error) : undefined;
  return (
    <StateBoundary state={state} onRetry={() => void batch.refetch()}>
      {data === undefined ? null : (
        <section className="card" aria-labelledby="import-result-title" data-testid="import-batch">
          <h2 id="import-result-title">{t('dis.reportImport.result.title')}</h2>
          <p className={data.status === 'DRY_RUN' ? 'callout warning' : 'callout'} role="status" data-testid="import-status">
            {statusMessage(t, data)}
          </p>
          <dl className="aud-facts" data-testid="import-counts">
            <dt>{t('dis.reportImport.count.total.label')}</dt>
            <dd data-testid="count-total">{data.totalRows}</dd>
            <dt>{t('dis.reportImport.count.valid.label')}</dt>
            <dd data-testid="count-valid">{data.validRows}</dd>
            <dt>{t('dis.reportImport.count.error.label')}</dt>
            <dd data-testid="count-error">{data.errorRows}</dd>
            {data.status === 'APPLIED' ? (
              <>
                <dt>{t('dis.reportImport.count.created.label')}</dt>
                <dd data-testid="count-created">{data.draftsCreated}</dd>
                <dt>{t('dis.reportImport.count.updated.label')}</dt>
                <dd data-testid="count-updated">{data.draftsUpdated}</dd>
              </>
            ) : null}
          </dl>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="apply-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          {data.status === 'APPLIED' ? (
            <p>
              <Link to={REPORTS_PATH}>{t('dis.reportImport.applied.link')}</Link>
            </p>
          ) : (
            <div className="formfooter">
              <button type="button" disabled={!canApply(data) || !canImport(permissions, mode) || apply.isPending} onClick={() => apply.mutate({ batch: data })}>
                {apply.isPending ? t('dis.reportImport.apply.pending') : t('dis.reportImport.apply.action')}
              </button>
              {canApply(data) ? null : <span className="sub">{t('dis.reportImport.apply.blocked.text')}</span>}
            </div>
          )}
          <Faults faults={data.faults} code={code} project={project} onCode={setCode} onProject={setProject} />
        </section>
      )}
    </StateBoundary>
  );
}

function Faults({ faults, code, project, onCode, onProject }: { faults: readonly ImportFault[]; code: string; project: string; onCode(value: string): void; onProject(value: string): void }) {
  const { t } = useTranslation();
  if (faults.length === 0) {
    return (
      <p className="muted" data-testid="faults-none">
        {t('dis.reportImport.faults.none.text')}
      </p>
    );
  }
  const shown = filterFaults(faults, code, project);
  return (
    <section aria-labelledby="import-faults-title">
      <h3 id="import-faults-title">{t('dis.reportImport.faults.title')}</h3>
      <div className="dis-filters" role="group" aria-label={t('dis.reportImport.faults.filter.title')}>
        <Field id="fault-code" label={t('dis.reportImport.faults.code.label')} error={undefined}>
          <select id="fault-code" value={code} onChange={(event) => onCode(event.target.value)}>
            <option value="">{t('dis.reportImport.faults.all.option')}</option>
            {codesOf(faults).map((option) => (
              <option key={option} value={option}>
                {faultMessage(t, option)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fault-project" label={t('dis.reportImport.faults.project.label')} error={undefined}>
          <input id="fault-project" value={project} onChange={(event) => onProject(event.target.value)} />
        </Field>
      </div>
      <p className="sub" data-testid="faults-shown">
        {t('dis.reportImport.faults.shown.text', { shown: shown.length, total: faults.length })}
      </p>
      <div className="tablewrap">
        <table className="table" aria-label={t('dis.reportImport.faults.aria')} data-testid="faults">
          <thead>
            <tr>
              <th scope="col" className="num">
                {t('dis.reportImport.faults.col.line')}
              </th>
              <th scope="col">{t('dis.reportImport.faults.col.project')}</th>
              <th scope="col">{t('dis.reportImport.faults.col.field')}</th>
              <th scope="col">{t('dis.reportImport.faults.col.problem')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((fault) => (
              <tr key={`${fault.line}:${fault.field}:${fault.code}`} data-code={fault.code}>
                <td className="num">{fault.line}</td>
                <td>{fault.projectCode ?? t('dis.reportEdit.none.text')}</td>
                <td>
                  <code>{fault.field}</code>
                </td>
                <td>{faultMessage(t, fault.code)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
