import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { linkOf } from '../dis/export/model';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmationLabel, Field } from './components';
import { useGenerateExport, useObligations, useRecordReceipt, useReport } from './hooks';
import { adapterLabel, formatLabel, packageStatusLabel, reportProblemMessage, reportStatusLabel, targetLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { canFile, describeReportProblem, instantOf, mayExport, shortHash } from './report-model';
import { EXPORT_TARGETS, PACKAGE_FORMATS } from './types';
import type { ExportTarget, PackageFormat, PackageView, ReportStatus, ReportView } from './types';
import { StatusPill } from '../../ui';
import { reportStatusTone } from './tones';
import './mne.css';
import './mne-kit.css';

type Done = 'generated' | 'filed';
/** How long after a click on a download the packages are read again: the file is served, and the package it came from has moved. */
const DOWNLOAD_REFRESH_MS = 1500;
/** A link that has this little time left is not followed: it would run out on the way. */
const LINK_MARGIN_MS = 10_000;

/** The reports that have been issued by DOC: the ones whose files can be made, the ones that have files, and the ones that were filed. */
const EXPORT_STATUSES: readonly ReportStatus[] = ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL'];

/** MNE-06: the files of an issued report for each recipient, with the label of how far the way to it goes, the download, and the receipt of the filing written down by hand. */
export default function PackagesScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <PackagesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PackagesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') ?? '';
  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.export.page.title')}</h1>
          <p>{t('mne.export.page.subtitle')}</p>
        </div>
        {reportId === '' ? null : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setParams({})}>
            {t('mne.export.back')}
          </button>
        )}
      </div>
      {reportId === '' ? <IssuedPicker onOpen={(id) => setParams({ report: id })} /> : <PackagesEditor id={reportId} />}
    </section>
  );
}

function IssuedPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useObligations({ year, status: '' });
  const items = useMemo(() => (list.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => EXPORT_STATUSES.includes(item.status)), [list.data]);
  // A page that holds nothing to export is not the end of the list: the next one is read until there is something to show or nothing more to read.
  const searching = items.length === 0 && list.hasNextPage === true;
  useEffect(() => {
    if (searching && !list.isFetchingNextPage && list.error === null) void list.fetchNextPage();
  }, [searching, list.isFetchingNextPage, list.error, list]);
  const state = useScreenState({ isLoading: list.isLoading || searching, error: list.error, data: list.data === undefined ? undefined : items });
  return (
    <div className="card">
      <h2>{t('mne.export.picker.title')}</h2>
      <p className="sub">{t('mne.export.picker.help')}</p>
      <div className="mne-filters">
        <Field id="export-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
          <select id="export-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {yearsAround(today, [year]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('mne.report.picker.column.period')}</th>
                <th scope="col">{t('mne.report.picker.column.unit')}</th>
                <th scope="col">{t('mne.report.picker.column.form')}</th>
                <th scope="col">{t('mne.report.picker.column.due')}</th>
                <th scope="col">{t('mne.report.picker.column.status')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.reportId} data-report-id={item.reportId}>
                  <td>{item.periodLabel}</td>
                  <td>
                    {item.unitCode} <span className="sub">{item.unitName}</span>
                  </td>
                  <td>
                    {item.formCode} <span className="sub">{item.formTitle}</span>
                  </td>
                  <td>{item.dueDate}</td>
                  <td>{reportStatusLabel(t, item.status)}</td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(item.reportId)}>
                      {t('mne.export.picker.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage ? (
          <div className="mne-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('mne.calendar.more.action')}
            </button>
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}

interface Actions {
  busy: boolean;
  failure: Error | undefined;
  generate: (report: ReportView, target: ExportTarget, formats: readonly PackageFormat[]) => void;
  file: (item: PackageView, reference: string, submittedAt: string) => void;
  /** The file was asked for: serving it moves the package, so the read is made again a moment later. */
  downloaded: (event: MouseEvent<HTMLAnchorElement>, item: PackageView) => void;
}

function PackagesEditor({ id }: { id: string }) {
  const query = useReport(id, { links: true });
  const generate = useGenerateExport();
  const record = useRecordReceipt();
  const [done, setDone] = useState<Done | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  // The mutations live here, not in the body: a command moves the version, which starts the body over, and its answer must go on being seen.
  const actions: Actions = {
    busy: generate.isPending || record.isPending,
    failure: generate.isError ? generate.error : record.isError ? record.error : undefined,
    generate: (report, target, formats) => {
      setDone(undefined);
      record.reset();
      generate.mutate({ reportId: report.id, version: report.version, target, formats }, { onSuccess: () => setDone('generated') });
    },
    downloaded: (event, item) => {
      // A link that has run out serves nothing (401): the packages are read again and the new link is the one to follow.
      if (item.downloadExpiresAt !== null && Date.parse(item.downloadExpiresAt) <= Date.now() + LINK_MARGIN_MS) {
        event.preventDefault();
        void query.refetch();
        return;
      }
      window.setTimeout(() => void query.refetch(), DOWNLOAD_REFRESH_MS);
    },
    file: (item, reference, submittedAt) => {
      setDone(undefined);
      generate.reset();
      record.mutate({ packageId: item.id, version: item.version, reference, submittedAt }, { onSuccess: () => setDone('filed') });
    },
  };
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {query.data === undefined ? null : <PackagesBody key={`${query.data.id}:${query.data.version}:${query.data.packages.map((item) => `${item.id}.${item.version}`).join(',')}`} report={query.data} done={done} actions={actions} />}
    </StateBoundary>
  );
}

