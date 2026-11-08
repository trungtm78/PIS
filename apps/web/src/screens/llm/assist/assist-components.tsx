import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { ContextBar } from '../../../ui';
import { errorText, sourceKindLabel, sourceProblemText } from './assist-labels';
import { MAX_SOURCES, SOURCE_KINDS, addSource, failureCode, removeSource } from './assist-model';
import type { Citation, SourceKind, SourceProblem, SourceRef } from './assist-model';
import './assist.css';

export interface FieldProps {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

/** A labelled control with its hint and the sentence of its refusal; the control refers to both, so a reader of the screen hears them. */
export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="assist-field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : (
        <small className="sub" id={`${id}-hint`}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

/** What a control of a field refers to: its hint and its refusal when there is one. */
export const describedBy = (id: string, hint: boolean, error: boolean): string | undefined => {
  const ids = [...(hint ? [`${id}-hint`] : []), ...(error ? [`${id}-error`] : [])];
  return ids.length === 0 ? undefined : ids.join(' ');
};

/** The citations of a statement or of an item, folded: what each one is, where in it, and the words that support the statement (or the beginning of the part when it is a record). */
export function CitationList({ citations }: { citations: readonly Citation[] }) {
  const { t } = useTranslation();
  if (citations.length === 0) return null;
  return (
    <details className="assist-citations" data-testid="citations">
      <summary>{t('llm.assist.citation.summary', { count: citations.length })}</summary>
      <ul>
        {citations.map((citation, index) => (
          <li key={`${citation.kind}:${citation.id}:${citation.locator}:${index}`} data-testid="citation">
            <span className="assist-citation__source">
              {sourceKindLabel(t, citation.kind)}
              {citation.title === '' ? '' : ` · ${citation.title}`}
            </span>
            <span className="assist-citation__locator">{t('llm.assist.citation.locator', { locator: citation.locator })}</span>
            {citation.quote !== null ? (
              <blockquote>
                <span className="assist-citation__label">{t('llm.assist.citation.quote')}</span> {citation.quote}
              </blockquote>
            ) : citation.excerpt !== '' ? (
              <blockquote>
                <span className="assist-citation__label">{t('llm.assist.citation.excerpt')}</span> {citation.excerpt}
              </blockquote>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface SourcePickerProps {
  sources: readonly SourceRef[];
  onChange: (sources: SourceRef[]) => void;
  disabled?: boolean;
  /** The kinds the person may add; all four by default. */
  kinds?: readonly SourceKind[];
  legend: string;
  hint?: string;
}

/** The sources a question reads: each added by its kind and its id, listed with a way to take it out. At most twenty, none twice. */
export function SourcePicker({ sources, onChange, disabled = false, kinds = SOURCE_KINDS, legend, hint }: SourcePickerProps) {
  const { t } = useTranslation();
  const base = useId();
  const [kind, setKind] = useState<SourceKind>(kinds[0] ?? 'PROJECT');
  const [id, setId] = useState('');
  const [problem, setProblem] = useState<SourceProblem | undefined>(undefined);
  const add = (): void => {
    const result = addSource(sources, kind, id);
    setProblem(result.problem);
    if (result.problem === undefined) {
      onChange(result.list);
      setId('');
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  };
  return (
    <fieldset className="assist-sources" disabled={disabled} data-testid="source-picker">
      <legend>{legend}</legend>
      {hint === undefined ? null : <p className="sub">{hint}</p>}
      {sources.length === 0 ? (
        <p className="sub" data-testid="sources-none">
          {t('llm.assist.sources.none')}
        </p>
      ) : (
        <ul className="assist-sources__list" aria-label={legend}>
          {sources.map((source, position) => (
            <li key={`${source.kind}:${source.id}`} data-source-kind={source.kind} data-source-id={source.id}>
              <span>{sourceKindLabel(t, source.kind)}</span>
              <code>{source.id}</code>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onChange(removeSource(sources, position))}>
                {t('llm.assist.sources.remove', { id: source.id.slice(0, 8) })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="assist-sources__add">
        <Field id={`${base}-kind`} label={t('llm.assist.sources.kind')}>
          <select id={`${base}-kind`} value={kind} onChange={(event) => setKind(event.target.value as SourceKind)}>
            {kinds.map((entry) => (
              <option key={entry} value={entry}>
                {sourceKindLabel(t, entry)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${base}-id`} label={t('llm.assist.sources.id')} error={problem === undefined ? undefined : sourceProblemText(t, problem)}>
          <input id={`${base}-id`} value={id} autoComplete="off" spellCheck={false} aria-invalid={problem !== undefined} aria-describedby={describedBy(`${base}-id`, false, problem !== undefined)} onChange={(event) => setId(event.target.value)} onKeyDown={onKey} />
        </Field>
        <button type="button" className="ui-button ui-button--outline" onClick={add} disabled={sources.length >= MAX_SOURCES}>
          {t('llm.assist.sources.add')}
        </button>
      </div>
    </fieldset>
  );
}

export interface DetailDrawerProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** A panel at the right edge with the detail of a row: Escape closes it and returns focus to where it was opened from, Tab stays inside. */
export function DetailDrawer({ title, onClose, children }: DetailDrawerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => before?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <aside className="assist-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} ref={panel} onKeyDown={onKeyDown} data-testid="detail-drawer">
      <header className="assist-drawer__head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="ui-button ui-button--outline ui-button--small" ref={closeButton} onClick={onClose}>
          {t('llm.assist.drawer.close')}
        </button>
      </header>
      <div className="assist-drawer__body">{children}</div>
    </aside>
  );
}

/** A list of facts as a definition list. */
export function Facts({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="assist-facts">
      {items.map((item) => (
        <div className="assist-fact" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ScreenFrameProps {
  screenId: string;
  title: string;
  subtitle: string;
  /** More facts for the context line, after the scope. */
  context?: ReadonlyArray<{ label: string; value: string }>;
  asOf?: string | undefined;
  stale?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

/** The frame every screen of the assistant shares: the page title with one line of context, the scope bar and the screen id the tests and the flows find the screen by. */
export function ScreenFrame({ screenId, title, subtitle, context = [], asOf, stale = false, actions, children }: ScreenFrameProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  return (
    <section data-screen-id={screenId} aria-labelledby="screen-title" className="assist-screen">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
        {actions === undefined ? null : <div className="actions">{actions}</div>}
      </div>
      <ContextBar items={[{ label: t('llm.assist.context.scope'), value: tenant?.name ?? '–' }, ...context]} {...(asOf === undefined ? {} : { asOf })} stale={stale} />
      {children}
    </section>
  );
}

/** The part of a screen the membership may not read: it says so and leaks no name (the screen around it stays). */
export function SectionDenied({ what }: { what: string }) {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="section-denied">
      {t('llm.assist.state.denied', { what })}
    </p>
  );
}

/** A read that failed: it says which part failed and offers the retry in place. */
export function SectionFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="callout warning" role="alert" data-testid="section-failed">
      <p>{t('llm.assist.state.error', { what })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('llm.assist.state.retry')}
      </button>
    </div>
  );
}

/** The answer of a command that failed, told in words inside the screen (a refusal is never only in a log). */
export function SubmitFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="submit-failure" data-code={failureCode(error) ?? ''}>
      {errorText(t, error)}
    </p>
  );
}
