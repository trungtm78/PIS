import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AcceptForm } from './EscalationForms';
import { acceptStateOf, countByLevel, filterBreaches } from './escalation-model';
import type { BreachView, LevelFilter } from './escalation-model';
import { useBreaches } from './hooks';
import { SeverityBadge, useMoment } from './issue-components';
import { statusLabel } from './issue-labels';
import { ESCALATION_LEVELS, workspaceLink } from './issue-model';
import type { EscalationLevel } from './issue-model';
import './iss.css';

const NEVER_EMPTY = (): boolean => false;

function levelName(t: ReturnType<typeof useTranslation>['t'], level: EscalationLevel): string {
  switch (level) {
    case 1:
      return t('iss.escalation.level1.option');
    case 2:
      return t('iss.escalation.level2.option');
    case 3:
      return t('iss.escalation.level3.option');
  }
}

/**
 * ISS-10: the escalations that wait for their receiver, by level: the unit, the person who answers for the project, the task force. Each card says
 * who it is addressed to, by when it has to be accepted, since when the issue has been overdue and whether the signed-in person may accept it. An
 * escalation never closes the original issue: it is a call for attention, and accepting it puts the issue back to work.
 */
export default function EscalationBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What the board shows depends on the membership that is signed in (a unit it answers for, a task force it belongs to): a switch starts it over.
  return <EscalationBoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EscalationBoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [level, setLevel] = useState<LevelFilter>('');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = mode !== 'READ_ONLY';
  // The whole board is read once and narrowed on the screen, so the counts of the other levels stay true.
  const breaches = useBreaches('');
  const state = useScreenState({ isLoading: breaches.isLoading, error: breaches.error, data: breaches.data, isEmpty: NEVER_EMPTY });
  const counts = useMemo(() => countByLevel(breaches.data ?? []), [breaches.data]);
  const shown = useMemo(() => filterBreaches(breaches.data ?? [], level), [breaches.data, level]);
  const now = new Date();
  const levels = level === '' ? ESCALATION_LEVELS : ESCALATION_LEVELS.filter((candidate) => String(candidate) === level);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.board.page.title')}</h1>
          <p>{t('iss.board.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void breaches.refetch()}>
        <div className="card">
          {notice === undefined ? null : (
            <p className="callout" role="status" data-testid="done">
              {notice}
            </p>
          )}
          <form className="iss-filters" role="search" aria-label={t('iss.board.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="board-level">{t('iss.board.level.label')}</label>
              <select id="board-level" value={level} onChange={(event) => setLevel(event.target.value as LevelFilter)}>
                <option value="">{t('iss.board.level.all')}</option>
                {ESCALATION_LEVELS.map((candidate) => (
                  <option key={candidate} value={String(candidate)}>
                    {levelName(t, candidate)} ({counts[candidate]})
                  </option>
                ))}
              </select>
            </div>
          </form>
          <p className="sub" data-testid="count" role="status">
            {t('iss.board.count.text', { count: shown.length })}
          </p>
          {(breaches.data ?? []).length === 0 ? (
            <p className="muted" data-testid="empty-board">
              {t('iss.board.empty.text')}
            </p>
          ) : (
            <div className="iss-board" data-testid="board">
              {levels.map((candidate) => {
                const lines = shown.filter((line) => line.level === candidate);
                return (
                  <section key={candidate} className="iss-column" aria-labelledby={`level-${candidate}`} data-level={candidate}>
                    <h2 id={`level-${candidate}`}>
                      {levelName(t, candidate)} ({lines.length})
                    </h2>
                    {lines.length === 0 ? <p className="sub">{t('iss.board.column.empty')}</p> : lines.map((line) => <BreachCard key={line.escalationId} line={line} now={now} live={live} onDone={setNotice} />)}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('iss.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function BreachCard({ line, now, live, onDone }: { line: BreachView; now: Date; live: boolean; onDone: (notice: string) => void }) {
  const { t } = useTranslation();
  const moment = useMoment();
  const state = acceptStateOf(line, now);
  const target = line.taskForce !== null ? `${line.taskForce.code} · ${line.taskForce.name}` : (line.targetUnit?.name ?? t('iss.value.none.text'));
  return (
    <article className="iss-card" data-escalation-id={line.escalationId} data-status={line.status}>
      <p>
        <Link to={workspaceLink(line.issueId)}>{line.issueCode}</Link> <SeverityBadge severity={line.severity} />
      </p>
      {line.issueTitle === null ? null : <p>{line.issueTitle}</p>}
      <p className="sub">
        {line.projectCode} · {line.ownerUnitName} · {statusLabel(t, line.issueStatus)}
      </p>
      <p>{t('iss.board.target.text', { target })}</p>
      <p className={state === 'late' ? 'iss-badge warning' : 'sub'} data-testid="accept-state" data-state={state}>
        {state === 'accepted'
          ? t('iss.board.accepted.text', { date: moment(line.acceptedAt) })
          : state === 'late'
            ? t('iss.board.late.text', { date: moment(line.acceptDueAt) })
            : t('iss.board.waiting.text', { date: moment(line.acceptDueAt) })}
      </p>
      <p className="sub">
        {line.overdueSince === null
          ? t('iss.board.notOverdue.text')
          : line.overdueDays === null
            ? t('iss.board.overdueUnknown.text', { date: moment(line.overdueSince) })
            : t('iss.board.overdue.text', { date: moment(line.overdueSince), count: line.overdueDays })}
      </p>
      {line.acceptable && live ? <AcceptForm escalationId={line.escalationId} onDone={onDone} /> : null}
    </article>
  );
}
