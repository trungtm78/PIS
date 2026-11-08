/**
 * The Microsoft Teams channel of the notifications (WF-1): the reminders of the approval steps reach the approvers where they work. The platform never calls Teams: the delivery engine hands a message to the
 * adapter, which writes the card a relay of the operator picks up (a file in an outbox directory), so there is no network call, no token and no address in the platform. The destination is the channel account
 * (the Teams channel the tenant connected), never a person, so an address is not kept either.
 */

export const TEAMS_CHANNEL = 'TEAMS';
/** The name of the provider in the status items and the inbox: the outbox the relay reads. */
export const TEAMS_PROVIDER = 'teams-outbox';
/** The environment variable that names the outbox directory; with none the channel has no adapter (MISSING). */
export const TEAMS_OUTBOX_VARIABLE = 'MACHVON_TEAMS_OUTBOX_DIR';

const ADAPTIVE_CARD_TYPE = 'application/vnd.microsoft.card.adaptive';
const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const ADAPTIVE_CARD_VERSION = '1.4';
const MAX_TITLE = 200;
const MAX_TEXT = 10_000;

export interface TeamsCard {
  type: 'message';
  attachments: Array<{ contentType: string; contentUrl: null; content: Record<string, unknown> }>;
  /** What the relay needs to route and to send once: the channel account and the idempotency key of the message. */
  routing: { account_id: string; idempotency_key: string };
}

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

/** The adaptive card of a message: the subject as the heading and the text as the body. Pure: the same message makes the same card, which is what lets a repeated send be one file. */
export function teamsCardOf(message: { subject?: string | undefined; text: string; accountId: string; idempotencyKey: string }): TeamsCard {
  const body: Array<Record<string, unknown>> = [];
  if (message.subject !== undefined && message.subject.trim() !== '') body.push({ type: 'TextBlock', text: clip(message.subject.trim(), MAX_TITLE), weight: 'Bolder', size: 'Medium', wrap: true });
  body.push({ type: 'TextBlock', text: clip(message.text, MAX_TEXT), wrap: true });
  return {
    type: 'message',
    attachments: [{ contentType: ADAPTIVE_CARD_TYPE, contentUrl: null, content: { $schema: ADAPTIVE_CARD_SCHEMA, type: 'AdaptiveCard', version: ADAPTIVE_CARD_VERSION, body } }],
    routing: { account_id: message.accountId, idempotency_key: message.idempotencyKey },
  };
}
