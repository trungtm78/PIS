import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { linkOf } from '../dis/export/model';
import { Field } from './components';
import { useMemberNames, useRevision } from './history-hooks';
import { changedCount, defaultAgainst, diffCells, hasOthers, historicObligations } from './history-model';
import type { Change, HistoryEntry, Revision } from './history-model';
import { useObligations } from './hooks';
import { formatLabel, reportStatusLabel, targetLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { shortHash } from './report-model';
import { READ_PERMISSION } from './types';
import type { Translator } from '../../i18n';
import './mne.css';
import './mne-kit.css';
import { StatusPill } from '../../ui';
import { CorrectionPanel } from './CorrectionPanel';

type T = Translator['t'];
const MEMBER_READ_PERMISSION = 'membership.read';
const SHORT_ID = 8;
const NONE = '—';

const changeLabel = (t: T, change: Change): string => {
  switch (change) {
    case 'same':
      return t('mne.history.change.same');
    case 'changed':
      return t('mne.history.change.changed');
    case 'added':
      return t('mne.history.change.added');
    case 'removed':
      return t('mne.history.change.removed');
  }
};

/**
 * MNE-10: the revisions of a report and what a correction changed (ST-MNE-010, MNE F8): the history with the reason of each correction, two revisions side by side cell by cell, who approved each and the files of each, which
 * stay downloadable after the revision is replaced. Nothing is written here: a report that was issued is not changed, a correction makes a new revision, and the revision it replaces is kept as it was issued.
 */
export default function ReportHistoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <HistoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HistoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') ?? '';
  const readable = permissions === undefined || permissions.includes(READ_PERMISSION);
  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.history.page.title')}</h1>
          <p>{t('mne.history.page.subtitle')}</p>
        </div>
        {reportId === '' || !readable ? null : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setParams({})}>
            {t('mne.history.back.action')}
          </button>
        )}
      </div>
      <p className="callout" role="note" data-testid="immutable">
        {t('mne.history.immutable.notice')}
      </p>
      {!readable ? (
        <StateBoundary state="denied" />
      ) : reportId === '' ? (
        <HistoryPicker onOpen={(id) => setParams({ report: id })} />
      ) : (
        <HistoryView id={reportId} against={params.get('against') ?? undefined} onOpen={(id) => setParams({ report: id })} onCompare={(id) => setParams({ report: reportId, against: id })} />
      )}
    </section>
  );
}

/** The reports of a year that were issued at least once: where a history is opened from. */
function HistoryPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useObligations({ year, status: '' });
  const rows = useMemo(() => historicObligations(list.data?.pages.flatMap((page) => page.items) ?? []), [list.data]);
  // A page with none of the reports wanted is not the end of the list: the next page is read until one is found or there is none.
  const searching = rows.length === 0 && list.hasNextPage === true && list.error === null;
  const { fetchNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (searching && !isFetchingNextPage) void fetchNextPage();
  }, [searching, isFetchingNextPage, fetchNextPage]);
  const state = useScreenState({ isLoading: list.isLoading || searching, error: list.error, data: list.data === undefined ? undefined : rows });
  return (
    <div className="card">
      <h2>{t('mne.history.picker.title')}</h2>
      <p className="sub">{t('mne.history.picker.help')}</p>
      <div className="mne-filters">
        <Field id="history-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
          <select id="history-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
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
          <table aria-label={t('mne.history.picker.aria')} data-testid="issued-reports">
            <thead>
              <tr>
                <th scope="col">{t('mne.history.picker.column.form')}</th>
                <th scope="col">{t('mne.history.picker.column.period')}</th>
                <th scope="col">{t('mne.history.picker.column.unit')}</th>
                <th scope="col">{t('mne.history.picker.column.status')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.reportId} data-report-id={item.reportId}>
                  <td>
                    {item.formCode} <span className="sub">{item.formTitle}</span>
                  </td>
                  <td>{item.periodLabel}</td>
                  <td>
                    {item.unitCode} <span className="sub">{item.unitName}</span>
                  </td>
                  <td>{reportStatusLabel(t, item.status)}</td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(item.reportId)}>
                      {t('mne.history.picker.open', { period: item.periodLabel })}
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

