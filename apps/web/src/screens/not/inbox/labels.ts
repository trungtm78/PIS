import { ApiError } from '@machvon/api-client';
import { hasMessage } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import { isUnavailable, needsAction } from './model';
import type { NotificationItem } from './model';

type Translate = Translator['t'];

/**
 * What a notification is called: the translation of the event type's title key when the catalogue has it (a module owner
 * adds it when it registers the event type), a neutral title when it does not, and the unavailable title when the member
 * lost access to the record. The server's key is never shown as text.
 */
export function titleOf(t: Translate, item: NotificationItem): string {
  if (isUnavailable(item)) return t('notification.content.unavailable.title');
  return hasMessage(item.title) ? t(item.title) : t('not.inbox.item.fallback.title');
}

export function priorityLabel(t: Translate, priority: string): string {
  switch (priority) {
    case 'CRITICAL':
      return t('not.inbox.priority.critical.label');
    case 'HIGH':
      return t('not.inbox.priority.high.label');
    case 'LOW':
      return t('not.inbox.priority.low.label');
    default:
      return t('not.inbox.priority.normal.label');
  }
}

/** The category line of a row: "needs action" while an acknowledgement is due, otherwise the priority. */
export function categoryOf(t: Translate, item: NotificationItem): string {
  return needsAction(item) ? t('not.inbox.row.action.badge') : priorityLabel(t, item.priority);
}

/** The prototype's colour tones: amber for what needs the member, neutral for the rest. */
export function toneOf(item: NotificationItem): 'amber' | 'neutral' {
  return needsAction(item) || item.priority === 'CRITICAL' ? 'amber' : 'neutral';
}

/** The tone of the pill of a notification: an act due or a critical one is a warning, a high priority is told as one too, the rest is plain. Always read with its text. */
export function pillToneOf(item: NotificationItem): Tone {
  if (item.priority === 'CRITICAL') return 'danger';
  if (needsAction(item) || item.priority === 'HIGH') return 'warning';
  return 'neutral';
}

/** The glyph in the round symbol of a row. */
export const symbolOf = (item: NotificationItem): string => (needsAction(item) ? '✓' : '◇');

/** The message of a failed acknowledgement, by the server's code; nothing else of the answer is shown. */
export function acknowledgeError(t: Translate, error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'ACK_NOT_REQUIRED') return t('not.detail.error.ackNotRequired');
  if (code === 'NOTIFICATION_EXPIRED') return t('not.detail.error.expired');
  return t('not.detail.error.generic');
}
