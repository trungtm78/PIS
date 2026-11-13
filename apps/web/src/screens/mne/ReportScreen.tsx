import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmationLabel, Field } from './components';
import { ReportCreateForm } from './ReportCreateForm';
import { mayCreate } from './report-create-model';
import { useEditReport, useObligations, useReport, useSubmitReport } from './hooks';
import { reportProblemMessage, reportStatusLabel, sourceLabel } from './labels';
import { describeReportProblem, draftsOf, drillPath, isEditable, missingCells, narrativeChanges, shown } from './report-model';
import type { Drafts } from './report-model';
import { vietnamToday, yearsAround } from './model';
import type { ReportField, ReportView } from './types';
import { StatusPill } from '../../ui';
import { reportStatusTone } from './tones';
import './mne.css';
import './mne-kit.css';
import { ScrollRegion } from '../scroll-region';

type Done = 'saved' | 'submitted';

/** MNE-03: the periodic overall report: its snapshot, the locked cells filled from their source, the narrative written by the preparer, and the hand-in for review. */
export default function ReportScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ReportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') ?? '';
  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.report.page.title')}</h1>
          <p>{t('mne.report.page.subtitle')}</p>
        </div>
        {reportId === '' ? null : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setParams({})}>
            {t('mne.report.back')}
          </button>
        )}
      </div>
      {reportId === '' ? <ReportPicker onOpen={(id) => setParams({ report: id })} /> : <ReportEditor id={reportId} />}
    </section>
  );
}

