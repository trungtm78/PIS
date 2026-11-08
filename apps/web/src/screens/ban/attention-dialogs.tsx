import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ConfirmDialog } from '../../ui';
import { NO_MEETING_FILTER, useMeetingPage } from '../dir/hooks';
import { directiveFailureText, refusalText } from './components';
import { useDecide, useIssueDirective } from './hooks';
import type { DirectedResult } from './hooks';
import { dayText, decisionProblems, directiveProblems, vietnamDay } from './model';
import type { Attention, DecisionInput } from './model';

export interface DecisionDialogProps {
  item: Attention;
  decision: DecisionInput['decision'];
  onClose: () => void;
  onDone: (text: string) => void;
}

/** Acknowledge, defer or reopen a project of the list: every one of them says why (a note), a deferral says until which day (a day after today); the refusal of the server is said inside the dialog. */
export function DecisionDialog({ item, decision, onClose, onDone }: DecisionDialogProps) {
  const { t } = useTranslation();
  const decide = useDecide();
  const [error, setError] = useState<string | undefined>(undefined);
  const [deferUntil, setDeferUntil] = useState('');
  const today = vietnamDay();
  const title = decision === 'ACKNOWLEDGED' ? t('ban.att.dialog.acknowledged.title') : decision === 'DEFERRED' ? t('ban.att.dialog.deferred.title') : t('ban.att.dialog.reopened.title');
  const confirm = decision === 'ACKNOWLEDGED' ? t('ban.att.action.acknowledge') : decision === 'DEFERRED' ? t('ban.att.action.defer') : t('ban.att.action.reopen');
  const done = decision === 'ACKNOWLEDGED' ? t('ban.att.receipt.acknowledged', { code: item.code }) : decision === 'DEFERRED' ? t('ban.att.receipt.deferred', { code: item.code, day: dayText(deferUntil) }) : t('ban.att.receipt.reopened', { code: item.code });
  return (
    <ConfirmDialog
      open
      title={title}
      context={[
        { label: t('ban.att.col.project'), value: `${item.code} ${item.name}` },
        { label: t('ban.att.col.score'), value: item.score },
      ]}
      confirmLabel={confirm}
      cancelLabel={t('ban.att.dialog.cancel')}
      pending={decide.isPending}
      reason={{ label: t('ban.att.dialog.note.label'), required: true }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(note) => {
        const input: DecisionInput = { projectId: item.project_id, decision, note: note ?? '', deferUntil };
        const problems = decisionProblems(input, today);
        if (problems.length > 0) {
          setError(problems.includes('note') ? t('ban.att.dialog.note.error') : t('ban.att.dialog.deferUntil.error'));
          return;
        }
        setError(undefined);
        decide.mutate(input, { onSuccess: () => onDone(done), onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      {decision === 'DEFERRED' ? (
        <div className="ban-form"><label htmlFor="ban-defer-until">
          <span>{t('ban.att.dialog.deferUntil.label')}</span>
          <input id="ban-defer-until" type="date" min={today} value={deferUntil} data-testid="defer-until" onChange={(event) => setDeferUntil(event.target.value)} />
        </label></div>
      ) : null}
      <p>{decision === 'ACKNOWLEDGED' ? t('ban.att.dialog.acknowledged.text') : decision === 'DEFERRED' ? t('ban.att.dialog.deferred.text') : t('ban.att.dialog.reopened.text')}</p>
    </ConfirmDialog>
  );
}

export interface DirectiveDialogProps {
  item: Attention;
  onClose: () => void;
  onDone: (text: string, result: DirectedResult) => void;
}

/**
 * "Issue a directive from this project row": a meeting of DIR is chosen or a new one is opened, the directive is given in it to the investor unit of the project, and then the committee records that it DIRECTED, with the
 * directive's id. It is one action for the person and three commands for the server; a failure after the directive was given says so, and sending again only records the link.
 */
export function DirectiveDialog({ item, onClose, onDone }: DirectiveDialogProps) {
  const { t } = useTranslation();
  const issue = useIssueDirective();
  const meetings = useMeetingPage(NO_MEETING_FILTER, undefined, 20);
  const list = meetings.data?.items ?? [];
  const today = vietnamDay();
  const [kind, setKind] = useState<'existing' | 'new' | undefined>(undefined);
  const [meetingId, setMeetingId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState(t('ban.att.directive.meeting.defaultTitle', { day: dayText(today) }));
  const [text, setText] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const effective = kind ?? (list.length > 0 ? 'existing' : 'new');
  const chosen = meetingId ?? list[0]?.id ?? '';
  const meeting = list.find((one) => one.id === chosen);
  const input = {
    project: { project_id: item.project_id, investor_unit_id: item.investor_unit_id },
    meeting: effective === 'existing' ? ({ kind: 'existing', meetingId: chosen } as const) : ({ kind: 'new', title } as const),
    meetingDate: meeting?.meetingDate ?? '',
    text,
    dueOn,
    today,
  };
  const problems = directiveProblems(input);
  const shown = (problem: (typeof problems)[number]): boolean => tried && problems.includes(problem);
  return (
    <ConfirmDialog
      open
      title={t('ban.att.directive.title')}
      context={[
        { label: t('ban.att.col.project'), value: `${item.code} ${item.name}` },
        { label: t('ban.att.directive.assignee'), value: item.investor_name },
      ]}
      confirmLabel={t('ban.att.directive.confirm')}
      cancelLabel={t('ban.att.dialog.cancel')}
      pending={issue.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        setTried(true);
        if (problems.length > 0) {
          setError(t('ban.att.directive.invalid.text'));
          return;
        }
        setError(undefined);
        issue.mutate(input, { onSuccess: (result) => onDone(t('ban.att.receipt.directed', { code: item.code }), result), onError: (failure) => setError(directiveFailureText(t, failure)) });
      }}
    >
      <div className="ban-form" data-testid="directive-form">
        <fieldset className="ban-wide">
          <legend>{t('ban.att.directive.meeting.legend')}</legend>
          <label>
            <input type="radio" name="ban-meeting" checked={effective === 'existing'} disabled={list.length === 0} onChange={() => setKind('existing')} /> {t('ban.att.directive.meeting.existing')}
          </label>
          <label>
            <input type="radio" name="ban-meeting" checked={effective === 'new'} onChange={() => setKind('new')} /> {t('ban.att.directive.meeting.new')}
          </label>
        </fieldset>
        {meetings.isError ? (
          <p className="ban-error ban-wide" role="alert">
            {t('ban.att.directive.meeting.loadError')}
          </p>
        ) : null}
        {effective === 'existing' ? (
          <label className="ban-wide" htmlFor="ban-directive-meeting">
            <span>{t('ban.att.directive.meeting.label')}</span>
            <select id="ban-directive-meeting" value={chosen} data-testid="directive-meeting" onChange={(event) => setMeetingId(event.target.value)}>
              {list.map((one) => (
                <option key={one.id} value={one.id}>
                  {t('ban.att.directive.meeting.option', { code: one.code, day: dayText(one.meetingDate), title: one.title })}
                </option>
              ))}
            </select>
            {shown('meeting') ? <span className="ban-error">{t('ban.att.directive.meeting.error')}</span> : null}
          </label>
        ) : (
          <label className="ban-wide" htmlFor="ban-directive-title">
            <span>{t('ban.att.directive.meeting.titleLabel')}</span>
            <input id="ban-directive-title" type="text" maxLength={300} value={title} data-testid="directive-title" onChange={(event) => setTitle(event.target.value)} />
            {shown('meeting') ? <span className="ban-error">{t('ban.att.directive.meeting.error')}</span> : null}
          </label>
        )}
        <label className="ban-wide" htmlFor="ban-directive-text">
          <span>{t('ban.att.directive.text.label')}</span>
          <textarea id="ban-directive-text" rows={3} maxLength={2000} value={text} data-testid="directive-text" onChange={(event) => setText(event.target.value)} />
          {shown('text') ? <span className="ban-error">{t('ban.att.directive.text.error')}</span> : null}
        </label>
        <label htmlFor="ban-directive-due">
          <span>{t('ban.att.directive.due.label')}</span>
          <input id="ban-directive-due" type="date" min={effective === 'existing' && meeting !== undefined ? meeting.meetingDate : today} value={dueOn} data-testid="directive-due" onChange={(event) => setDueOn(event.target.value)} />
          {shown('dueOn') ? <span className="ban-error">{t('ban.att.directive.due.error')}</span> : null}
        </label>
      </div>
    </ConfirmDialog>
  );
}
