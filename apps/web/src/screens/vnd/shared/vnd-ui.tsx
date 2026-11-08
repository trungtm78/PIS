import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { ContextBar, DeadlineCountdown, InfoFormula, StatusPill } from '../../../ui';
import { certificateStateLabel, clockLabel, infoLabels } from './vnd-labels';
import { PATHS, certificateIcon, certificateTone, clockIcon, clockOpen, clockTone, coverageWidth, vietnamDay, vietnamStamp, dayText } from './vnd-model';
import type { CertificateState, Clock, Coverage, Policy } from './vnd-model';
import './vnd.css';

// ---- the right to write: the server decides again, but a button the person may not press is not offered -------------------------------------------------------------------

export interface Writer {
  /** The membership holds the permission and the workspace is not read-only. */
  can: (permission: string) => boolean;
  readOnly: boolean;
}

export function useWriter(): Writer {
  const { permissions, mode } = useSession();
  const readOnly = mode === 'READ_ONLY';
  return { readOnly, can: (permission) => !readOnly && permissions?.includes(permission) === true };
}

/** The id a screen is opened with (`?contractor=`, `?case=`, `?event=`); the first name that is present wins, an empty value is none. */
export function useIdParam(...names: string[]): string | undefined {
  const [params] = useSearchParams();
  for (const name of names) {
    const value = params.get(name);
    if (value !== null && value.trim() !== '') return value.trim();
  }
  return undefined;
}

// ---- the page --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export function Screen({ route, children }: { route: WebRoute; children: ReactNode }) {
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {children}
    </section>
  );
}

export interface ScreenHeadProps {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  asOf?: string | undefined;
  stale?: boolean;
  items?: { label: string; value: string }[];
}

/** The three layers of the header of design.md: the title with one line of context, the scope bar with the time the data is as of. */
export function ScreenHead({ title, subtitle, actions, asOf, stale, items }: ScreenHeadProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
        {actions !== undefined && <div className="actions">{actions}</div>}
      </div>
      <ContextBar items={[{ label: t('vnd.context.scope.label'), value: tenant?.name ?? '–' }, ...(items ?? [])]} {...(asOf === undefined || asOf === '' ? {} : { asOf: vietnamStamp(asOf) })} stale={stale === true} />
    </>
  );
}

export function ScreenFooter({ route }: { route: WebRoute }) {
  const { t } = useTranslation();
  return <p className="prototype-note">{t('vnd.footer.reference', { id: route.id, req: route.req ?? '' })}</p>;
}

/** Said once on top of a screen of a read-only workspace: no command is offered. */
export function ReadOnlyNote({ show }: { show: boolean }) {
  const { t } = useTranslation();
  if (!show) return null;
  return (
    <p className="callout" data-testid="readonly-note">
      {t('vnd.readonly.mode.text')}
    </p>
  );
}

/** What a command did, said where the person looks: the words of the screen and the time. It is a status, read once. */
export function useReceipt(): { receipt: string | undefined; show: (text: string) => void; clear: () => void } {
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  return { receipt, show: setReceipt, clear: () => setReceipt(undefined) };
}

export function ReceiptNote({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <p className="callout vnd-receipt" role="status" data-testid="receipt">
      {text}
    </p>
  );
}

/** Part of a screen could not be read while the rest could: said in place with a retry, never as an empty part. */
export function PartialNotice({ text, onRetry, testId = 'partial-notice' }: { text: string; onRetry: () => void; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="callout vnd-partial" role="alert" data-testid={testId}>
      <span>{text}</span>{' '}
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('states.retry.action')}
      </button>
    </div>
  );
}

/** A refresh that failed while an older answer is still shown: said as stale, with the retry. */
export function StaleNotice({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return <PartialNotice text={t('vnd.stale.text')} onRetry={onRetry} testId="stale-notice" />;
}

// ---- figures ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export function UnverifiedPill() {
  const { t } = useTranslation();
  return (
    <StatusPill tone="warning" icon="⚠">
      {t('vnd.flag.unverified.badge')}
    </StatusPill>
  );
}

