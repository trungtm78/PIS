import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, PickId, UUID_PATTERN, UnverifiedNote, asList, asRecord, num, refusalCode, text, useGovCommand, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Readonly<Record<string, Tone>> = { APPROVED: 'success', PROPOSED: 'warning', REJECTED: 'neutral', REQUESTED: 'warning' };

/**
 * PRJ-29, the lessons learned of a project and the closing gate (G1-19): lessons are proposed by one person and decided by another; when there is nothing to record a waiver with its reason is asked for and decided by a
 * person other than who asked. The gate says what is missing, and the project cannot be closed until it is met. The number of lessons and the waiver are the rule LESSONS_LEARNED_POLICY (not confirmed).
 */
export default function LessonsScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const raw = search.get('id') ?? '';
  const id = UUID_PATTERN.test(raw) ? raw : undefined;
  const query = useGovRead('prj', 'listLessons', id === undefined ? undefined : { path: { id } }, id !== undefined);
  if (id === undefined) return <PickId route={route} title={t('gov11.lessons.title')} subtitle={t('gov11.lessons.subtitle')} raw={raw} onPick={(picked) => setSearch({ id: picked })} />;
  return (
    <Frame
      route={route}
      title={t('gov11.lessons.title')}
      subtitle={t('gov11.lessons.subtitle')}
      scope={[
        { label: t('gov11.common.scope'), value: tenant?.name ?? '–' },
        { label: t('gov11.lessons.project'), value: text(asRecord(query.data?.project).code) },
      ]}
      query={query}
      notice={<UnverifiedNote rules={[asRecord(query.data?.rule) as unknown as RuleReading]} />}
    >
      {(data) => <Lessons projectId={id} data={data} />}
    </Frame>
  );
}

