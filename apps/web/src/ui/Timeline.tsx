import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import type { Translator } from '../i18n';
import { StatusPill } from './StatusPill';
import { toneClass } from './types';
import type { Tone, UiState } from './types';

export type TimelineKind = 'transition' | 'checklist' | 'hold' | 'return' | 'clock' | 'import' | 'note';

export interface TimelineEntry {
  id: string;
  /** The instant, ISO 8601. */
  at: string;
  kind: TimelineKind;
  /** What happened, already translated ("Completed item: Bid opening minutes"); a transition without a title reads "Moved from [from] → [to]". */
  title?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  actor?: { name: string; initials: string } | null | undefined;
  /** How long the thing had spent in the state it left ("after 6 days 2 hours in the previous step"), already translated. */
  after?: string | undefined;
  note?: string | undefined;
  evidence?: ReadonlyArray<{ label: string; href: string }> | undefined;
  tone?: Tone | undefined;
  /** The word of the severity badge of a clock event ("Overdue"), with the consequence in `note`. */
  badge?: string | undefined;
  /** An entry that was sent and is not confirmed yet. */
  pending?: boolean | undefined;
}

export interface TimelineGroup {
  /** The day, `YYYY-MM-DD` (Vietnam time). */
  date: string;
  entries: readonly TimelineEntry[];
}

export interface TimelineNotice {
  kind: 'partial' | 'stale' | 'denied';
  text: string;
}

export interface TimelineProps {
  groups: readonly TimelineGroup[];
  /** Collapse the days with no change between two days into one muted row. */
  gaps?: boolean | undefined;
  /** What the thing is waiting for in a gap row ("waiting for Bid evaluation"), already translated. */
  waitingLabel?: string | undefined;
  order?: 'desc' | 'asc' | undefined;
  onOrder?: ((order: 'desc' | 'asc') => void) | undefined;
  onSelectEntry?: ((id: string) => void) | undefined;
  state?: UiState | undefined;
  onRetry?: (() => void) | undefined;
  emptyKind?: 'none' | 'filtered' | undefined;
  notices?: readonly TimelineNotice[] | undefined;
  /** Today in Vietnam, `YYYY-MM-DD`, for the relative dates ("Today", "3 days ago"). */
  today?: string | undefined;
  caption: string;
}

const KIND_ICON: Readonly<Record<TimelineKind, string>> = { transition: '➜', checklist: '✓', hold: '⏸', return: '↩', clock: '⏱', import: '⇩', note: '✎' };
const KIND_TONE: Readonly<Record<TimelineKind, Tone>> = { transition: 'default', checklist: 'success', hold: 'neutral', return: 'warning', clock: 'danger', import: 'info', note: 'neutral' };
const DAY_MS = 86_400_000;
const NOTE_LIMIT = 90;

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (value: number): string => new Date(value * DAY_MS).toISOString().slice(0, 10);

function kindWord(t: Translator['t'], kind: TimelineKind): string {
  switch (kind) {
    case 'transition':
      return t('ui.timeline.kind.transition');
    case 'checklist':
      return t('ui.timeline.kind.checklist');
    case 'hold':
      return t('ui.timeline.kind.hold');
    case 'return':
      return t('ui.timeline.kind.return');
    case 'clock':
      return t('ui.timeline.kind.clock');
    case 'import':
      return t('ui.timeline.kind.import');
    case 'note':
      return t('ui.timeline.kind.note');
  }
}

