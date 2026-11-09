import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, PresentButton, PresentationMode, StatusPill } from '../../ui';
import type { DataTableColumn, PresentationBoard } from '../../ui';
import { Field, FormulaTile, Notice, Select, StatusChip } from './components';
import { useProjectOptions, useReport, useUnitOptions } from './hooks';
import { statusLabel } from './labels';
import { BOARD_PATH, STATUSES, asOfText, dayText, defaultPeriod, directivePath, isDay, vietnamDay } from './model';
import type { Policy, ReportItem } from './model';

const NEVER_EMPTY = (): boolean => false;
/** How many late directives one board of the presentation lists. */
const PRESENT_ROWS = 8;
/** Not a policy of the period: the numbers of a period are counted by their own rule, which the server states with each figure; this only fills the "i" (the version is the one of the clock). */
const NO_POLICY: Policy = { code: 'DEFAULT', version: null, source: 'DEFAULT', unverified: false, reminderDaysBefore: [], escalateAfterOverdueDays: 0, maxExtensions: 0, maxExtensionDays: 0, closeRequiresEvidence: true };

/**
 * DIR-05: the directives of a period, as the input of the narrative of the next report. The period is chosen by its first and last day (the last thirty days when nothing is chosen); the figures are what was raised,
 * closed, extended, still open and late on the last day, each with the definition the server gave it, and they add up to the list below: every directive of the period is in exactly one status at its end, replayed from its
 * timeline whatever happened after. A directive due on the last day and not closed by the end of it counts as late.
 */
