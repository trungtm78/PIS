import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../ui';
import { DirectiveTable, Field, Notice, PolicyNote, Select } from './components';
import { useDirCommand, useMeetingDetail, useMemberOptions, useProjectOptions, useUnitOptions } from './hooks';
import { errorText, meetingTypeLabel } from './labels';
import { MEETING_LIST_PATH, asOfText, dayText, idFrom, isDay, parseIds } from './model';
import type { MeetingDetail } from './model';

const NEVER_EMPTY = (): boolean => false;

/**
 * DIR-02: one meeting with its minutes and the directives it gave. The minutes are a version of a file of the tenant (attached, or replaced, with the version of the meeting); a directive is about one project or one
 * unit, is given to a unit (and a person, when one is named) and is due on a day not before the meeting. The buttons are the commands the server says the reader may give over the meeting.
 */
export default function MeetingDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <MeetingDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Panel = 'directive' | 'minutes' | undefined;

function MeetingDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const meetingId = idFrom(params.get('meeting'));
  const read = useMeetingDetail(meetingId);
  const data = read.data ?? undefined;
  const state = useScreenState({ isLoading: read.isLoading, error: read.data === undefined ? read.error : undefined, data: read.data, isEmpty: NEVER_EMPTY });
  const stale = read.isError && read.data !== undefined;
  const [panel, setPanel] = useState<Panel>(undefined);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined);
  const writable = mode !== 'READ_ONLY';
  const toggle = (next: Exclude<Panel, undefined>): void => setPanel(panel === next ? undefined : next);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="dir-back-link">
        <Link to={MEETING_LIST_PATH}>
          <span aria-hidden="true">← </span>
          {t('dir.detail.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{data === undefined ? t('dir.meeting.page.title') : `${data.meeting.code} · ${data.meeting.title}`}</h1>
          <p>{t('dir.meeting.page.subtitle')}</p>
        </div>
        {data !== undefined && writable ? (
          <div className="dir-actions">
            {data.actions.attachMinutes ? (
              <button type="button" className="ui-button ui-button--outline" aria-expanded={panel === 'minutes'} onClick={() => toggle('minutes')}>
                {t('dir.meeting.minutes.action')}
              </button>
            ) : null}
            {data.actions.addDirective ? (
              <button type="button" className="ui-button" aria-expanded={panel === 'directive'} onClick={() => toggle('directive')}>
                {t('dir.meeting.add.action')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ContextBar
        items={[{ label: t('dir.ctx.scope.label'), value: tenant?.name ?? t('dir.ctx.scope.all') }, ...(data === undefined ? [] : [{ label: t('dir.meeting.ctx.unit'), value: data.meeting.unit.code }])]}
        {...(data === undefined || data.asOf === '' ? {} : { asOf: asOfText(data.asOf) })}
        stale={stale}
      />
      {meetingId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('dir.meeting.noTarget.text')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void read.refetch()}>
          {data === undefined ? (
            <p className="callout" data-testid="missing">
              {t('dir.meeting.missing.text')}
            </p>
          ) : (
            <>
              {message === undefined ? null : (
                <Notice tone={message.tone} testId="message">
                  {message.text}
                </Notice>
              )}
              {panel === 'minutes' ? (
                <MinutesForm
                  meeting={data.meeting}
                  onDone={(result) => {
                    setMessage(result);
                    if (result.tone === 'ok') setPanel(undefined);
                  }}
                />
              ) : null}
              {panel === 'directive' ? (
                <AddDirectiveForm
                  meeting={data.meeting}
                  onDone={(result) => {
                    setMessage(result);
                    if (result.tone === 'ok') setPanel(undefined);
                  }}
                />
              ) : null}
              <Facts data={data} />
              <SectionCard title={t('dir.meeting.directives.title')} status={<StatusPill tone="neutral">{t('dir.meeting.directives.count', { count: data.directives.length })}</StatusPill>}>
                {data.truncated ? <Notice tone="info">{t('dir.meeting.truncated.text')}</Notice> : null}
                <DirectiveTable caption={t('dir.meeting.directives.title')} rows={data.directives} state={data.directives.length === 0 ? 'empty' : 'ready'} />
              </SectionCard>
              <PolicyNote policy={data.policy} />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('dir.footer.text', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Facts({ data }: { data: MeetingDetail }) {
  const { t } = useTranslation();
  const { meeting } = data;
  return (
    <SectionCard title={t('dir.meeting.facts.title')}>
      <dl className="dir-facts">
        <dt>{t('dir.meetings.date.header')}</dt>
        <dd>{dayText(meeting.meetingDate)}</dd>
        <dt>{t('dir.meetings.type.header')}</dt>
        <dd>{meetingTypeLabel(t, meeting.meetingType)}</dd>
        <dt>{t('dir.meetings.unit.header')}</dt>
        <dd>{`${meeting.unit.code} · ${meeting.unit.name}`}</dd>
        <dt>{t('dir.meetings.minutes.header')}</dt>
        <dd data-testid="minutes">{meeting.minutesDocumentVersionId === null ? t('dir.meeting.minutes.none') : t('dir.meeting.minutes.ref', { id: meeting.minutesDocumentVersionId })}</dd>
        {meeting.summary === null ? null : (
          <>
            <dt>{t('dir.meeting.summary.label')}</dt>
            <dd>{meeting.summary}</dd>
          </>
        )}
        <dt>{t('dir.meeting.counts.label')}</dt>
        <dd>{t('dir.meeting.counts.text', { total: meeting.total, open: meeting.byStatus.OPEN + meeting.byStatus.IN_PROGRESS, overdue: meeting.byStatus.OVERDUE, done: meeting.byStatus.DONE })}</dd>
      </dl>
    </SectionCard>
  );
}

type Done = (result: { tone: 'ok' | 'error'; text: string }) => void;

/** Attaches (or replaces) the minutes: one id of a version of a file, with the version of the meeting the screen showed. */
function MinutesForm({ meeting, onDone }: { meeting: MeetingDetail['meeting']; onDone: Done }) {
  const { t } = useTranslation();
  const attach = useDirCommand('attachMeetingMinutes');
  const [value, setValue] = useState('');
  const [tried, setTried] = useState(false);
  const parsed = parseIds(value);
  const problem = parsed.ids.length !== 1 || parsed.invalid.length > 0 ? t('dir.form.document.error') : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (problem !== undefined || parsed.ids[0] === undefined) return;
    attach.mutate(
      { id: meeting.id, version: meeting.version, body: { document_version_id: parsed.ids[0] } },
      { onSuccess: () => onDone({ tone: 'ok', text: t('dir.meeting.minutes.done.text') }), onError: (error) => onDone({ tone: 'error', text: errorText(t, error) }) },
    );
  };
  return (
    <SectionCard title={t('dir.meeting.minutes.title')}>
      <form className="dir-form" onSubmit={submit} noValidate aria-label={t('dir.meeting.minutes.title')}>
        <Field id="dir-minutes-id" label={t('dir.meeting.minutes.field.label')} hint={t('dir.form.document.hint')} error={tried ? problem : undefined}>
          <input id="dir-minutes-id" type="text" value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <div className="dir-actions dir-wide">
          <button type="submit" className="ui-button" disabled={attach.isPending}>
            {attach.isPending ? t('dir.form.sending.text') : t('dir.meeting.minutes.submit.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}

/** Gives a directive in the meeting: about a project or about a unit, to a unit (and a person), due on a day not before the meeting. */
function AddDirectiveForm({ meeting, onDone }: { meeting: MeetingDetail['meeting']; onDone: Done }) {
  const { t } = useTranslation();
  const add = useDirCommand('addDirective');
  const units = useUnitOptions();
  const projects = useProjectOptions();
  const members = useMemberOptions();
  const [kind, setKind] = useState<'PROJECT' | 'UNIT'>('PROJECT');
  const [projectId, setProjectId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [text, setText] = useState('');
  const [assigneeUnit, setAssigneeUnit] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [tried, setTried] = useState(false);
  const problems = {
    about: kind === 'PROJECT' ? (projectId === '' ? t('dir.form.required.error') : undefined) : unitId === '' ? t('dir.form.required.error') : undefined,
    text: text.trim() === '' ? t('dir.form.required.error') : undefined,
    assigneeUnit: assigneeUnit === '' ? t('dir.form.required.error') : undefined,
    due: !isDay(dueOn) ? t('dir.form.day.error') : dueOn < meeting.meetingDate ? t('dir.meeting.add.due.error', { day: dayText(meeting.meetingDate) }) : undefined,
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (Object.values(problems).some((problem) => problem !== undefined)) return;
    add.mutate(
      {
        id: meeting.id,
        body: {
          scope_kind: kind,
          ...(kind === 'PROJECT' ? { project_id: projectId } : { unit_id: unitId }),
          text: text.trim(),
          assignee_unit_id: assigneeUnit,
          ...(assignee === '' ? {} : { assignee_membership_id: assignee }),
          due_on: dueOn,
        },
      },
      { onSuccess: () => onDone({ tone: 'ok', text: t('dir.meeting.add.done.text') }), onError: (error) => onDone({ tone: 'error', text: errorText(t, error) }) },
    );
  };
  const shown = (key: keyof typeof problems): string | undefined => (tried ? problems[key] : undefined);
  return (
    <SectionCard title={t('dir.meeting.add.title')}>
      <form className="dir-form" onSubmit={submit} noValidate aria-label={t('dir.meeting.add.title')}>
        <fieldset className="dir-wide">
          <legend>{t('dir.meeting.add.kind.label')}</legend>
          <label>
            <input type="radio" name="dir-kind" checked={kind === 'PROJECT'} onChange={() => setKind('PROJECT')} /> {t('dir.meeting.add.kind.project')}
          </label>
          <label>
            <input type="radio" name="dir-kind" checked={kind === 'UNIT'} onChange={() => setKind('UNIT')} /> {t('dir.meeting.add.kind.unit')}
          </label>
        </fieldset>
        {kind === 'PROJECT' ? (
          <Select id="dir-add-project" label={t('dir.meeting.add.project.label')} value={projectId} onChange={setProjectId} options={projects.data ?? []} emptyLabel={t('dir.form.choose.option')} error={shown('about')} />
        ) : (
          <Select id="dir-add-unit" label={t('dir.meeting.add.unit.label')} value={unitId} onChange={setUnitId} options={units.data ?? []} emptyLabel={t('dir.form.choose.option')} error={shown('about')} />
        )}
        <Field id="dir-add-text" label={t('dir.meeting.add.text.label')} error={shown('text')}>
          <textarea id="dir-add-text" rows={3} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        <Select id="dir-add-assignee-unit" label={t('dir.meeting.add.assigneeUnit.label')} value={assigneeUnit} onChange={setAssigneeUnit} options={units.data ?? []} emptyLabel={t('dir.form.choose.option')} error={shown('assigneeUnit')} />
        <Select id="dir-add-assignee" label={t('dir.meeting.add.assignee.label')} value={assignee} onChange={setAssignee} options={members.data ?? []} emptyLabel={t('dir.meeting.add.assignee.none')} />
        <Field id="dir-add-due" label={t('dir.meeting.add.due.label')} error={shown('due')}>
          <input id="dir-add-due" type="date" min={meeting.meetingDate} value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </Field>
        <div className="dir-actions dir-wide">
          <button type="submit" className="ui-button" disabled={add.isPending}>
            {add.isPending ? t('dir.form.sending.text') : t('dir.meeting.add.submit.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}