function Entry({ entry, onSelect }: { entry: TimelineEntry; onSelect?: ((id: string) => void) | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const noteId = useId();
  // Vietnam has no daylight saving: the clock of the entry is the instant plus seven hours, written the same way in every locale.
  const time = new Date(Date.parse(entry.at) + 7 * 3_600_000).toISOString().slice(11, 16);
  const tone = entry.tone ?? KIND_TONE[entry.kind];
  const long = entry.note !== undefined && entry.note.length > NOTE_LIMIT;
  const heading: ReactNode =
    entry.title !== undefined ? (
      entry.title
    ) : (
      <>
        {t('ui.timeline.entry.from')}{' '}
        {entry.from !== undefined && <StatusPill tone="neutral">{entry.from}</StatusPill>}
        <span aria-hidden="true"> → </span>
        <span className="ui-sr-only">{t('ui.timeline.entry.to')}</span>
        {entry.to !== undefined && <StatusPill tone="default">{entry.to}</StatusPill>}
      </>
    );
  return (
    <li className={`ui-timeline__entry ${toneClass(tone)}${entry.pending === true ? ' is-pending' : ''}`} data-entry-id={entry.id} data-kind={entry.kind}>
      <time className="ui-timeline__time" dateTime={entry.at}>
        {time}
      </time>
      <span className="ui-timeline__icon" aria-hidden="true">
        {KIND_ICON[entry.kind]}
      </span>
      <div className="ui-timeline__body">
        <p className="ui-timeline__title">
          <span className="ui-sr-only">{kindWord(t, entry.kind)}: </span>
          {onSelect === undefined ? (
            heading
          ) : (
            <button type="button" className="ui-timeline__link" onClick={() => onSelect(entry.id)}>
              {heading}
            </button>
          )}
          {entry.badge !== undefined && (
            <StatusPill tone={tone} icon={KIND_ICON[entry.kind]}>
              {entry.badge}
            </StatusPill>
          )}
          {entry.pending === true && <span className="ui-timeline__pending">{t('ui.timeline.entry.pending')}</span>}
        </p>
        <p className="ui-timeline__meta">
          {entry.actor === null || entry.actor === undefined ? (
            <span className="ui-timeline__actor">
              <span className="ui-timeline__initials" aria-hidden="true">
                {t('ui.timeline.actor.systemInitials')}
              </span>
              {t('ui.timeline.actor.system')}
            </span>
          ) : (
            <span className="ui-timeline__actor">
              <span className="ui-timeline__initials" aria-hidden="true">
                {entry.actor.initials}
              </span>
              {entry.actor.name}
            </span>
          )}
          {entry.after !== undefined && <span className="ui-timeline__after">{entry.after}</span>}
        </p>
        {entry.note !== undefined && (
          <>
            <p className={`ui-timeline__note${open || !long ? '' : ' is-clamped'}`} id={noteId}>
              {entry.note}
            </p>
            {long && (
              <button type="button" className="ui-timeline__more" aria-expanded={open} aria-controls={noteId} onClick={() => setOpen((value) => !value)}>
                {open ? t('ui.timeline.entry.less') : t('ui.timeline.entry.more')}
              </button>
            )}
          </>
        )}
        {entry.evidence !== undefined && entry.evidence.length > 0 && (
          <ul className="ui-timeline__evidence" aria-label={t('ui.timeline.evidence.label')}>
            {entry.evidence.map((one) => (
              <li key={`${one.label}:${one.href}`}>
                <a className="ui-timeline__chip" href={one.href}>
                  {one.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * A day-by-day timeline (docs/process-tree-design.md section 7.3), generic for any record that changes state: contracts, projects, payments. Days come newest first (or oldest first), each with a sticky header that gives
 * the weekday, the date and the number of changes; an entry says when, what kind, from which state to which, who, how long the thing had spent in the state it left, why, and the evidence. Days with no change between two
 * days collapse into one muted row that says what the record was waiting for. The timeline is read-only: a correction is a new entry, never an edit.
 */
export function Timeline({ groups, gaps = true, waitingLabel, order, onOrder, onSelectEntry, state = 'ready', onRetry, emptyKind = 'none', notices = [], today, caption }: TimelineProps) {
  const { t, locale } = useTranslation();
  const [own, setOwn] = useState<'desc' | 'asc'>(order ?? 'desc');
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const direction = order ?? own;

  if (state === 'loading') {
    return (
      <div className="ui-timeline ui-timeline--loading" role="status" aria-busy="true" aria-label={t('ui.timeline.loading.label')}>
        {[0, 1].map((day) => (
          <div className="ui-timeline__skeleton-day" key={day}>
            <span className="ui-skeleton ui-skeleton--line ui-skeleton--short" />
            <span className="ui-skeleton ui-timeline__skeleton-row" />
            <span className="ui-skeleton ui-timeline__skeleton-row" />
          </div>
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="ui-timeline ui-timeline--message" role="alert">
        <span>{t('ui.timeline.error.message')}</span>
        {onRetry !== undefined && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        )}
      </div>
    );
  }
  const banners =
    notices.length > 0 ? (
      <div className="ui-timeline__notices">
        {notices.map((notice) => (
          <p className={`ui-timeline__notice ui-timeline__notice--${notice.kind}`} role="status" key={`${notice.kind}:${notice.text}`}>
            {notice.text}
          </p>
        ))}
      </div>
    ) : null;
  if (state === 'empty' || groups.length === 0) {
    return (
      <div className="ui-timeline ui-timeline--message" role="status">
        {banners}
        <span>{emptyKind === 'filtered' ? t('ui.timeline.empty.filtered') : t('ui.timeline.empty.none')}</span>
      </div>
    );
  }

  const sorted = [...groups].sort((left, right) => (direction === 'desc' ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date)));
  const dateText = (day: string): string => new Intl.DateTimeFormat(locale, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  const relative = (day: string): string | undefined => {
    if (today === undefined) return undefined;
    const ago = dayNumber(today) - dayNumber(day);
    if (ago === 0) return t('ui.timeline.day.today');
    if (ago === 1) return t('ui.timeline.day.yesterday');
    return ago > 1 ? t('ui.timeline.day.ago', { days: ago }) : undefined;
  };
  const choose = (next: 'desc' | 'asc'): void => {
    setOwn(next);
    onOrder?.(next);
  };

  const items: ReactNode[] = [];
  sorted.forEach((group, position) => {
    const previous = sorted[position - 1];
    if (gaps && previous !== undefined) {
      const quiet = Math.abs(dayNumber(previous.date) - dayNumber(group.date)) - 1;
      if (quiet > 0) {
        const first = direction === 'desc' ? dayNumber(previous.date) - 1 : dayNumber(previous.date) + 1;
        const step = direction === 'desc' ? -1 : 1;
        const key = `${previous.date}:${group.date}`;
        const isOpen = opened.has(key);
        items.push(
          <li className="ui-timeline__gap" key={`gap:${key}`}>
            <button
              type="button"
              className="ui-timeline__gap-button"
              aria-expanded={isOpen}
              onClick={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              {waitingLabel === undefined ? t('ui.timeline.gap.quiet', { days: quiet }) : t('ui.timeline.gap.waiting', { days: quiet, waiting: waitingLabel })}
            </button>
            {isOpen && (
              <ul className="ui-timeline__quiet-days">
                {Array.from({ length: quiet }, (_, offset) => {
                  const day = dayText(first + step * offset);
                  return (
                    <li key={day}>
                      <span>{dateText(day)}</span> · <span>{t('ui.timeline.gap.none')}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>,
        );
      }
    }
    const rel = relative(group.date);
    items.push(
      <li className="ui-timeline__day" key={group.date}>
        <h3 className="ui-timeline__day-head">
          <span>{dateText(group.date)}</span>
          {rel !== undefined && <span className="ui-timeline__relative">{rel}</span>}
          <span className="ui-timeline__count">{t('ui.timeline.day.changes', { count: group.entries.length })}</span>
        </h3>
        <ol className="ui-timeline__entries" aria-label={dateText(group.date)}>
          {group.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} onSelect={onSelectEntry} />
          ))}
        </ol>
      </li>,
    );
  });

  return (
    <div className="ui-timeline">
      {banners}
      <div className="ui-timeline__toolbar">
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={direction === 'asc'} onClick={() => choose(direction === 'desc' ? 'asc' : 'desc')}>
          {direction === 'desc' ? t('ui.timeline.order.oldest') : t('ui.timeline.order.newest')}
        </button>
      </div>
      <ol className="ui-timeline__days" aria-label={caption}>
        {items}
      </ol>
    </div>
  );
}
