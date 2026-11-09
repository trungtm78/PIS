/**
 * What a web push may carry (R7, design.md, docs/not-push.md): a generic title and a link, nothing else. The server writes `{"v":1,"title":"...","url":"..."}`
 * and the worker reads it with the functions here, which drop every other member, so that even a server that put a name or a figure in the message could
 * not put it on a lock screen. The link is the opaque link of a notification (`/r/{id}`, which asks for the permission of the moment) or one of the start
 * pages of the manager application; it never names a record.
 */

/** The only links a push may open. The first is `OPAQUE_LINK` of the kernel (apps/api push port), repeated here because the worker bundle imports nothing from the server. */
export const OPAQUE_LINK = /^\/r\/[A-Za-z0-9_-]{16,64}$/;
export const MANAGER_START_PATHS: readonly string[] = ['/m', '/m/approvals', '/m/dashboard', '/m/directives'];
export const DEFAULT_LINK = '/m';

/** The longest title the worker shows: a lock screen shows a short, finished phrase. */
export const TITLE_MAX = 60;

/** The words that tell an amount, in the languages of the product (the Vietnamese ones are written with escapes: the source stays ASCII). A title that holds one is not generic. */
const MONEY_WORDS = /(?:vnd|vn\u0111|usd|\u0111\u1ed3ng|dong|t\u1ef7|ty\s|tri\u1ec7u|trieu|ngh\u00ecn|billion|million|thousand|\u20ab|\$)/i;
/** A mail address, a long number or a code of a record (`BC-2027-001`) tells which record it is. */
const IDENTIFYING = /(?:@|\d|[A-Z]{2,}-[A-Z0-9]+)/;

/** A title is generic when it is a short phrase with no digit, no code, no mail address and no word of money. */
export function isGenericTitle(title: unknown): title is string {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= TITLE_MAX && !IDENTIFYING.test(trimmed) && !MONEY_WORDS.test(trimmed);
}

/** The link a push opens: the opaque link of a notification or a start page of the manager application, else the start page. A link that names a record, carries a query, or leaves the origin is replaced. */
export function safeDeepLink(link: unknown): string {
  if (typeof link !== 'string') return DEFAULT_LINK;
  const trimmed = link.trim();
  if (OPAQUE_LINK.test(trimmed) || MANAGER_START_PATHS.includes(trimmed)) return trimmed;
  return DEFAULT_LINK;
}

export interface PushWords {
  /** The name of the product, the title of a push whose own title is not generic. */
  appName: string;
  /** The sentence under the title: it tells that something is waiting and nothing about what. */
  body: string;
}

export interface NotificationToShow {
  title: string;
  body: string;
  /** Where a tap goes. */
  url: string;
}

/**
 * The notification to show for the data of a push, whatever the data is: a text that is not JSON, a JSON that is not an object, a missing member or an
 * unsafe one all end in the product name, the sentence and the start page. The result has exactly three members, and the body is always the fixed sentence.
 */
export function notificationFromPush(data: string | undefined, words: PushWords): NotificationToShow {
  let parsed: unknown;
  try {
    parsed = data === undefined || data === '' ? undefined : JSON.parse(data);
  } catch {
    parsed = undefined;
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return {
    title: isGenericTitle(record.title) ? record.title.trim() : words.appName,
    body: words.body,
    url: safeDeepLink(record.url),
  };
}

/**
 * The receipt token a push may carry (`rcpt`): an opaque capability that lets the worker tell the server the notification was shown or opened. Only a string of the
 * exact size and alphabet of a token is taken (the server decides if it is valid), so nothing else can ride in this member.
 */
export const RECEIPT_LENGTH = 114;
export function receiptFromPush(data: string | undefined): string | undefined {
  try {
    const parsed: unknown = data === undefined || data === '' ? undefined : JSON.parse(data);
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).rcpt : undefined;
    return isReceipt(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export const isReceipt = (value: unknown): value is string => typeof value === 'string' && value.length === RECEIPT_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);

/** The data of the push of a notification, as the server writes it. */
export function pushDataOf(title: string, url: string, receipt?: string): string {
  return JSON.stringify({ v: 1, title: isGenericTitle(title) ? title.trim() : '', url: safeDeepLink(url), ...(isReceipt(receipt) ? { rcpt: receipt } : {}) });
}
