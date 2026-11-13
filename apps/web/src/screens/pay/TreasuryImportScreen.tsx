import { useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { ScrollRegion } from '../scroll-region';
import { useImportStatement, useTreasuryImport, useTreasuryImports, useUploadStatementFile } from './hooks';
import {
  adapterStatusLabel,
  answerMessage,
  connectorStatusLabel,
  differenceLabel,
  fieldErrorMessage,
  fieldLabel,
  fileErrorMessage,
  importStatusLabel,
  itemStatusLabel,
  missingText,
  outcomeLabel,
  problemMessage,
  rowErrorLabel,
  sourceKindLabel,
} from './labels';
import {
  EMPTY_IMPORT_FORM,
  IMPORT_PERMISSION,
  IMPORT_READ_PERMISSION,
  SOURCE_KINDS,
  amountText,
  describeProblem,
  importBody,
  instantText,
  isImportId,
  ownerOfRow,
  quarantinedRows,
  signedAmountText,
  toImportAnswer,
  validateImport,
} from './model';
import type { FormErrors, ImportAnswer, ImportForm, ImportListItem, ImportView, ProblemView, RowView, SourceKind, StagedFile } from './model';
import './pay.css';

const NEVER_EMPTY = (): boolean => false;
const MASKED_FIELDS = ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at', 'payee_account'] as const;

/**
 * PAY-13: the import of a Treasury statement file. The file is identified by its SHA-256 and each row by its business key, so a file that
 * comes again is told as imported and a row that comes again is skipped; a row that cannot be taken goes to a quarantine with its reason and
 * an owner, and a row that contradicts one taken before leaves the first as it is and waits for a person (ST-PAY-006). The adapter is PROPOSED:
 * the layout is a working assumption until the agency gives samples, and the Treasury has no API for third parties.
 */
export default function TreasuryImportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the result belong to one membership: a switch starts the screen over.
  return <ImportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ImportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const frozen = mode === 'READ_ONLY';
  const mayImport = holds(IMPORT_PERMISSION) && !frozen;
  const mayRead = holds(IMPORT_READ_PERMISSION);
  const requested = params.get('import');
  const importId = isImportId(requested) ? requested : undefined;
  const view = useTreasuryImport(importId, mayRead);
  const state = useScreenState({ isLoading: view.isLoading, error: view.error, data: importId === undefined ? undefined : (view.data ?? undefined), isEmpty: NEVER_EMPTY });
  const recent = useTreasuryImports(mayRead);
  const [answer, setAnswer] = useState<ImportAnswer | undefined>();

  const open = (id: string): void => setParams({ import: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.import.page.title')}</h1>
          <p>{t('pay.import.page.subtitle')}</p>
        </div>
      </div>
      <AdapterNotice adapter={view.data?.adapter} />
      <ImportPanel allowed={mayImport} frozen={frozen} answer={answer} onAnswer={setAnswer} onOpen={open} />
      {mayRead ? <RecentImports items={recent.data ?? []} current={importId} onOpen={open} /> : null}
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.import.read.denied.notice')}
        </p>
      ) : importId === undefined ? (
        <p className="callout" role="status" data-testid="no-import">
          {requested === null ? t('pay.import.none.notice') : t('pay.import.notFound.notice')}
        </p>
      ) : view.isSuccess && view.data === null ? (
        <p className="callout warning" role="status" data-testid="import-missing">
          {t('pay.import.notFound.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void view.refetch()}>
          {view.data === undefined || view.data === null ? null : <ImportResult view={view.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.import.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function FieldBox({ id, label, error, hint, children }: { id: string; label: string; error: string | undefined; hint?: string; children: ReactNode }) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {wireControl(children, id, { hint: hint !== undefined, error: error !== undefined })}
      {hint === undefined ? null : (
        <small className="sub" id={hintIdOf(id)}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={errorIdOf(id)}>
          {error}
        </small>
      )}
    </div>
  );
}

/** The verdict on the adapter, always on the screen: the file is PROPOSED (its layout is assumed) and the Treasury API is MISSING. */
function AdapterNotice({ adapter }: { adapter: ImportView['adapter'] | undefined }) {
  const { t, locale } = useTranslation();
  return (
    <div className="card" data-testid="adapter">
      <h2>{t('pay.import.adapter.title')}</h2>
      <dl className="pay-facts">
        <Fact label={t('pay.import.adapter.file.label')}>
          <span className="pay-badge warning" data-testid="adapter-file">
            {adapterStatusLabel(t, adapter?.fileStatus ?? 'PROPOSED')}
          </span>
        </Fact>
        <Fact label={t('pay.import.adapter.api.label')}>
          <span className="pay-badge warning" data-testid="adapter-api">
            {adapterStatusLabel(t, adapter?.apiStatus ?? 'MISSING')}
          </span>
        </Fact>
        {adapter === undefined ? null : (
          <>
            <Fact label={t('pay.import.adapter.version.label')}>
              <span data-testid="adapter-version">{adapter.formatVersion}</span>
            </Fact>
            <Fact label={t('pay.import.adapter.connector.label')}>
              <span data-testid="adapter-connector">
                {adapter.connectorCode} · {connectorStatusLabel(t, adapter.connectorStatus)}
              </span>
            </Fact>
            <Fact label={t('pay.import.adapter.lastSuccess.label')}>{adapter.lastSuccessAt === null ? t('pay.import.adapter.never.text') : instantText(adapter.lastSuccessAt, locale)}</Fact>
            {adapter.lastErrorCode === null ? null : <Fact label={t('pay.import.adapter.lastError.label')}>{adapter.lastErrorCode}</Fact>}
          </>
        )}
      </dl>
      <p className="sub" data-testid="adapter-assumption">
        {t('pay.import.adapter.assumption.notice')}
      </p>
    </div>
  );
}

interface PanelProps {
  allowed: boolean;
  frozen: boolean;
  answer: ImportAnswer | undefined;
  onAnswer: (answer: ImportAnswer | undefined) => void;
  onOpen: (importId: string) => void;
}

const KIB = 1024;

/** The size of a file as a person reads it. */
function sizeText(bytes: number, locale: string): string {
  return bytes < KIB * KIB ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / KIB)} KiB` : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (KIB * KIB))} MiB`;
}

/**
 * The file picker and the form that imports the picked file. The file is uploaded as soon as it is picked (judged by its bytes, scanned, stored) and the
 * answer says whether it has the columns of the layout, so a person is told what the file lacks before the import; the import itself is a second step.
 * Also the notice of what the last import did, and the reason when the person may not import.
 */
function ImportPanel({ allowed, frozen, answer, onAnswer, onOpen }: PanelProps) {
  const { t, locale } = useTranslation();
  const upload = useUploadStatementFile();
  const importer = useImportStatement();
  const [form, setForm] = useState<ImportForm>(EMPTY_IMPORT_FORM);
  const [staged, setStaged] = useState<StagedFile | undefined>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [problem, setProblem] = useState<ProblemView | undefined>();
  const [pickerKey, setPickerKey] = useState(0);

  const changeDate = (value: string): void => {
    setForm((previous) => ({ ...previous, statementDate: value }));
    setErrors((previous) => ({ ...previous, statementDate: undefined }));
  };
  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0];
    setStaged(undefined);
    setProblem(undefined);
    setErrors((previous) => ({ ...previous, file: undefined }));
    if (picked === undefined) return;
    upload.mutate(picked, {
      onSuccess: (done) => (done === undefined ? setProblem({ reason: 'general', field: undefined }) : setStaged(done)),
      onError: (error) => setProblem(describeProblem(error)),
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (importer.isPending || upload.isPending || !allowed) return;
    const found = validateImport(form, staged);
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length > 0 || staged === undefined) return;
    importer.mutate(importBody(form, staged), {
      onSuccess: (raw) => {
        const done = toImportAnswer(raw);
        onAnswer(done);
        if (done === undefined) {
          setProblem({ reason: 'general', field: undefined });
          return;
        }
        setForm(EMPTY_IMPORT_FORM);
        setStaged(undefined);
        setPickerKey((current) => current + 1);
        onOpen(done.importId);
      },
      onError: (error) => setProblem(describeProblem(error)),
    });
  };
  const busy = importer.isPending || upload.isPending;

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('pay.import.form.title')} aria-busy={busy}>
      <h2>{t('pay.import.form.title')}</h2>
      {!allowed ? (
        <p className="callout" role="status" data-testid="read-only">
          {frozen ? t('pay.import.readOnly.frozen.notice') : t('pay.import.readOnly.denied.notice')}
        </p>
      ) : (
        <>
          <p className="sub">{t('pay.import.form.help')}</p>
          <div className="pay-form-grid">
            <FieldBox id="pay-file" label={t('pay.import.form.file.label')} hint={t('pay.import.form.file.hint')} error={errors.file === undefined ? undefined : fileErrorMessage(t, errors.file, staged?.missingColumns ?? [])}>
              <input key={pickerKey} id="pay-file" type="file" accept=".csv,.xlsx,text/csv" onChange={choose} />
            </FieldBox>
            <FieldBox id="pay-source-kind" label={t('pay.import.form.sourceKind.label')} error={undefined}>
              <select id="pay-source-kind" value={form.sourceKind} onChange={(event) => setForm((previous) => ({ ...previous, sourceKind: event.target.value as SourceKind }))}>
                {SOURCE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {sourceKindLabel(t, kind)}
                  </option>
                ))}
              </select>
            </FieldBox>
            <FieldBox id="pay-statement-date" label={t('pay.import.form.statementDate.label')} hint={t('pay.import.form.statementDate.hint')} error={errors.statementDate === undefined ? undefined : fieldErrorMessage(t, errors.statementDate)}>
              <input id="pay-statement-date" type="date" value={form.statementDate} onChange={(event) => changeDate(event.target.value)} />
            </FieldBox>
          </div>
          {upload.isPending ? (
            <p className="sub" role="status" data-testid="uploading">
              {t('pay.import.form.uploading.status')}
            </p>
          ) : null}
          {staged === undefined ? null : (
            <div className="callout" data-testid="staged">
              <p>
                <strong data-testid="staged-name">{staged.fileName}</strong> · {staged.format} · {t('pay.import.staged.rows.text', { count: staged.rowCount })} · {sizeText(staged.sizeBytes, locale)}
              </p>
              <p className="sub">
                {t('pay.import.summary.hash.label')}: <code data-testid="staged-hash">{staged.fileSha256}</code>
              </p>
              {staged.layoutOk ? (
                <p className="pay-badge" role="status" data-testid="layout-ok">
                  {t('pay.import.staged.layoutOk.text')}
                </p>
              ) : (
                <p className="pay-badge warning" role="alert" data-testid="layout-bad">
                  {t('pay.import.staged.layoutBad.text', { columns: missingText(t, staged.missingColumns) })}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {problemMessage(t, problem)}
        </p>
      )}
      {answer === undefined ? null : (
        <p className="callout" role="status" data-testid="answer">
          {answerMessage(t, answer.result, answer.counts)}
        </p>
      )}
      {allowed ? (
        <div className="formfooter">
          <button type="submit" className="button primary" disabled={busy}>
            {importer.isPending ? t('pay.import.form.submit.pending') : t('pay.import.form.submit.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}

/** The earlier imports of the tenant, the newest first; one opens the result of that import. */
function RecentImports({ items, current, onOpen }: { items: readonly ImportListItem[]; current: string | undefined; onOpen: (importId: string) => void }) {
  const { t, locale } = useTranslation();
  return (
    <div className="card" data-testid="recent">
      <h2>{t('pay.import.recent.title')}</h2>
      <ScrollRegion label={t('pay.import.recent.title')}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('pay.import.summary.file.label')}</th>
              <th scope="col">{t('pay.import.summary.importedAt.label')}</th>
              <th scope="col">{t('pay.import.summary.importedBy.label')}</th>
              <th scope="col">{t('pay.import.summary.status.label')}</th>
              <th scope="col">{t('pay.import.counts.new.label')}</th>
              <th scope="col">{t('pay.import.counts.duplicate.label')}</th>
              <th scope="col">{t('pay.import.counts.conflict.label')}</th>
              <th scope="col">{t('pay.import.counts.error.label')}</th>
              <th scope="col">
                <span className="pay-sr-only">{t('pay.import.recent.open.action')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} role="status" data-testid="recent-empty">
                  {t('pay.import.recent.empty')}
                </td>
              </tr>
            ) : null}
            {items.map((item) => (
              <tr key={item.id} data-testid="recent-row" data-import-id={item.id} aria-current={item.id === current ? 'true' : undefined}>
                <td>{item.fileName}</td>
                <td>{instantText(item.importedAt, locale)}</td>
                <td>{item.importedByName ?? item.importedBy}</td>
                <td>
                  <span className={item.status === 'APPLIED' ? 'pay-badge' : 'pay-badge warning'}>{importStatusLabel(t, item.status)}</span>
                </td>
                <td className="pay-amount">{item.counts.new}</td>
                <td className="pay-amount" data-testid="recent-duplicate">{item.counts.duplicate}</td>
                <td className="pay-amount" data-testid="recent-conflict">{item.counts.conflict}</td>
                <td className="pay-amount">{item.counts.error}</td>
                <td>
                  <button type="button" className="button" onClick={() => onOpen(item.id)} aria-label={t('pay.import.recent.open.label', { name: item.fileName })}>
                    {t('pay.import.recent.open.action')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}

function ImportResult({ view }: { view: ImportView }) {
  const { t, locale } = useTranslation();
  const quarantined = quarantinedRows(view);
  return (
    <>
      <div className="card" data-testid="summary">
        <h2>{t('pay.import.summary.title')}</h2>
        <dl className="pay-facts">
          <Fact label={t('pay.import.summary.file.label')}>{view.fileName}</Fact>
          <Fact label={t('pay.import.summary.hash.label')}>
            <code data-testid="file-hash">{view.fileSha256}</code>
          </Fact>
          <Fact label={t('pay.import.summary.sourceKind.label')}>{sourceKindLabel(t, view.sourceKind)}</Fact>
          <Fact label={t('pay.import.summary.statementDate.label')}>{view.statementDate ?? t('pay.import.summary.noDate.text')}</Fact>
          <Fact label={t('pay.import.summary.status.label')}>
            <span className={view.status === 'APPLIED' ? 'pay-badge' : 'pay-badge warning'} data-testid="status">
              {importStatusLabel(t, view.status)}
            </span>
          </Fact>
          <Fact label={t('pay.import.summary.importedBy.label')}>{view.importedByName ?? view.importedBy}</Fact>
          <Fact label={t('pay.import.summary.importedAt.label')}>{instantText(view.importedAt, locale)}</Fact>
        </dl>
        <dl className="pay-counts" data-testid="counts">
          <div>
            <dt>{t('pay.import.counts.total.label')}</dt>
            <dd data-testid="count-total">{view.counts.total}</dd>
          </div>
          <div>
            <dt>{t('pay.import.counts.new.label')}</dt>
            <dd data-testid="count-new">{view.counts.new}</dd>
          </div>
          <div>
            <dt>{t('pay.import.counts.duplicate.label')}</dt>
            <dd data-testid="count-duplicate">{view.counts.duplicate}</dd>
          </div>
          <div>
            <dt>{t('pay.import.counts.conflict.label')}</dt>
            <dd data-testid="count-conflict">{view.counts.conflict}</dd>
          </div>
          <div>
            <dt>{t('pay.import.counts.error.label')}</dt>
            <dd data-testid="count-error">{view.counts.error}</dd>
          </div>
        </dl>
      </div>
      <div className="card" data-testid="certified">
        <h2>{t('pay.import.certified.title')}</h2>
        <dl className="pay-facts">
          <Fact label={t('pay.import.certified.rows.label')}>
            <span data-testid="certified-rows">{view.certifiedRows}</span>
          </Fact>
          <Fact label={t('pay.import.certified.amount.label')}>
            <span className="pay-amount" data-testid="certified-amount">
              {amountText(view.certifiedAmountVnd, locale)} {t('pay.import.unit.vnd.text')}
            </span>
          </Fact>
          <Fact label={t('pay.import.certified.open.label')}>
            <span data-testid="certified-open">{view.openDifferences}</span>
          </Fact>
        </dl>
        <p className="sub">{t('pay.import.certified.note')}</p>
      </div>
      <Quarantine view={view} rows={quarantined} />
      <Differences view={view} />
      <Lines view={view} />
    </>
  );
}

function maskedSummary(t: ReturnType<typeof useTranslation>['t'], row: RowView): string {
  return MASKED_FIELDS.flatMap((field) => {
    const value = row.masked[field];
    return value === undefined || value === '' ? [] : [`${fieldLabel(t, field)}: ${value}`];
  }).join(' · ');
}

function Quarantine({ view, rows }: { view: ImportView; rows: readonly RowView[] }) {
  const { t, locale } = useTranslation();
  return (
    <div className="card" data-testid="quarantine">
      <h2>{t('pay.import.quarantine.title')}</h2>
      <p className="sub">{t('pay.import.quarantine.intro')}</p>
      {rows.length === 0 ? (
        <p className="callout" role="status" data-testid="quarantine-empty">
          {t('pay.import.quarantine.empty')}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('pay.import.column.line')}</th>
              <th scope="col">{t('pay.import.column.key')}</th>
              <th scope="col">{t('pay.import.column.reason')}</th>
              <th scope="col">{t('pay.import.column.content')}</th>
              <th scope="col">{t('pay.import.column.owner')}</th>
              <th scope="col">{t('pay.import.column.due')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const owner = ownerOfRow(view, row);
              const item = view.differences.find((candidate) => candidate.businessKey === row.businessKey);
              return (
                <tr key={row.rowNo} data-testid="quarantine-row">
                  <td>{row.rowNo}</td>
                  <td>
                    <span className="pay-key">{row.businessKey}</span>
                  </td>
                  <td>
                    {rowErrorLabel(t, row.errorCode)}
                    <br />
                    <span className="sub">{row.errorCode}</span>
                  </td>
                  <td>
                    <span className="sub" data-testid="masked">
                      {maskedSummary(t, row)}
                    </span>
                  </td>
                  <td>{owner.name ?? owner.id}</td>
                  <td>{item === undefined ? '' : instantText(item.dueAt, locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Differences({ view }: { view: ImportView }) {
  const { t, locale } = useTranslation();
  return (
    <div className="card" data-testid="differences">
      <h2>{t('pay.import.differences.title')}</h2>
      {view.differences.length === 0 ? (
        <p className="callout" role="status" data-testid="differences-empty">
          {t('pay.import.differences.empty')}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('pay.import.column.difference')}</th>
              <th scope="col">{t('pay.import.column.key')}</th>
              <th scope="col">{t('pay.import.column.expected')}</th>
              <th scope="col">{t('pay.import.column.actual')}</th>
              <th scope="col">{t('pay.import.column.gap')}</th>
              <th scope="col">{t('pay.import.column.owner')}</th>
              <th scope="col">{t('pay.import.column.due')}</th>
              <th scope="col">{t('pay.import.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {view.differences.map((item) => (
              <tr key={item.id} data-testid="difference-row">
                <td>{differenceLabel(t, item.code)}</td>
                <td>
                  <span className="pay-key">{item.businessKey}</span>
                </td>
                <td className="pay-amount">{item.expected === null ? '' : amountText(item.expected, locale)}</td>
                <td className="pay-amount">{item.actual === null ? '' : amountText(item.actual, locale)}</td>
                <td className="pay-amount">{item.difference === null ? '' : signedAmountText(item.difference, locale)}</td>
                <td>{item.ownerName ?? item.ownerMembershipId}</td>
                <td>{instantText(item.dueAt, locale)}</td>
                <td>{itemStatusLabel(t, item.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Lines({ view }: { view: ImportView }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="lines">
      <h2>{t('pay.import.lines.title')}</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('pay.import.column.line')}</th>
            <th scope="col">{t('pay.import.column.key')}</th>
            <th scope="col">{t('pay.import.column.outcome')}</th>
            <th scope="col">{t('pay.import.column.reason')}</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.rowNo} data-testid="line-row" data-outcome={row.outcome}>
              <td>{row.rowNo}</td>
              <td>
                <span className="pay-key">{row.businessKey}</span>
              </td>
              <td>
                <span className={row.outcome === 'NEW' || row.outcome === 'DUPLICATE' ? 'pay-badge' : 'pay-badge warning'}>{outcomeLabel(t, row.outcome)}</span>
              </td>
              <td>{row.errorCode === null ? '' : rowErrorLabel(t, row.errorCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.rowsTruncated ? (
        <p className="sub" data-testid="lines-truncated">
          {t('pay.import.lines.truncated.notice', { shown: view.rows.length, total: view.counts.total })}
        </p>
      ) : null}
    </div>
  );
}

