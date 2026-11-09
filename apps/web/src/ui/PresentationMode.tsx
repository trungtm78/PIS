import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import './presentation.css';

/** One board of a presentation: a title and the figures of it. A board holds no edit control; what a screen puts here is the read-only view of its figures. */
export interface PresentationBoard {
  id: string;
  title: string;
  content: ReactNode;
}

export interface PresentationModeProps {
  /** The name of the whole presentation (the label of the dialog). */
  title: string;
  boards: readonly PresentationBoard[];
  onExit: () => void;
  /** Seconds a board stays; one of `PRESENTATION_INTERVALS` (20 when left out). */
  intervalSeconds?: number;
}

/** The choices of the time a board stays, in seconds. */
export const PRESENTATION_INTERVALS = [10, 20, 30, 60] as const;
const DEFAULT_INTERVAL = 20;
/** The text sizes of a projector, in percent of the base size. */
export const PRESENTATION_SIZES = [100, 125, 150, 200] as const;
const INTERACTIVE = 'button, a, input, select, textarea, summary, [role="button"], [role="tab"]';

const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The element that is in full screen now, if the browser has the API at all. */
const fullscreenElement = (): Element | null => (typeof document === 'undefined' ? null : (document.fullscreenElement ?? null));

/** Asks the browser for full screen on the page; a refusal (no gesture, no API, a frame that may not) is not an error: the overlay already covers the window. */
async function enterFullscreen(): Promise<void> {
  const root = document.documentElement;
  if (typeof root.requestFullscreen !== 'function') return;
  // The overlay is the fallback: it fills the window whether or not the browser agreed.
  await Promise.resolve(root.requestFullscreen()).catch(() => undefined);
}