/** The reports of the year that are still drafts, from the filing calendar: where a report is opened from. */
function ReportPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [creating, setCreating] = useState(false);
  const today = vietnamToday();
  // The reports of a year are filed in the next one: the year is the person's to choose.
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useObligations({ year, status: 'DRAFT' });
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items });
  if (creating) {
    return (
      <ReportCreateForm
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          if (id !== '') onOpen(id);
        }}
      />
    );
  }
  return (
    <div className="card">
      <h2>{t('mne.report.picker.title')}</h2>
      <p className="sub">{t('mne.report.picker.help')}</p>
      {mayCreate(permissions, mode === 'READ_ONLY') ? (
        <div className="mne-actions">
          <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setCreating(true)} data-testid="create-open">
            {t('mne.create.open')}
          </button>
        </div>
      ) : null}
      <div className="mne-filters">
        <Field id="report-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
          <select id="report-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {yearsAround(today, [year]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ScrollRegion label={t('mne.report.picker.title')}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('mne.report.picker.column.period')}</th>
                <th scope="col">{t('mne.report.picker.column.unit')}</th>
                <th scope="col">{t('scr2.mne.report.column.scope')}</th>
                <th scope="col">{t('mne.report.picker.column.form')}</th>
                <th scope="col">{t('scr2.mne.report.column.snapshot')}</th>
                <th scope="col">{t('scr2.mne.report.column.auto')}</th>
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
                  <ReportFacts reportId={item.reportId}>
                    <td>
                      {item.formCode} <span className="sub">{item.formTitle}</span>
                    </td>
                  </ReportFacts>
                  <td>{item.dueDate}</td>
                  <td>{reportStatusLabel(t, item.status)}</td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(item.reportId)}>
                      {t('mne.report.picker.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
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

/**
 * The scope, the snapshot and the share of the cells filled from their source of one draft, read from the report itself: the scope (a unit or one project), the frozen snapshot the
 * figures come from (none yet until one is attached) and how many cells are locked to their source. The form of the report sits between, in the order of the catalogue.
 */
function ReportFacts({ reportId, children }: { reportId: string; children: ReactNode }) {
  const { t } = useTranslation();
  const report = useReport(reportId);
  const none = report.isLoading ? t('scr2.mne.report.reading') : t('scr2.mne.report.unread');
  const data = report.data;
  const locked = data?.fields.filter((field) => field.locked).length ?? 0;
  return (
    <>
      <td data-testid="report-scope">{data === undefined ? none : data.projectId === null ? t('scr2.mne.report.scope.unit', { unit: data.unitName }) : t('scr2.mne.report.scope.project')}</td>
      {children}
      <td data-testid="report-snapshot-date">{data === undefined ? none : data.asOfDate === null ? t('mne.report.header.noSnapshot') : t('mne.report.header.snapshot', { date: data.asOfDate })}</td>
      <td data-testid="report-auto">{data === undefined ? none : t('scr2.mne.report.auto.value', { locked, total: data.fields.length })}</td>
    </>
  );
}

/** What the person asked to write: the cells that changed and the snapshot they chose, if any. */
interface Draft {
  changes: Record<string, string | null>;
  snapshotId: string;
}

/** The report of an id with its cells, the snapshot and the hand-in; MNE-04 opens the same body for a report of a project. */
export function ReportEditor({ id }: { id: string }) {
  const query = useReport(id);
  const edit = useEditReport();
  const submit = useSubmitReport();
  const [done, setDone] = useState<Done | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  const input = (report: ReportView, draft: Draft) => ({ id: report.id, version: report.version, narrative: draft.changes, ...(draft.snapshotId === '' ? {} : { snapshotId: draft.snapshotId }) });
  // The mutations live here, not in the body: saving moves the version, which starts the body over, and a hand-in that follows a save must go on being seen.
  const actions: Actions = {
    busy: edit.isPending || submit.isPending,
    failure: edit.isError ? edit.error : submit.isError ? submit.error : undefined,
    save: (report, draft) => {
      setDone(undefined);
      submit.reset();
      edit.mutate(input(report, draft), { onSuccess: () => setDone('saved') });
    },
    handIn: async (report, draft, dirty) => {
      setDone(undefined);
      submit.reset();
      try {
        const saved = dirty ? await edit.mutateAsync(input(report, draft)) : undefined;
        await submit.mutateAsync({ id: report.id, version: saved?.version ?? report.version });
        setDone('submitted');
      } catch {
        // The failure is on the mutation that raised it, and the screen says why below.
      }
    },
  };
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {query.data === undefined ? null : <ReportBody key={`${query.data.id}:${query.data.version}`} report={query.data} done={done} actions={actions} />}
    </StateBoundary>
  );
}

interface Actions {
  busy: boolean;
  failure: Error | undefined;
  save: (report: ReportView, draft: Draft) => void;
  handIn: (report: ReportView, draft: Draft, dirty: boolean) => Promise<void>;
}

interface BodyProps {
  report: ReportView;
  done: Done | undefined;
  actions: Actions;
}

function ReportBody({ report, done, actions }: BodyProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozenMode = mode === 'READ_ONLY';
  const editable = isEditable(report, permissions, frozenMode);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(report));
  const [snapshotId, setSnapshotId] = useState('');
  const changes = narrativeChanges(report, drafts);
  const dirty = Object.keys(changes).length > 0 || snapshotId !== '';
  const hasSnapshot = report.snapshotId !== null || snapshotId !== '';
  const missing = missingCells(report, drafts);
  const labelOf = (key: string): string => report.fields.find((field) => field.key === key)?.label ?? key;
  const problem = actions.failure === undefined ? undefined : describeReportProblem(actions.failure);
  const busy = actions.busy;
  const draft: Draft = { changes, snapshotId };

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
      <p data-testid="report-snapshot">{report.asOfDate === null ? t('mne.report.header.noSnapshot') : t('mne.report.header.snapshot', { date: report.asOfDate })}</p>
      {report.watermarkText === null ? null : <p className="callout">{report.watermarkText}</p>}
      {editable ? null : (
        <p className="callout warning" role="status" data-testid="report-readonly">
          {report.status !== 'DRAFT' ? t('mne.report.notice.locked') : frozenMode ? t('mne.report.notice.frozen') : t('mne.report.notice.noRight')}
        </p>
      )}
      {editable ? (
        <Field id="report-snapshot-choice" label={t('mne.report.snapshot.label')} error={undefined} hint={t('mne.report.snapshot.hint')}>
          <select id="report-snapshot-choice" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>
            <option value="">{t('mne.report.snapshot.none')}</option>
            {report.snapshotOptions.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {t('mne.report.snapshot.option', { date: snapshot.asOfDate })}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {editable && report.snapshotOptions.length === 0 ? (
        <p className="sub" data-testid="snapshot-none">
          {t('mne.report.snapshot.noneFrozen')}
        </p>
      ) : null}
      {report.fields.length === 0 ? (
        <p className="sub" data-testid="report-no-fields">
          {t('mne.report.empty.shell')}
        </p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('mne.report.column.field')}</th>
                <th scope="col">{t('mne.report.column.value')}</th>
                <th scope="col">{t('mne.report.column.source')}</th>
              </tr>
            </thead>
            <tbody>
              {report.fields.map((field) => (
                <FieldRow key={field.key} report={report} field={field} editable={editable} draft={drafts[field.key] ?? ''} onDraft={(value) => setDrafts({ ...drafts, [field.key]: value })} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="report-done">
          {done === 'saved' ? t('mne.report.saved') : t('mne.report.submitted')}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="report-problem">
          {reportProblemMessage(t, problem, labelOf)}
        </p>
      )}
      {editable ? (
        <>
          {hasSnapshot ? null : (
            <p className="sub" data-testid="report-need-snapshot">
              {t('mne.report.notice.needSnapshot')}
            </p>
          )}
          {missing.length === 0 || !hasSnapshot ? null : (
            <p className="sub" data-testid="report-missing">
              {t('mne.report.notice.missing', { fields: missing.map(labelOf).join(', ') })}
            </p>
          )}
          <div className="mne-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={busy || !dirty} onClick={() => actions.save(report, draft)}>
              {busy ? t('mne.report.action.working') : t('mne.report.action.save')}
            </button>
            <button type="button" className="ui-button ui-button--primary" disabled={busy || !hasSnapshot || missing.length > 0} onClick={() => void actions.handIn(report, draft, dirty)}>
              {t('mne.report.action.submit')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface RowProps {
  report: ReportView;
  field: ReportField;
  editable: boolean;
  draft: string;
  onDraft: (value: string) => void;
}

function FieldRow({ report, field, editable, draft, onDraft }: RowProps) {
  const { t } = useTranslation();
  const value = shown(field);
  const drill = drillPath(report, field);
  const id = `cell-${field.key}`;
  return (
    <tr data-field={field.key} data-locked={field.locked ? 'true' : 'false'}>
      <th scope="row">
        <label htmlFor={field.locked || !editable ? undefined : id}>{field.label}</label>
        {field.required ? <span className="sub"> {t('mne.report.field.required')}</span> : null}
      </th>
      <td>
        {field.locked ? (
          <span data-testid={`value-${field.key}`}>{value ?? t('mne.report.field.empty')}</span>
        ) : editable ? (
          <textarea id={id} rows={3} value={draft} onChange={(event) => onDraft(event.target.value)} />
        ) : (
          <span data-testid={`value-${field.key}`}>{value ?? t('mne.report.field.empty')}</span>
        )}
      </td>
      <td>
        {field.source === null ? (
          <span className="sub">{t('mne.report.field.written')}</span>
        ) : (
          <>
            <span data-testid={`locked-${field.key}`}>
              <StatusPill tone="neutral">{t('mne.report.field.locked')}</StatusPill>
            </span>{' '}
            {drill === undefined ? (
              <span className="sub">{sourceLabel(t, field.source)}</span>
            ) : (
              <Link to={drill} aria-label={t('mne.report.source.drill', { label: field.label })}>
                {sourceLabel(t, field.source)}
              </Link>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