export default function PeriodScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PeriodContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PeriodContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [today] = useState(() => vietnamDay(new Date()));
  const [period, setPeriod] = useState(() => defaultPeriod(today));
  const [unitId, setUnitId] = useState('');
  const [projectId, setProjectId] = useState('');
  const units = useUnitOptions();
  const projects = useProjectOptions();
  const valid = isDay(period.from) && isDay(period.to) && period.from <= period.to;
  const read = useReport(period, { unitId, projectId }, valid);
  const data = read.data ?? undefined;
  const state = useScreenState({ isLoading: read.isLoading && valid, error: data === undefined ? read.error : undefined, data: valid ? read.data : undefined, isEmpty: NEVER_EMPTY });
  const stale = read.isError && data !== undefined;
  const counts = data?.counts;
  const tile = (label: string, value: number | undefined, key: string, tone?: 'danger' | 'warning' | 'success') => (
    <FormulaTile key={key} label={label} value={value === undefined ? '' : String(value)} {...(tone === undefined ? {} : { tone })} formula={data?.definitions[key]} asOf={data?.asOf ?? ''} policy={NO_POLICY} version={t('dir.period.version.text')} state={data === undefined ? 'loading' : 'ready'} />
  );

  const columns: DataTableColumn<ReportItem>[] = [
    { key: 'code', header: t('dir.table.code.header'), pinned: true, render: (row) => <Link to={directivePath(row.id)}>{row.code}</Link> },
    { key: 'text', header: t('dir.table.text.header'), render: (row) => row.text },
    { key: 'about', header: t('dir.table.about.header'), render: (row) => (row.project === null ? t('dir.table.about.unit', { unit: row.assigneeUnit.code }) : row.project.code) },
    { key: 'unit', header: t('dir.table.unit.header'), render: (row) => row.assigneeUnit.code },
    { key: 'due', header: t('dir.period.dueAtEnd.header'), render: (row) => dayText(row.dueOnAtEnd) },
    { key: 'status', header: t('dir.period.statusAtEnd.header'), render: (row) => <StatusChip status={row.statusAtEnd} /> },
    {
      key: 'facts',
      header: t('dir.period.facts.header'),
      render: (row) => [row.raisedInPeriod ? t('dir.period.fact.raised') : '', row.closedInPeriod ? t('dir.period.fact.closed') : '', row.extendedInPeriod ? t('dir.period.fact.extended') : ''].filter((text) => text !== '').join(' · '),
    },
    { key: 'note', header: t('dir.period.note.header'), render: (row) => (row.lastNote === null ? '' : `${row.lastNote}${row.lastNoteOn === null ? '' : ` (${dayText(row.lastNoteOn)})`}`) },
  ];

  const [presenting, setPresenting] = useState(false);
  const overdueRows = data === undefined ? [] : data.items.filter((row) => row.statusAtEnd === 'OVERDUE');
  // The boards of the presentation at a meeting: the counts of the period first, then the directives that are late, the filters and links of the page left behind.
  const boards: PresentationBoard[] =
    data === undefined
      ? []
      : [
          {
            id: 'counts',
            title: t('dir.present.counts.title'),
            content: (
              <>
                <KpiStrip label={t('dir.period.tiles.label')}>
                  {tile(t('dir.period.tile.total.label'), counts?.total, 'by_status')}
                  {tile(t('dir.period.tile.raised.label'), counts?.raised, 'raised')}
                  {tile(t('dir.period.tile.closed.label'), counts?.closed, 'closed', 'success')}
                  {tile(t('dir.period.tile.extended.label'), counts?.extended, 'extended')}
                  {tile(t('dir.period.tile.open.label'), counts?.openAtEnd, 'open_at_end', 'warning')}
                  {tile(t('dir.period.tile.overdue.label'), counts?.overdueAtEnd, 'overdue_at_end', 'danger')}
                </KpiStrip>
                <p className="muted">{STATUSES.map((status) => `${statusLabel(t, status)}: ${counts?.byStatus[status] ?? 0}`).join(' · ')}</p>
              </>
            ),
          },
          {
            id: 'overdue',
            title: t('dir.present.overdue.title'),
            content: <DataTable caption={t('dir.present.overdue.caption')} columns={columns.filter((column) => ['code', 'text', 'about', 'unit', 'due'].includes(column.key))} rows={overdueRows.slice(0, PRESENT_ROWS)} rowKey={(row) => row.id} state={overdueRows.length === 0 ? 'empty' : 'ready'} severity={() => 'ACTION'} />,
          },
        ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dir.period.page.title')}</h1>
          <p>{t('dir.period.page.subtitle')}</p>
        </div>
        <div className="dir-actions">
          <PresentButton onOpen={() => setPresenting(true)} disabled={data === undefined} testId="dir-presentation-mode" clipRef="dir.dashboard.presentation-mode" />
          <Link className="ui-button ui-button--outline" to={BOARD_PATH}>
            {t('dir.period.board.action')}
          </Link>
        </div>
        {presenting && data !== undefined ? <PresentationMode title={t('dir.present.title.text')} boards={boards} onExit={() => setPresenting(false)} /> : null}
      </div>
      <ContextBar items={[{ label: t('dir.ctx.scope.label'), value: tenant?.name ?? t('dir.ctx.scope.all') }, { label: t('dir.period.ctx.period'), value: `${dayText(period.from)} – ${dayText(period.to)}` }]} {...(data === undefined || data.asOf === '' ? {} : { asOf: asOfText(data.asOf) })} stale={stale} />
      <FilterPanel>
        <Field id="dir-p-from" label={t('dir.period.from.label')}>
          <input id="dir-p-from" type="date" value={period.from} max={period.to === '' ? today : period.to} onChange={(event) => setPeriod({ ...period, from: event.target.value })} />
        </Field>
        <Field id="dir-p-to" label={t('dir.period.to.label')}>
          <input id="dir-p-to" type="date" value={period.to} min={period.from} onChange={(event) => setPeriod({ ...period, to: event.target.value })} />
        </Field>
        <Select id="dir-p-unit" label={t('dir.filter.unit.label')} value={unitId} onChange={setUnitId} options={units.data ?? []} emptyLabel={t('dir.filter.all.option')} />
        <Select id="dir-p-project" label={t('dir.filter.project.label')} value={projectId} onChange={setProjectId} options={projects.data ?? []} emptyLabel={t('dir.filter.all.option')} />
      </FilterPanel>
      {valid ? (
        <StateBoundary state={state} onRetry={() => void read.refetch()}>
          {data === undefined ? null : (
            <>
              {data.truncated ? <Notice tone="info">{t('dir.period.truncated.text')}</Notice> : null}
              <KpiStrip label={t('dir.period.tiles.label')}>
                {tile(t('dir.period.tile.total.label'), counts?.total, 'by_status')}
                {tile(t('dir.period.tile.raised.label'), counts?.raised, 'raised')}
                {tile(t('dir.period.tile.closed.label'), counts?.closed, 'closed', 'success')}
                {tile(t('dir.period.tile.extended.label'), counts?.extended, 'extended')}
                {tile(t('dir.period.tile.open.label'), counts?.openAtEnd, 'open_at_end', 'warning')}
                {tile(t('dir.period.tile.overdue.label'), counts?.overdueAtEnd, 'overdue_at_end', 'danger')}
              </KpiStrip>
              <p className="muted" data-testid="by-status">
                {STATUSES.map((status) => `${statusLabel(t, status)}: ${counts?.byStatus[status] ?? 0}`).join(' · ')}
              </p>
              <DataTable caption={t('dir.period.table.caption')} columns={columns} rows={data.items} rowKey={(row) => row.id} state={data.items.length === 0 ? 'empty' : 'ready'} severity={(row) => (row.statusAtEnd === 'OVERDUE' ? 'ACTION' : null)} />
              <StatusPill tone="neutral">{t('dir.period.total.text', { count: data.items.length })}</StatusPill>
            </>
          )}
        </StateBoundary>
      ) : (
        <Notice tone="error" testId="period-invalid">
          {t('dir.period.invalid.text')}
        </Notice>
      )}
      <p className="prototype-note">{t('dir.footer.text', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
