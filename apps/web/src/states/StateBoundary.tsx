import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import type { Translator } from '../i18n';

/**
 * The seven standard UI states of every screen (06_UI_UX_Design_System.md, 04_Design_Assets/states) and `signedOut`, the
 * lapsed session: the mockup's `expired` is the SaaS state of an expired license, so a lapsed session is its own state
 * (same card, its own wording) until the sign-in screens of IAM-01 exist.
 */
export type ScreenState = 'default' | 'loading' | 'empty' | 'error' | 'denied' | 'expired' | 'signedOut' | 'offline';

type MessageState = Exclude<ScreenState, 'default' | 'loading'>;

// The glyphs of the prototype's state() cards; roles follow urgency (a failure interrupts, an empty list informs).
const GLYPH: Readonly<Record<MessageState, string>> = { empty: '○', error: '!', denied: '⌁', offline: '⌁', expired: '◷', signedOut: '◷' };
const ROLE: Readonly<Record<MessageState, 'alert' | 'status'>> = {
  empty: 'status',
  error: 'alert',
  denied: 'alert',
  expired: 'alert',
  signedOut: 'alert',
  offline: 'status',
};
const SKELETON_ROWS = 7;

/** The title and body of a message state; each key is written out so the i18n check can see it is in use. */
function messageOf(t: Translator['t'], state: MessageState): { title: string; body: string } {
  switch (state) {
    case 'empty':
      return { title: t('states.empty.title'), body: t('states.empty.body') };
    case 'error':
      return { title: t('states.error.title'), body: t('states.error.body') };
    case 'denied':
      return { title: t('states.denied.title'), body: t('states.denied.body') };
    case 'expired':
      return { title: t('states.expired.title'), body: t('states.expired.body') };
    case 'signedOut':
      return { title: t('states.signedOut.title'), body: t('states.signedOut.body') };
    case 'offline':
      return { title: t('states.offline.title'), body: t('states.offline.body') };
  }
}

export interface StateBoundaryProps {
  state: ScreenState;
  onRetry?: () => void;
  children?: ReactNode;
}

/** Shows the screen content only in the default state; every other state replaces it with the standard card. */
export function StateBoundary({ state, onRetry, children }: StateBoundaryProps) {
  const { t } = useTranslation();
  if (state === 'default') return <>{children}</>;
  if (state === 'loading') {
    return (
      <div className="card" role="status" aria-busy="true" aria-label={t('states.loading.label')}>
        {/* Text for the reader of the page and for any check of an empty page: the bars alone say nothing. */}
        <span className="sr-only">{t('states.loading.label')}</span>
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div className="skeleton" key={row} />
        ))}
      </div>
    );
  }
  const message = messageOf(t, state);
  return (
    <div className="card statecard" role={ROLE[state]}>
      <div className="stateicon" aria-hidden="true">
        {GLYPH[state]}
      </div>
      <h1>{message.title}</h1>
      <p className="muted">{message.body}</p>
      {onRetry === undefined ? null : (
        <button type="button" className="primary" onClick={onRetry}>
          {t('states.retry.action')}
        </button>
      )}
    </div>
  );
}
