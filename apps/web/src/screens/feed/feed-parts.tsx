import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenState } from '../../states/StateBoundary';
import { InfoFormula, StatusPill } from '../../ui';
import { channelLabel, infoLabels, problemText } from './feed-labels';
import { PATHS, shortHash, vietnamStamp } from './feed-model';
import type { Acceptance, Channel, Problem } from './feed-model';
import './feed.css';

export const DASH = '–';

export interface FigureProps {
  name: string;
  formula: string;
  source: string;
  asOf: string;
  owner?: string;
  version?: string;
  numerator?: string | undefined;
  denominator?: string | undefined;
  unverified?: boolean;
}

/** The "i" of a number: formula, source, the moment it is as of, the owner and the version of its definition. Every number of the five screens carries one. */
export function Figure({ name, formula, source, asOf, owner, version, numerator, denominator, unverified }: FigureProps) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={formula}
      source={source}
      asOf={asOf}
      owner={owner ?? t('feed.common.figure.owner.text')}
      version={version ?? t('feed.common.figure.noVersion.text')}
      numerator={numerator}
      denominator={denominator}
      unverified={unverified === true}
      labels={infoLabels(t, name)}
    />
  );
}

/** The word that the layout of the file is a working assumption (PENDING-EXTERNAL), in words and in a pill, never in colour alone. */
export function AcceptanceBadge({ acceptance }: { acceptance: Acceptance }) {
  const { t } = useTranslation();
  return acceptance === 'PENDING_EXTERNAL' ? (
    <span data-testid="acceptance-badge" data-acceptance={acceptance}>
      <StatusPill tone="warning" icon="⚠">
        {t('feed.common.acceptance.pending')}
      </StatusPill>
    </span>
  ) : (
    <span data-testid="acceptance-badge" data-acceptance={acceptance}>
      <StatusPill tone="success" icon="✓">
        {t('feed.common.acceptance.acceptable')}
      </StatusPill>
    </span>
  );
}

/** Where a record came from: a small provenance word, nothing more (every channel is judged and shown alike). */
export function ChannelTag({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  return (
    <small className="feed-channel" data-testid="channel-tag" data-channel={channel}>
      {channelLabel(t, channel)}
    </small>
  );
}

/** The links between the five screens. */
export function FeedLinks({ current }: { current: keyof typeof PATHS }) {
  const { t } = useTranslation();
  const links: Array<{ key: keyof typeof PATHS; label: string }> = [
    { key: 'connection', label: t('feed.common.link.connection') },
    { key: 'runs', label: t('feed.common.link.runs') },
    { key: 'mapping', label: t('feed.common.link.mapping') },
    { key: 'differences', label: t('feed.common.link.differences') },
    { key: 'generator', label: t('feed.common.link.generator') },
  ];
  return (
    <nav className="feed-links" aria-label={t('feed.common.link.group.label')}>
      {links
        .filter((link) => link.key !== current)
        .map((link) => (
          <Link key={link.key} to={PATHS[link.key]}>
            {link.label}
          </Link>
        ))}
    </nav>
  );
}

/** A refusal of a command, said in place; a changed version also offers the reload. */
export function ProblemNote({ problem, onReload }: { problem: Problem; onReload?: () => void }) {
  const { t } = useTranslation();
  const information = problem.kind === 'alreadyApplied';
  return (
    <div className={information ? 'callout' : 'callout warning'} role={information ? 'status' : 'alert'} data-testid="problem" data-problem={problem.kind} data-code={problem.code}>
      <p>{problemText(t, problem)}</p>
      {problem.kind === 'versionConflict' && onReload !== undefined && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
          {t('feed.common.problem.reload.action')}
        </button>
      )}
    </div>
  );
}

/** What a list says when it has nothing to show but a state: loading, a failure (with a new try), a refusal of the right, a lapsed session. A list with data returns null. */
export function ListState({ state, onRetry, empty }: { state: ScreenState; onRetry: () => void; empty?: ReactNode }) {
  const { t } = useTranslation();
  if (state === 'default') return null;
  if (state === 'loading') {
    return (
      <div className="feed-state" role="status" aria-busy="true" data-testid="loading" aria-label={t('feed.common.state.loading.label')}>
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }
  if (state === 'empty') return <>{empty}</>;
  if (state === 'denied') {
    return (
      <div className="feed-state feed-state--denied" role="alert" data-testid="denied">
        <h2>{t('feed.common.state.denied.title')}</h2>
        <p>{t('feed.common.state.denied.body')}</p>
      </div>
    );
  }
  const signedOut = state === 'signedOut' || state === 'expired';
  const offline = state === 'offline';
  return (
    <div className="feed-state feed-state--error" role="alert" data-testid="error" data-state={state}>
      <h2>{signedOut ? t('feed.common.state.signedOut.title') : offline ? t('feed.common.state.offline.title') : t('feed.common.state.error.title')}</h2>
      <p>{signedOut ? t('feed.common.state.signedOut.body') : offline ? t('feed.common.state.offline.body') : t('feed.common.state.error.body')}</p>
      <button type="button" className="ui-button ui-button--outline" onClick={onRetry}>
        {t('states.retry.action')}
      </button>
    </div>
  );
}

/** The refresh failed but the last answer is still shown: said above it with the moment it is as of, and a new try. */
export function StaleNote({ asOf, onRetry }: { asOf: string | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="callout warning" role="alert" data-testid="stale">
      <p>{asOf === null ? t('feed.common.state.stale.noTime') : t('feed.common.state.stale.text', { time: vietnamStamp(asOf) })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('states.retry.action')}
      </button>
    </div>
  );
}

export interface PagingProps {
  shown: number;
  hasMore: boolean;
  loadingMore: boolean;
  failedMore: boolean;
  onMore: () => void;
}

/** The foot of a paged list: how many are shown, a failed next page said in words, and the button for the next page. */
export function PagingFoot({ shown, hasMore, loadingMore, failedMore, onMore }: PagingProps) {
  const { t } = useTranslation();
  return (
    <div className="feed-more">
      <span className="sub" role="status" data-testid="shown">
        {t('feed.common.paging.summary', { shown })}
      </span>
      {failedMore && <span role="alert">{t('feed.common.paging.error')}</span>}
      {hasMore && (
        <button type="button" className="ui-button ui-button--outline" disabled={loadingMore} onClick={onMore}>
          {loadingMore ? t('feed.common.paging.loading') : t('feed.common.paging.more')}
        </button>
      )}
    </div>
  );
}

/** The first characters of a file hash with a button that copies the whole hash; the answer of the copy is said in words. */
export function HashCell({ hash }: { hash: string | null }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (hash === null) return <span>{DASH}</span>;
  const run = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <span className="feed-hash" data-testid="hash">
      <code title={hash}>{shortHash(hash)}</code>
      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('feed.common.hash.copy.label', { hash: shortHash(hash) })} onClick={() => void run()}>
        {t('feed.common.hash.copy.action')}
      </button>
      {copy === 'idle' ? null : (
        <small className="sub" role="status">
          {copy === 'copied' ? t('feed.common.hash.copied.text') : t('feed.common.hash.failed.text')}
        </small>
      )}
    </span>
  );
}