/** The "i" of a number that comes from a rule of governance: the formula, the source, the day it is as of, the version of the rule, and the flag when the rule is a starting value nobody confirmed. */
export function PolicyInfo({ name, policy }: { name: string; policy: Policy }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={policy.formula}
      source={policy.source}
      asOf={dayText(policy.as_of)}
      owner={t('vnd.info.owner.text')}
      version={`${policy.code} ${policy.version}`}
      unverified={policy.unverified}
      labels={infoLabels(t, name)}
    />
  );
}

/** The "i" of a plain count of the register: the formula and the source are the screen's own words. */
export function CountInfo({ name, formula, source, asOf, unverified = false }: { name: string; formula: string; source: string; asOf: string; unverified?: boolean }) {
  const { t } = useTranslation();
  return (
    <InfoFormula name={name} formula={formula} source={source} asOf={dayText(asOf)} owner={t('vnd.info.owner.text')} version={t('vnd.info.noVersion.text')} unverified={unverified} labels={infoLabels(t, name)} />
  );
}

/** A label with the "i" next to it (the table headers and the facts of a card carry their definition). */
export function WithInfo({ children, info }: { children: ReactNode; info: ReactNode }) {
  return (
    <span className="vnd-with-info">
      {children}
      {info}
    </span>
  );
}

// ---- pills and bars --------------------------------------------------------------------------------------------------------------------------------------------------------

/** The clock of a time limit: its state in words, and while it runs, how many days are left against the day of the answer (no seconds, no live region). */
export function ClockCell({ clock, dueAt, asOf }: { clock: Clock; dueAt: string; asOf: string }) {
  const { t } = useTranslation();
  return (
    <span className="vnd-stack" data-clock={clock}>
      <StatusPill tone={clockTone(clock)} icon={clockIcon(clock)}>
        {clockLabel(t, clock)}
      </StatusPill>
      {clockOpen(clock) && <DeadlineCountdown dueOn={vietnamDay(dueAt)} today={vietnamDay(asOf)} />}
    </span>
  );
}

/** The state of a certificate with the days left (or the days past): a pill with text, never a colour alone. */
export function CertificatePill({ state, daysLeft }: { state: CertificateState; daysLeft: number | null }) {
  const { t } = useTranslation();
  const days = daysLeft === null ? null : daysLeft >= 0 ? t('vnd.cert.daysLeft.text', { days: daysLeft }) : t('vnd.cert.daysOver.text', { days: -daysLeft });
  return (
    <span className="vnd-stack" data-state={state}>
      <StatusPill tone={certificateTone(state)} icon={certificateIcon(state)}>
        {certificateStateLabel(t, state)}
      </StatusPill>
      {days !== null && state !== 'REVOKED' && state !== 'NOT_STARTED' && <span className="vnd-days">{days}</span>}
    </span>
  );
}

/** How much of the required profile is present: a bar and a number, the missing fields named by the caller. */
export function CoverageBar({ coverage, label }: { coverage: Coverage; label: string }) {
  const percent = coverageWidth(coverage);
  return (
    <span className="vnd-coverage">
      <span className="vnd-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="vnd-bar__fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="vnd-coverage__pct">{percent}%</span>
    </span>
  );
}

export function ContractorLink({ id, name }: { id: string; name: string }) {
  return <Link to={PATHS.profile(id)}>{name}</Link>;
}

/** Previous and next page of a list that the server pages by a cursor (it gives no total, so there are no page numbers). */
export function CursorPager({ page, hasNext, onPrev, onNext }: { page: number; hasNext: boolean; onPrev: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="vnd-pager" aria-label={t('vnd.pager.nav.label')}>
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={page <= 0} onClick={onPrev}>
        {t('vnd.pager.prev.action')}
      </button>
      <span aria-current="page">{t('vnd.pager.page.text', { page: page + 1 })}</span>
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!hasNext} onClick={onNext}>
        {t('vnd.pager.next.action')}
      </button>
    </nav>
  );
}

/** One fact of a card: a label, its value, an optional "i". */
export function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="vnd-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Empty({ text, testId }: { text: string; testId?: string }) {
  return (
    <p className="vnd-none" {...(testId === undefined ? {} : { 'data-testid': testId })}>
      {text}
    </p>
  );
}