function Lessons({ projectId, data }: { projectId: string; data: Record<string, unknown> }) {
  const { t } = useTranslation();
  const rule = asRecord(data.rule) as unknown as RuleReading;
  const gate = asRecord(data.gate);
  const params = asRecord(rule.params);
  const categories = Array.isArray(params.categories) ? (params.categories as string[]) : ['OTHER'];
  const lessons = asList(data.lessons);
  const waiver = data.waiver === null ? null : asRecord(data.waiver);
  const propose = useGovCommand('proposeLesson');
  const decide = useGovCommand('decideLesson');
  const ask = useGovCommand('requestLessonWaiver');
  const decideWaiver = useGovCommand('decideLessonWaiver');
  const [form, setForm] = useState({ category: categories[0] ?? 'OTHER', title: '', situation: '', recommendation: '' });
  const [reason, setReason] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const failure = [propose, decide, ask, decideWaiver].find((command) => command.isError);
  const reasonLabel = (value: string): string => {
    switch (value) {
      case 'APPROVED_LESSONS':
        return t('gov11.lessons.gate.approved');
      case 'WAIVER_APPROVED':
        return t('gov11.lessons.gate.waiver');
      case 'PENDING_REVIEW':
        return t('gov11.lessons.gate.pending');
      case 'WAIVER_PENDING':
        return t('gov11.lessons.gate.waiverPending');
      case 'NOT_REQUIRED':
        return t('gov11.lessons.gate.notRequired');
      default:
        return t('gov11.lessons.gate.missing');
    }
  };
  const statusLabel = (value: string): string => (value === 'APPROVED' ? t('gov11.lessons.status.approved') : value === 'REJECTED' ? t('gov11.lessons.status.rejected') : value === 'REQUESTED' ? t('gov11.lessons.status.requested') : t('gov11.lessons.status.proposed'));
  const done = (what: string): void => setReceipt(what);
  const decision = (command: typeof decide, row: Record<string, unknown>, value: 'APPROVE' | 'REJECT'): void => {
    const note = value === 'REJECT' ? rejectNote : null;
    if (value === 'REJECT' && (note === null || note.trim().length < 10)) return;
    command.mutate({ path: { id: text(row.id) }, body: { decision: value, ...(note === null ? {} : { note: note.trim() }) }, version: num(row.version) }, { onSuccess: () => done(value === 'APPROVE' ? t('gov11.lessons.what.approved') : t('gov11.lessons.what.rejected')) });
  };
  return (
    <div className="gov11-grid">
      {receipt !== undefined && (
        <p className="callout" role="status" data-testid="receipt">
          {t('gov11.lessons.receipt', { what: receipt })}
        </p>
      )}
      {failure !== undefined && (
        <p role="alert" data-testid="command-error">
          {refusalCode(failure.error) === 'SELF_APPROVAL_DENIED'
            ? t('gov11.lessons.error.self')
            : refusalCode(failure.error) === 'VERSION_CONFLICT'
              ? t('gov11.lessons.error.conflict')
              : refusalCode(failure.error) === 'LESSON_STATE_INVALID'
                ? t('gov11.lessons.error.state')
                : t('gov11.lessons.error.other')}
        </p>
      )}
      <div className="gov11-row">
        <Figure label={t('gov11.lessons.gate')} value={gate.met === true ? t('gov11.lessons.gate.met') : t('gov11.lessons.gate.notMet')} tone={gate.met === true ? 'success' : 'danger'} sub={reasonLabel(text(gate.reason))} rule={rule} fallbackFormula={t('gov11.lessons.gate.formula')} owner={t('gov11.lessons.owner')} asOf={projectId.slice(0, 8)} />
        <Figure label={t('gov11.lessons.count')} value={`${text(num(gate.approved))} / ${text(num(gate.required))}`} rule={rule} fallbackFormula={t('gov11.lessons.count.formula')} owner={t('gov11.lessons.owner')} asOf={projectId.slice(0, 8)} />
      </div>
      <label>
        {t('gov11.lessons.rejectNote')}
        <textarea value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} data-testid="reject-note" />
      </label>
      <section aria-labelledby="list-title" data-testid="lessons">
        <h2 id="list-title">{t('gov11.lessons.list')}</h2>
        {lessons.length === 0 ? (
          <p data-testid="lessons-empty">{t('gov11.lessons.none')}</p>
        ) : (
          <ul>
            {lessons.map((lesson) => (
              <li key={text(lesson.id)} data-testid={`lesson-${text(lesson.id)}`}>
                <strong>{text(lesson.title)}</strong> <StatusPill tone={TONE[text(lesson.status)] ?? 'neutral'}>{statusLabel(text(lesson.status))}</StatusPill>
                <p>{`${text(lesson.category)} · ${text(lesson.situation)}`}</p>
                <p>{text(lesson.recommendation)}</p>
                {lesson.status === 'PROPOSED' && (
                  <div className="gov11-row">
                    <button type="button" className="ui-button ui-button--primary" disabled={decide.isPending} data-testid={`approve-${text(lesson.id)}`} onClick={() => decision(decide, lesson, 'APPROVE')}>
                      {t('gov11.lessons.approve')}
                    </button>
                    <button type="button" className="ui-button ui-button--outline" disabled={decide.isPending || rejectNote.trim().length < 10} onClick={() => decision(decide, lesson, 'REJECT')}>
                      {t('gov11.lessons.reject')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <form
        className="gov11-form"
        data-testid="propose-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          propose.mutate({ path: { id: projectId }, body: form }, { onSuccess: () => { setForm({ ...form, title: '', situation: '', recommendation: '' }); done(t('gov11.lessons.what.proposed')); } });
        }}
      >
        <h2>{t('gov11.lessons.propose')}</h2>
        <label>
          {t('gov11.lessons.field.category')}
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {categories.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('gov11.lessons.field.title')}
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} data-testid="field-title" />
        </label>
        <label>
          {t('gov11.lessons.field.situation')}
          <textarea value={form.situation} onChange={(event) => setForm({ ...form, situation: event.target.value })} data-testid="field-situation" />
        </label>
        <label>
          {t('gov11.lessons.field.recommendation')}
          <textarea value={form.recommendation} onChange={(event) => setForm({ ...form, recommendation: event.target.value })} data-testid="field-recommendation" />
        </label>
        <button type="submit" className="ui-button ui-button--primary" disabled={propose.isPending} data-testid="propose-submit">
          {propose.isPending ? t('gov11.common.sending') : t('gov11.lessons.submit')}
        </button>
      </form>
      <section aria-labelledby="waiver-title" data-testid="waiver">
        <h2 id="waiver-title">{t('gov11.lessons.waiver')}</h2>
        {waiver !== null && (
          <div>
            <StatusPill tone={TONE[text(waiver.status)] ?? 'neutral'}>{statusLabel(text(waiver.status))}</StatusPill>
            <p>{text(waiver.reason)}</p>
            {waiver.status === 'REQUESTED' && (
              <div className="gov11-row">
                <button type="button" className="ui-button ui-button--primary" disabled={decideWaiver.isPending} data-testid="waiver-approve" onClick={() => decision(decideWaiver, waiver, 'APPROVE')}>
                  {t('gov11.lessons.approve')}
                </button>
                <button type="button" className="ui-button ui-button--outline" disabled={decideWaiver.isPending || rejectNote.trim().length < 10} onClick={() => decision(decideWaiver, waiver, 'REJECT')}>
                  {t('gov11.lessons.reject')}
                </button>
              </div>
            )}
          </div>
        )}
        {(waiver === null || waiver.status === 'REJECTED') && params.allow_waiver === true && (
          <form
            className="gov11-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              ask.mutate({ path: { id: projectId }, body: { reason } }, { onSuccess: () => { setReason(''); done(t('gov11.lessons.what.asked')); } });
            }}
          >
            <label>
              {t('gov11.lessons.field.reason')}
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} data-testid="field-reason" />
            </label>
            <button type="submit" className="ui-button ui-button--outline" disabled={ask.isPending} data-testid="waiver-submit">
              {ask.isPending ? t('gov11.common.sending') : t('gov11.lessons.askWaiver')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