function PackagesBody({ report, done, actions }: { report: ReportView; done: Done | undefined; actions: Actions }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const allowed = mayExport(report, permissions, frozen);
  const [target, setTarget] = useState<ExportTarget>('NATIONAL_PIM_SYSTEM');
  const [formats, setFormats] = useState<readonly PackageFormat[]>(['XLSX']);
  const [noFormat, setNoFormat] = useState(false);
  const problem = actions.failure === undefined ? undefined : describeReportProblem(actions.failure);
  const issued = report.status === 'ISSUED' || report.status === 'EXPORTED' || report.status === 'SUBMITTED_EXTERNAL';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (formats.length === 0) {
      setNoFormat(true);
      return;
    }
    setNoFormat(false);
    actions.generate(report, target, formats);
  };
  const toggle = (format: PackageFormat): void => setFormats(formats.includes(format) ? formats.filter((item) => item !== format) : [...formats, format]);

  return (
    <div className="card" data-report-status={report.status}>
      <div className="mne-badges">
        <strong>{report.formTitle}</strong>
        <span data-testid="report-status">
          <StatusPill tone={reportStatusTone(report.status)}>{reportStatusLabel(t, report.status)}</StatusPill>
        </span>
        <ConfirmationLabel awaiting={report.awaitingConfirmation} cxnRefs={report.cxnRefs} />
      </div>
      <p className="sub">{t('mne.report.header.form', { code: report.formCode, revision: report.formRevision })}</p>
      <p className="sub">{t('mne.report.header.unit', { unit: `${report.unitCode} ${report.unitName}` })}</p>
      <p className="sub">{t('mne.report.header.period', { period: report.periodLabel, due: report.dueDate })}</p>
      {report.isLate && report.status === 'SUBMITTED_EXTERNAL' ? (
        <p className="callout warning" role="status" data-testid="filed-late">
          {t('mne.export.late.text', { due: report.dueDate })}
        </p>
      ) : null}
      {!issued ? (
        <p className="callout warning" role="status" data-testid="export-readonly">
          {t('mne.export.notice.notIssued')}
        </p>
      ) : !allowed ? (
        <p className="callout warning" role="status" data-testid="export-readonly">
          {frozen ? t('mne.export.notice.frozen') : t('mne.export.notice.readonly')}
        </p>
      ) : null}

      {allowed ? (
        <form onSubmit={submit} noValidate aria-label={t('mne.export.generate.title')}>
          <h2>{t('mne.export.generate.title')}</h2>
          <Field id="export-target" label={t('mne.export.generate.target.label')} error={undefined}>
            <select id="export-target" value={target} onChange={(event) => setTarget(event.target.value as ExportTarget)}>
              {EXPORT_TARGETS.map((option) => (
                <option key={option} value={option}>
                  {targetLabel(t, option)}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend>{t('mne.export.generate.formats.label')}</legend>
            {PACKAGE_FORMATS.map((format) => (
              <label key={format} className="mne-formats">
                <input type="checkbox" checked={formats.includes(format)} onChange={() => toggle(format)} /> {formatLabel(t, format)}
              </label>
            ))}
            <small className="sub">{t('mne.export.generate.formats.hint')}</small>
            {noFormat ? (
              <small role="alert" className="field-error">
                {t('mne.export.generate.none')}
              </small>
            ) : null}
          </fieldset>
          <div className="mne-actions">
            <button type="submit" className="ui-button ui-button--primary" disabled={actions.busy}>
              {t('mne.export.generate.action')}
            </button>
          </div>
        </form>
      ) : null}

      <h2>{t('mne.export.packages.title')}</h2>
      {report.packages.length === 0 ? (
        <p className="sub" data-testid="packages-empty">
          {t('mne.export.packages.empty')}
        </p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('mne.export.column.format')}</th>
                <th scope="col">{t('mne.export.column.target')}</th>
                <th scope="col">{t('mne.export.column.hash')}</th>
                <th scope="col">{t('mne.export.column.status')}</th>
                <th scope="col">{t('mne.export.column.adapter')}</th>
                <th scope="col">{t('mne.export.column.file')}</th>
                <th scope="col">{t('mne.export.column.receipt')}</th>
              </tr>
            </thead>
            <tbody>
              {report.packages.map((item) => (
                <PackageRow key={item.id} item={item} allowed={allowed} busy={actions.busy} onFile={actions.file} onDownload={actions.downloaded} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="export-done">
          {done === 'generated' ? t('mne.export.generate.done') : t('mne.export.receipt.done')}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="report-problem">
          {reportProblemMessage(t, problem, (key) => key)}
        </p>
      )}
    </div>
  );
}

function PackageRow({ item, allowed, busy, onFile, onDownload }: { item: PackageView; allowed: boolean; busy: boolean; onFile: Actions['file']; onDownload: Actions['downloaded'] }) {
  const { t } = useTranslation();
  const [reference, setReference] = useState('');
  const [filedAt, setFiledAt] = useState('');
  const [problem, setProblem] = useState<'reference' | 'date' | undefined>(undefined);
  const record = (event: FormEvent): void => {
    event.preventDefault();
    if (reference.trim().length < 3) {
      setProblem('reference');
      return;
    }
    const at = instantOf(filedAt);
    if (at === undefined) {
      setProblem('date');
      return;
    }
    setProblem(undefined);
    onFile(item, reference.trim(), at);
  };
  return (
    <>
      <tr data-package-id={item.id} data-status={item.status}>
        <td>{formatLabel(t, item.format)}</td>
        <td>{targetLabel(t, item.target)}</td>
        <td title={item.fileSha256}>
          <code data-testid={`hash-${item.id}`}>{shortHash(item.fileSha256)}</code>
        </td>
        <td>{packageStatusLabel(t, item.status)}</td>
        <td>
          <span data-testid={`adapter-${item.id}`}>
            <StatusPill tone="warning">{adapterLabel(t, item.adapterStatus)}</StatusPill>
          </span>
        </td>
        <td>
          {item.downloadUrl === null ? (
            <span className="sub">{t('mne.export.download.none')}</span>
          ) : (
            <a href={linkOf(item.downloadUrl, import.meta.env.VITE_API_BASE_URL ?? '')} download onClick={(event) => onDownload(event, item)}>
              {t('mne.export.download.action')}
            </a>
          )}
        </td>
        <td>
          {item.receipt === null ? null : (
            <span data-testid={`receipt-${item.id}`}>{t('mne.export.receipt.shown', { reference: item.receipt.reference, at: item.receipt.submittedAt ?? '' })}</span>
          )}
        </td>
      </tr>
      {allowed && canFile(item) ? (
        <tr data-receipt-for={item.id}>
          <td colSpan={7}>
            <form onSubmit={record} noValidate aria-label={`${t('mne.export.receipt.title')} ${shortHash(item.fileSha256)}`}>
              <h3>{t('mne.export.receipt.title')}</h3>
              <Field id={`reference-${item.id}`} label={t('mne.export.receipt.reference.label')} error={problem === 'reference' ? t('mne.export.receipt.required') : undefined} hint={t('mne.export.receipt.reference.hint')}>
                <input id={`reference-${item.id}`} type="text" value={reference} onChange={(event) => setReference(event.target.value)} />
              </Field>
              <Field id={`filed-${item.id}`} label={t('mne.export.receipt.submittedAt.label')} error={problem === 'date' ? t('mne.export.receipt.date') : undefined}>
                <input id={`filed-${item.id}`} type="datetime-local" value={filedAt} onChange={(event) => setFiledAt(event.target.value)} />
              </Field>
              <div className="mne-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={busy}>
                  {t('mne.export.receipt.action')}
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}