async function leaveFullscreen(): Promise<void> {
  if (fullscreenElement() === null || typeof document.exitFullscreen !== 'function') return;
  await Promise.resolve(document.exitFullscreen()).catch(() => undefined);
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/** Keeps the projector from going dark while the boards turn; a browser without the API simply lets the screen sleep as it always did. */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const wake = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (wake === undefined) return undefined;
    let sentinel: WakeLockSentinelLike | undefined;
    let cancelled = false;
    const take = (): void => {
      wake
        .request('screen')
        .then((lock) => {
          if (cancelled) void lock.release().catch(() => undefined);
          else sentinel = lock;
        })
        .catch(() => undefined);
    };
    take();
    // A hidden tab loses the lock by itself; it is asked for again when the tab is back.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') take();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

/**
 * Presentation mode (ENT-4d, BC.02 "trinh chieu truc tiep tai hop giao ban"): the boards of a dashboard one at a time over the whole window, in large type, for a projector in a meeting room. The boards turn by
 * themselves every few seconds and a person turns them by hand with the keyboard (arrows, page keys, Home, End, a digit; Space or P pauses; F full screen; Esc leaves). Nothing here edits anything: the overlay covers the
 * screen with its filters and buttons, and a board holds the figures only. For people: the automatic turning can always be paused and starts paused for a person who asked their system for reduced motion (WCAG 2.2.2);
 * the turn is announced politely; focus goes into the presentation and returns to the button that opened it; the type grows in steps up to twice the size; nothing depends on colour or on hover.
 */
export function PresentationMode({ title, boards, onExit, intervalSeconds = DEFAULT_INTERVAL }: PresentationModeProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(prefersReducedMotion);
  const [interval, setIntervalSeconds] = useState<number>(intervalSeconds);
  const [remaining, setRemaining] = useState<number>(intervalSeconds);
  const [size, setSize] = useState<number>(PRESENTATION_SIZES[1]);
  const [full, setFull] = useState(fullscreenElement() !== null);
  const [announce, setAnnounce] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const total = boards.length;
  const current = Math.min(index, Math.max(0, total - 1));
  const running = !paused && total > 1;

  const go = useCallback(
    (target: number): void => {
      if (total === 0) return;
      const next = ((target % total) + total) % total;
      setIndex(next);
      setRemaining(interval);
    },
    [total, interval],
  );

  // Focus goes into the presentation, the page behind it stops scrolling, and both are undone on the way out.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    document.documentElement.dataset.presenting = 'true';
    void enterFullscreen();
    return () => {
      delete document.documentElement.dataset.presenting;
      void leaveFullscreen();
      before?.focus();
    };
  }, []);

  useEffect(() => {
    const onChange = (): void => setFull(fullscreenElement() !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useWakeLock(true);

  // One second at a time: the count is visible, and a hidden tab does not turn boards nobody sees.
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setRemaining((left) => left - 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (running && remaining <= 0) go(current + 1);
  }, [running, remaining, go, current]);

  // The turn is told to a screen reader without moving its focus; the first board is not announced (the dialog's own label did).
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (announced.current !== null && announced.current !== current && boards[current] !== undefined) {
      setAnnounce(t('ui.presentation.announce.text', { index: current + 1, total, title: boards[current].title }));
    }
    announced.current = current;
  }, [current, boards, total, t]);

  const toggleFullscreen = (): void => {
    if (fullscreenElement() === null) void enterFullscreen();
    else void leaveFullscreen();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const onControl = event.target instanceof Element && event.target.closest(INTERACTIVE) !== null;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onExit();
        return;
      case 'ArrowRight':
      case 'PageDown':
      case 'n':
        if (onControl) return;
        event.preventDefault();
        go(current + 1);
        return;
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        go(current - 1);
        return;
      case 'Home':
        event.preventDefault();
        go(0);
        return;
      case 'End':
        event.preventDefault();
        go(total - 1);
        return;
      case ' ':
        // A button or a link keeps the meaning of Space it has.
        if (onControl) return;
        event.preventDefault();
        setPaused((value) => !value);
        return;
      case 'p':
        if (onControl) return;
        event.preventDefault();
        setPaused((value) => !value);
        return;
      case 'f':
        if (onControl) return;
        event.preventDefault();
        toggleFullscreen();
        return;
      case '+':
      case '=':
        if (onControl) return;
        event.preventDefault();
        setSize((value) => PRESENTATION_SIZES.find((step) => step > value) ?? value);
        return;
      case '-':
        if (onControl) return;
        event.preventDefault();
        setSize((value) => [...PRESENTATION_SIZES].reverse().find((step) => step < value) ?? value);
        return;
      default:
        if (!onControl && /^[1-9]$/.test(event.key) && Number(event.key) <= total) {
          event.preventDefault();
          go(Number(event.key) - 1);
        }
    }
  };

  const board = boards[current];
  return createPortal(
    <div
      ref={root}
      className="ui-present"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      data-testid="presentation"
      data-running={running ? 'true' : 'false'}
      style={{ ['--ui-present-scale' as string]: String(size / 100) }}
      onKeyDown={onKeyDown}
    >
      <header className="ui-present__bar">
        <h1 className="ui-present__title">{title}</h1>
        <div className="ui-present__controls" role="group" aria-label={t('ui.presentation.controls.label')}>
          <button type="button" className="ui-button ui-button--outline" onClick={() => go(current - 1)} disabled={total < 2}>
            {t('ui.presentation.previous.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" onClick={() => go(current + 1)} disabled={total < 2}>
            {t('ui.presentation.next.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" aria-pressed={paused} onClick={() => setPaused((value) => !value)} disabled={total < 2}>
            {paused ? t('ui.presentation.resume.action') : t('ui.presentation.pause.action')}
          </button>
          <label className="ui-present__interval">
            <span>{t('ui.presentation.interval.label')}</span>
            <select
              value={interval}
              onChange={(event) => {
                const seconds = Number(event.target.value);
                setIntervalSeconds(seconds);
                setRemaining(seconds);
              }}
            >
              {PRESENTATION_INTERVALS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t('ui.presentation.interval.option', { seconds })}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ui-button ui-button--outline" onClick={() => setSize((value) => [...PRESENTATION_SIZES].reverse().find((step) => step < value) ?? value)} disabled={size <= PRESENTATION_SIZES[0]}>
            {t('ui.presentation.smaller.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" onClick={() => setSize((value) => PRESENTATION_SIZES.find((step) => step > value) ?? value)} disabled={size >= Math.max(...PRESENTATION_SIZES)}>
            {t('ui.presentation.larger.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" aria-pressed={full} onClick={toggleFullscreen}>
            {t('ui.presentation.fullscreen.action')}
          </button>
          <button type="button" className="ui-button" onClick={onExit}>
            {t('ui.presentation.exit.action')}
          </button>
        </div>
      </header>
      <section className="ui-present__board" aria-labelledby="ui-present-board-title">
        {board === undefined ? (
          <p className="ui-present__empty" role="status">
            {t('ui.presentation.empty.text')}
          </p>
        ) : (
          <>
            <h2 id="ui-present-board-title" className="ui-present__board-title">
              {board.title}
            </h2>
            <div
              className="ui-present__content"
              data-board-id={board.id}
              // A link in a board only reads: a click, or Enter on a focused link, must not leave the presentation.
              onClickCapture={(event) => {
                if (event.target instanceof Element && event.target.closest('a') !== null) event.preventDefault();
              }}
            >
              {board.content}
            </div>
          </>
        )}
      </section>
      <footer className="ui-present__foot">
        <nav aria-label={t('ui.presentation.boards.label')} className="ui-present__dots">
          {boards.map((item, position) => (
            <button key={item.id} type="button" className="ui-present__dot" aria-current={position === current ? 'step' : undefined} aria-label={t('ui.presentation.goto.action', { index: position + 1, title: item.title })} onClick={() => go(position)} />
          ))}
        </nav>
        <p className="ui-present__status" data-testid="presentation-status">
          {total === 0 ? '' : t('ui.presentation.position.text', { index: current + 1, total })}
          {' · '}
          {paused ? t('ui.presentation.paused.text') : total > 1 ? t('ui.presentation.countdown.text', { seconds: Math.max(0, remaining) }) : ''}
        </p>
        <p className="ui-present__hint">{t('ui.presentation.keys.hint')}</p>
      </footer>
      <div className="ui-sr-only" role="status" aria-live="polite" data-testid="presentation-live">
        {announce}
      </div>
    </div>,
    document.body,
  );
}

/** The button that opens a presentation; the caller holds the open state and renders `PresentationMode` while it is true. */
export function PresentButton({ onOpen, disabled = false, testId = 'present-open', clipRef }: { onOpen: () => void; disabled?: boolean; testId?: string; clipRef?: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="ui-button ui-button--outline" onClick={onOpen} disabled={disabled} data-testid={testId} {...(clipRef === undefined ? {} : { 'data-clip-ref': clipRef })}>
      {t('ui.presentation.start.action')}
    </button>
  );
}