interface ViewProps {
  id: string;
  against: string | undefined;
  onOpen: (id: string) => void;
  onCompare: (id: string) => void;
}

function HistoryView({ id, against, onOpen, onCompare }: ViewProps) {
  const query = useRevision(id);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: () => false });
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {query.data === undefined ? null : <HistoryBody revision={query.data} againstId={against ?? defaultAgainst(query.data)} onOpen={onOpen} onCompare={onCompare} />}
    </StateBoundary>
  );
}

interface BodyProps {
  revision: Revision;
  againstId: string | undefined;
  onOpen: (id: string) => void;
  onCompare: (id: string) => void;
}

function HistoryBody({ revision, againstId, onOpen, onCompare }: BodyProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const names = useMemberNames(permissions === undefined || permissions.includes(MEMBER_READ_PERMISSION));
  const id = revision.report.id;
  return (
    <>
      <div className="card" data-testid="history">
        <h2>{t('mne.history.table.title', { form: revision.report.formTitle, period: revision.report.periodLabel })}</h2>
        <div className="tablewrap">
          <table aria-label={t('mne.history.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('mne.history.column.revision')}</th>
                <th scope="col">{t('mne.history.column.status')}</th>
                <th scope="col">{t('mne.history.column.reason')}</th>
                <th scope="col">{t('mne.history.column.issued')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {revision.history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} opened={entry.id === id} against={entry.id === againstId} onOpen={onOpen} onCompare={onCompare} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {revision.history.find((entry) => entry.id === id)?.current === true ? <CorrectionPanel report={revision.report} onCorrected={(newId) => (newId === '' ? undefined : onOpen(newId))} /> : null}
      {againstId === undefined ? (
        <>
          <p className="callout" role="status" data-testid="compare-none">
            {hasOthers(revision.history, id) ? t('mne.history.compare.choose.notice') : t('mne.history.compare.only.notice')}
          </p>
          <RevisionCard revision={revision} names={names.data} />
        </>
      ) : (
        <ComparePanel opened={revision} againstId={againstId} names={names.data} />
      )}
    </>
  );
}

interface RowProps {
  entry: HistoryEntry;
  opened: boolean;
  against: boolean;
  onOpen: (id: string) => void;
  onCompare: (id: string) => void;
}

function HistoryRow({ entry, opened, against, onOpen, onCompare }: RowProps) {
  const { t } = useTranslation();
  return (
    <tr data-revision-id={entry.id} data-revision={entry.revision} data-opened={opened} data-against={against}>
      <th scope="row">
        {t('mne.history.revision.title', { revision: entry.revision })}
        {opened ? <StatusPill tone="info">{t('mne.history.revision.opened')}</StatusPill> : null}
        {against ? <StatusPill tone="neutral">{t('mne.history.revision.against')}</StatusPill> : null}
      </th>
      <td>{reportStatusLabel(t, entry.status)}</td>
      <td>{entry.correctionReason ?? <span className="sub">{t('mne.history.reason.none')}</span>}</td>
      <td>{entry.issuedAt ?? NONE}</td>
      <td>
        {opened ? null : (
          <>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onCompare(entry.id)}>
              {t('mne.history.compare.action', { revision: entry.revision })}
            </button>{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(entry.id)}>
              {t('mne.history.open.action', { revision: entry.revision })}
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

interface CompareProps {
  opened: Revision;
  againstId: string;
  names: ReadonlyMap<string, string> | undefined;
}

/** Two revisions side by side: who approved each and the files of each, then the cells with what changed said in words. */
function ComparePanel({ opened, againstId, names }: CompareProps) {
  const other = useRevision(againstId);
  const state = useScreenState({ isLoading: other.isLoading, error: other.error, data: other.data, isEmpty: () => false });
  return (
    <div className="card" data-testid="compare">
      <StateBoundary state={state} onRetry={() => void other.refetch()}>
        {other.data === undefined ? null : <Compared pair={[other.data, opened].sort((a, b) => a.report.revision - b.report.revision) as [Revision, Revision]} names={names} />}
      </StateBoundary>
    </div>
  );
}

function Compared({ pair, names }: { pair: [Revision, Revision]; names: ReadonlyMap<string, string> | undefined }) {
  const { t } = useTranslation();
  const [before, after] = pair;
  const rows = diffCells(before.report, after.report);
  const changed = changedCount(rows);
  return (
    <>
      <h2>{t('mne.history.compare.title', { from: before.report.revision, to: after.report.revision })}</h2>
      <div className="mne-filters">
        <RevisionCard revision={before} names={names} />
        <RevisionCard revision={after} names={names} />
      </div>
      <p data-testid="compare-summary">{changed === 0 ? t('mne.history.compare.same.notice') : t('mne.history.compare.summary', { count: changed, total: rows.length })}</p>
      <div className="tablewrap">
        <table aria-label={t('mne.history.compare.aria')} data-testid="diff">
          <thead>
            <tr>
              <th scope="col">{t('mne.history.diff.column.cell')}</th>
              <th scope="col">{t('mne.history.diff.column.before', { revision: before.report.revision })}</th>
              <th scope="col">{t('mne.history.diff.column.after', { revision: after.report.revision })}</th>
              <th scope="col">{t('mne.history.diff.column.change')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-cell={row.key} data-change={row.change}>
                <th scope="row">{row.label}</th>
                <td data-testid={`before-${row.key}`}>{row.before ?? <span className="sub">{t('mne.history.diff.empty')}</span>}</td>
                <td data-testid={`after-${row.key}`}>{row.after ?? <span className="sub">{t('mne.history.diff.empty')}</span>}</td>
                <td>
                  <StatusPill tone={row.change === 'same' ? 'neutral' : 'warning'}>{changeLabel(t, row.change)}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One revision of the pair: its state, who approved it, why it was made, when it was issued and its files with their links. */
function RevisionCard({ revision, names }: { revision: Revision; names: ReadonlyMap<string, string> | undefined }) {
  const { t } = useTranslation();
  const { report } = revision;
  const entry = revision.history.find((candidate) => candidate.id === report.id);
  const approver = revision.approvedBy === null ? undefined : (names?.get(revision.approvedBy) ?? revision.approvedBy.slice(0, SHORT_ID));
  return (
    <section className="card" data-revision-card={report.revision} aria-label={t('mne.history.revision.title', { revision: report.revision })}>
      <h3>{t('mne.history.revision.title', { revision: report.revision })}</h3>
      <dl className="mne-facts">
        <dt>{t('mne.history.field.status')}</dt>
        <dd>{reportStatusLabel(t, report.status)}</dd>
        <dt>{t('mne.history.field.reason')}</dt>
        <dd data-testid={`reason-${report.revision}`}>{revision.correctionReason ?? t('mne.history.reason.none')}</dd>
        <dt>{t('mne.history.field.approver')}</dt>
        <dd data-testid={`approver-${report.revision}`} title={revision.approvedBy ?? undefined}>
          {approver ?? t('mne.history.approver.none')}
        </dd>
        <dt>{t('mne.history.field.issued')}</dt>
        <dd>{entry?.issuedAt ?? report.issuedAt ?? NONE}</dd>
        <dt>{t('mne.history.field.files')}</dt>
        <dd data-testid={`files-${report.revision}`}>
          {report.packages.length === 0 ? (
            t('mne.history.files.none')
          ) : (
            <ul>
              {report.packages.map((item) => (
                <li key={item.id} data-package-id={item.id}>
                  {formatLabel(t, item.format)} · {targetLabel(t, item.target)} · <code title={item.fileSha256}>{shortHash(item.fileSha256)}</code>{' '}
                  {item.downloadUrl === null ? (
                    <span className="sub">{t('mne.export.download.none')}</span>
                  ) : (
                    <a href={linkOf(item.downloadUrl, import.meta.env.VITE_API_BASE_URL ?? '')} download>
                      {t('mne.history.download.action', { format: formatLabel(t, item.format), revision: report.revision })}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </section>
  );
}
