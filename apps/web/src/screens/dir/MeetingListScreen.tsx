import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field, Notice, Select } from './components';
import { NO_MEETING_FILTER, useDirCommand, useMeetingPage, useUnitOptions } from './hooks';
import type { MeetingFilter } from './hooks';
import { errorText, meetingTypeLabel } from './labels';
import { BOARD_PATH, MEETING_TYPES, PERMISSION, asOfText, can, dayText, isDay, meetingPath, parseIds, vietnamDay } from './model';
import type { MeetingLine } from './model';

const NEVER_EMPTY = (): boolean => false;

/**
 * DIR-01: the investment steering meetings in the scope of the reader, the latest first, each with the number of directives it gave by the status a reader sees and how many are late. The filters are the
 * unit that held it, the type, and a range of days; a meeting is recorded with its day (not in the future), type, unit and, when there are some, the minutes (a version of a file of the tenant). The server decides
 * who may record one: the button is shown to a session that may, and a refusal is said in words.
 */
export default function MeetingListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters and the page belong to one membership: a switch starts the screen over.
  return <MeetingListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MeetingListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [filter, setFilter] = useState<MeetingFilter>(NO_MEETING_FILTER);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const cursor = cursors[cursors.length - 1];
  const page = useMeetingPage(filter, cursor);
  const units = useUnitOptions();
  const data = page.data;
  const state = useScreenState({ isLoading: page.isLoading, error: data === undefined ? page.error : undefined, data, isEmpty: NEVER_EMPTY });
  const stale = page.isError && data !== undefined;
  const applied = Object.values(filter).filter((value) => value !== '').length;
  const change = (next: Partial<MeetingFilter>): void => {
    setFilter({ ...filter, ...next });
    setCursors([undefined]);
  };

  const columns: DataTableColumn<MeetingLine>[] = [
    { key: 'code', header: t('dir.meetings.code.header'), pinned: true, render: (row) => <Link to={meetingPath(row.id)}>{row.code}</Link> },
    { key: 'title', header: t('dir.meetings.title.header'), render: (row) => row.title },
    { key: 'date', header: t('dir.meetings.date.header'), render: (row) => dayText(row.meetingDate) },
    { key: 'type', header: t('dir.meetings.type.header'), render: (row) => meetingTypeLabel(t, row.meetingType) },
    { key: 'unit', header: t('dir.meetings.unit.header'), render: (row) => row.unit.code },
    { key: 'minutes', header: t('dir.meetings.minutes.header'), render: (row) => (row.minutesDocumentVersionId === null ? <StatusPill tone="warning">{t('dir.meetings.minutes.missing')}</StatusPill> : <StatusPill tone="success">{t('dir.meetings.minutes.attached')}</StatusPill>) },
    { key: 'total', header: t('dir.meetings.total.header'), group: t('dir.meetings.directives.group'), align: 'right', render: (row) => String(row.total) },
    { key: 'open', header: t('dir.meetings.open.header'), group: t('dir.meetings.directives.group'), align: 'right', render: (row) => String(row.byStatus.OPEN + row.byStatus.IN_PROGRESS) },
    { key: 'overdue', header: t('dir.meetings.overdue.header'), group: t('dir.meetings.directives.group'), align: 'right', render: (row) => (row.byStatus.OVERDUE > 0 ? <StatusPill tone="danger">{String(row.byStatus.OVERDUE)}</StatusPill> : '0') },
    { key: 'done', header: t('dir.meetings.done.header'), group: t('dir.meetings.directives.group'), align: 'right', render: (row) => String(row.byStatus.DONE) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dir.meetings.page.title')}</h1>
          <p>{t('dir.meetings.page.subtitle')}</p>
        </div>
        <div className="dir-actions">
          <Link className="ui-button ui-button--outline" to={BOARD_PATH}>
            {t('dir.meetings.board.action')}
          </Link>
          {can(permissions, mode, PERMISSION.meeting) ? (
            <button type="button" className="ui-button" aria-expanded={creating} onClick={() => setCreating((value) => !value)}>
              {t('dir.meetings.create.action')}
            </button>
          ) : null}
        </div>
      </div>
      <ContextBar items={[{ label: t('dir.ctx.scope.label'), value: tenant?.name ?? t('dir.ctx.scope.all') }]} {...(data === undefined || data.asOf === '' ? {} : { asOf: asOfText(data.asOf) })} stale={stale} />
      {message === undefined ? null : (
        <Notice tone={message.tone} testId="message">
          {message.text}
        </Notice>
      )}
      {creating ? (
        <CreateMeetingForm
          units={units.data ?? []}
          onCancel={() => setCreating(false)}
          onDone={(result) => {
            setMessage(result);
            if (result.tone === 'ok') setCreating(false);
          }}
        />
      ) : null}
      <FilterPanel
        applied={applied}
        {...(data === undefined || data.asOf === '' ? {} : { updatedAt: asOfText(data.asOf) })}
        actions={
          applied === 0 ? undefined : (
            <button type="button" className="ui-button ui-button--outline" onClick={() => change(NO_MEETING_FILTER)}>
              {t('dir.filter.clear.action')}
            </button>
          )
        }
      >
        <Select id="dir-meeting-unit" label={t('dir.filter.unit.label')} value={filter.unitId} onChange={(value) => change({ unitId: value })} options={units.data ?? []} emptyLabel={t('dir.filter.all.option')} />
        <Select id="dir-meeting-type" label={t('dir.filter.type.label')} value={filter.meetingType} onChange={(value) => change({ meetingType: value })} options={MEETING_TYPES.map((type) => ({ id: type, label: meetingTypeLabel(t, type) }))} emptyLabel={t('dir.filter.all.option')} />
        <Field id="dir-meeting-from" label={t('dir.filter.from.label')}>
          <input id="dir-meeting-from" type="date" value={filter.from} onChange={(event) => change({ from: event.target.value })} />
        </Field>
        <Field id="dir-meeting-to" label={t('dir.filter.to.label')}>
          <input id="dir-meeting-to" type="date" value={filter.to} onChange={(event) => change({ to: event.target.value })} />
        </Field>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void page.refetch()}>
        <DataTable
          caption={t('dir.meetings.table.caption')}
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row.id}
          state={data !== undefined && data.items.length === 0 ? 'empty' : 'ready'}
          emptyKind={applied === 0 ? 'none' : 'filtered'}
          onClearFilters={() => change(NO_MEETING_FILTER)}
        />
        <div className="dir-actions" role="group" aria-label={t('dir.pager.label')}>
          <button type="button" className="ui-button ui-button--outline" disabled={cursors.length <= 1} onClick={() => setCursors(cursors.slice(0, -1))}>
            {t('dir.pager.previous.action')}
          </button>
          <span className="muted">{t('dir.pager.page.text', { page: cursors.length })}</span>
          <button type="button" className="ui-button ui-button--outline" disabled={data?.nextCursor === undefined} onClick={() => data?.nextCursor !== undefined && setCursors([...cursors, data.nextCursor])}>
            {t('dir.pager.next.action')}
          </button>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('dir.footer.text', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface CreateProps {
  units: Array<{ id: string; label: string }>;
  onCancel: () => void;
  onDone: (result: { tone: 'ok' | 'error'; text: string }) => void;
}

/** The form that records a meeting; the day is not in the future, the unit is one of the tenant, and the minutes (when given) are ids of versions of files. */
function CreateMeetingForm({ units, onCancel, onDone }: CreateProps) {
  const { t } = useTranslation();
  const create = useDirCommand('createSteeringMeeting');
  const [date, setDate] = useState('');
  const [type, setType] = useState<string>('WEEKLY');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [unitId, setUnitId] = useState('');
  const [minutes, setMinutes] = useState('');
  const [tried, setTried] = useState(false);
  const today = vietnamDay(new Date());
  const minutesId = parseIds(minutes);
  const problems = {
    date: !isDay(date) ? t('dir.meetings.create.date.error') : date > today ? t('dir.meetings.create.future.error') : undefined,
    title: title.trim() === '' ? t('dir.form.required.error') : undefined,
    unit: unitId === '' ? t('dir.form.required.error') : undefined,
    minutes: minutes.trim() !== '' && (minutesId.invalid.length > 0 || minutesId.ids.length !== 1) ? t('dir.form.document.error') : undefined,
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (Object.values(problems).some((problem) => problem !== undefined)) return;
    create.mutate(
      { body: { meeting_date: date, meeting_type: type, title: title.trim(), unit_id: unitId, ...(summary.trim() === '' ? {} : { summary: summary.trim() }), ...(minutesId.ids[0] === undefined ? {} : { minutes_document_version_id: minutesId.ids[0] }) } },
      {
        onSuccess: (result) => onDone({ tone: 'ok', text: t('dir.meetings.create.done.text', { code: typeof (result as { code?: unknown } | undefined)?.code === 'string' ? String((result as { code: string }).code) : '' }) }),
        onError: (error) => onDone({ tone: 'error', text: errorText(t, error) }),
      },
    );
  };
  const shown = (key: keyof typeof problems): string | undefined => (tried ? problems[key] : undefined);
  return (
    <SectionCard title={t('dir.meetings.create.title')}>
      <form className="dir-form" onSubmit={submit} noValidate aria-label={t('dir.meetings.create.title')}>
        <Field id="dir-create-date" label={t('dir.meetings.create.date.label')} error={shown('date')}>
          <input id="dir-create-date" type="date" max={today} value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Select id="dir-create-type" label={t('dir.meetings.create.type.label')} value={type} onChange={setType} options={MEETING_TYPES.map((value) => ({ id: value, label: meetingTypeLabel(t, value) }))} />
        <Select id="dir-create-unit" label={t('dir.meetings.create.unit.label')} value={unitId} onChange={setUnitId} options={units} emptyLabel={t('dir.form.choose.option')} error={shown('unit')} />
        <Field id="dir-create-title" label={t('dir.meetings.create.name.label')} error={shown('title')}>
          <input id="dir-create-title" type="text" maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field id="dir-create-summary" label={t('dir.meetings.create.summary.label')}>
          <textarea id="dir-create-summary" maxLength={4000} rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
        </Field>
        <Field id="dir-create-minutes" label={t('dir.meetings.create.minutes.label')} hint={t('dir.form.document.hint')} error={shown('minutes')}>
          <input id="dir-create-minutes" type="text" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </Field>
        <div className="dir-actions dir-wide">
          <button type="submit" className="ui-button" disabled={create.isPending}>
            {create.isPending ? t('dir.form.sending.text') : t('dir.meetings.create.submit.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" disabled={create.isPending} onClick={onCancel}>
            {t('dir.form.cancel.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}
