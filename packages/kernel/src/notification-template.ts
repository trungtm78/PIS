import { DomainError } from './errors.ts';
import { LOCK_SCREEN_MAX } from './push-port.ts';

/**
 * The rules of a message template (ST-NOT-005, NOT 3.4, BR-NOT-10, BR-NOT-11), judged before anything is stored or sent:
 *  - `content_ast` is `{ subject?, body }` with `{{name}}` placeholders; a placeholder the template does not declare is a broken message (422 TEMPLATE_INVALID);
 *  - `variable_schema` declares each variable with a `type` (string, number, integer, boolean or money) and a `classification` (PUBLIC, INTERNAL, CONFIDENTIAL, PERSONAL);
 *  - the channels that reach a phone or an outside provider (push, SMS, Zalo, WhatsApp) carry only PUBLIC or INTERNAL variables that are not money
 *    (422 TEMPLATE_VARIABLE_CLASSIFIED), so nothing classified shows on a lock screen or travels through a provider;
 *  - a push template is lock-screen safe, or it is refused (the database refuses it as well), and it is a neutral sentence: it uses no variable at all and fits a lock screen (120 characters) (ST-NOT-007).
 * Pure, so the screen and the tests judge a template the way the server does.
 */
export const TEMPLATE_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_ZNS', 'ZALO_OA', 'WHATSAPP', 'TEAMS'] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];
export const TEMPLATE_LOCALES = ['vi-VN', 'en-US'] as const;
export const TEMPLATE_PURPOSES = ['OPERATIONAL', 'SECURITY', 'REMINDER', 'ANNOUNCEMENT', 'DIGEST', 'SUPPORT_CONVERSATION'] as const;
export const VARIABLE_TYPES = ['string', 'number', 'integer', 'boolean', 'money'] as const;
export const VARIABLE_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const;
export type VariableClassification = (typeof VARIABLE_CLASSIFICATIONS)[number];

/** The channels that reach a phone or an outside provider: the content on them is seen by people and systems the tenant does not control. */
export const RESTRICTED_CHANNELS: ReadonlySet<string> = new Set(['PUSH_FCM', 'PUSH_APNS', 'SMS', 'ZALO_ZNS', 'ZALO_OA', 'WHATSAPP']);
/** The channels whose templates the provider approves (BR-NOT-10). */
export const PROVIDER_CHANNELS: ReadonlySet<string> = new Set(['ZALO_ZNS', 'WHATSAPP']);
export const isPush = (channel: string): boolean => channel === 'PUSH_FCM' || channel === 'PUSH_APNS';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,59})\s*\}\}/g;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;
const MAX_VARIABLES = 50;
const MAX_SAMPLE_LENGTH = 500;

export interface TemplateVariable {
  type: (typeof VARIABLE_TYPES)[number];
  classification: VariableClassification;
}

export interface TemplateInput {
  channel: string;
  contentAst: unknown;
  variableSchema: unknown;
  lockscreenSafe: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(detail: string): DomainError {
  return new DomainError('TEMPLATE_INVALID', 422, detail);
}

/** The variables a template declares, each with its type and classification; one that has neither is refused. */
export function declaredVariables(variableSchema: unknown): Map<string, TemplateVariable> {
  if (!isRecord(variableSchema)) throw invalid('variable_schema');
  const properties = variableSchema.properties;
  if (properties === undefined) return new Map();
  if (!isRecord(properties) || Object.keys(properties).length > MAX_VARIABLES) throw invalid('variable_schema.properties');
  const declared = new Map<string, TemplateVariable>();
  for (const [name, raw] of Object.entries(properties)) {
    if (!VARIABLE_NAME.test(name) || !isRecord(raw)) throw invalid('variable_schema.properties');
    const type = raw.type;
    const classification = raw.classification;
    if (typeof type !== 'string' || !(VARIABLE_TYPES as readonly string[]).includes(type)) throw invalid(`variable_schema.${name}.type`);
    if (typeof classification !== 'string' || !(VARIABLE_CLASSIFICATIONS as readonly string[]).includes(classification)) throw invalid(`variable_schema.${name}.classification`);
    declared.set(name, { type: type as TemplateVariable['type'], classification: classification as VariableClassification });
  }
  return declared;
}

/** The placeholders a text uses, in order of appearance, once each. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];
}

const TEMPLATE_CODE = /^[a-z0-9_.-]{3,80}$/;

/** The code, the locale and the purpose of a revision: the code is a name of lower case letters, digits, dots, hyphens and underscores; the locale and the purpose are ones the platform knows. */
export function assertTemplateIdentity(input: { code: string; locale: string; purpose: string }): void {
  if (!TEMPLATE_CODE.test(input.code)) throw invalid('code');
  if (!(TEMPLATE_LOCALES as readonly string[]).includes(input.locale)) throw invalid('locale');
  if (!(TEMPLATE_PURPOSES as readonly string[]).includes(input.purpose)) throw invalid('purpose');
}

/** Judges a template as it is written; the answer is the first defect (422), naming the field or the variable and never its value. */
export function assertTemplateAllowed(input: TemplateInput): void {
  if (!(TEMPLATE_CHANNELS as readonly string[]).includes(input.channel)) throw invalid('channel');
  if (!isRecord(input.contentAst) || typeof input.contentAst.body !== 'string' || input.contentAst.body.trim() === '' || input.contentAst.body.length > MAX_BODY) throw invalid('content_ast.body');
  const allowedKeys = input.channel === 'EMAIL' ? ['subject', 'body'] : ['body'];
  for (const key of Object.keys(input.contentAst)) if (!allowedKeys.includes(key)) throw invalid(`content_ast.${key}`);
  const subject = input.contentAst.subject;
  if (subject !== undefined && (typeof subject !== 'string' || subject.trim() === '' || subject.length > MAX_SUBJECT)) throw invalid('content_ast.subject');
  const declared = declaredVariables(input.variableSchema);
  const used = placeholdersOf(input.contentAst.body + ' ' + (typeof subject === 'string' ? subject : ''));
  for (const name of used) if (!declared.has(name)) throw invalid(`content_ast.${name}`);
  if (RESTRICTED_CHANNELS.has(input.channel)) {
    for (const name of used) {
      const variable = declared.get(name) as TemplateVariable;
      if (variable.type === 'money' || variable.classification === 'CONFIDENTIAL' || variable.classification === 'PERSONAL') {
        throw new DomainError('TEMPLATE_VARIABLE_CLASSIFIED', 422, `variable_schema.${name}`);
      }
    }
  }
  // A push is a neutral sentence (ST-NOT-007): whatever its variables are, they are not shown on a lock screen, so it uses none. Judged after the classification, so a figure is still told as classified.
  if (isPush(input.channel) && used.length > 0) throw invalid(`content_ast.${used[0]}`);
  // The last look before the provider refuses a longer text for good (`LOCKSCREEN_UNSAFE`), so a template that could never be sent is refused here.
  if (isPush(input.channel) && input.contentAst.body.length > LOCK_SCREEN_MAX) throw invalid('content_ast.body');
  if (isPush(input.channel) && !input.lockscreenSafe) throw invalid('lockscreen_safe');
  if (!isPush(input.channel) && input.lockscreenSafe) throw invalid('lockscreen_safe');
}

/**
 * The values of a test send: each must be a variable the template declares, of its type, and short. Nothing else is filled in, so a test cannot smuggle text through a name the template never
 * declared. A variable the template uses and the test leaves out is a broken message.
 */
export function sampleVariablesOf(variableSchema: unknown, contentAst: unknown, samples: unknown): Record<string, string> {
  const declared = declaredVariables(variableSchema);
  if (!isRecord(samples)) throw invalid('sample_variables');
  // Own properties only: a variable may be named constructor or toString, and a plain object already has those.
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(samples)) {
    const variable = declared.get(name);
    if (variable === undefined) throw invalid(`sample_variables.${name}`);
    const fits =
      (variable.type === 'string' && typeof value === 'string') ||
      ((variable.type === 'number' || variable.type === 'money') && typeof value === 'number' && Number.isFinite(value)) ||
      (variable.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (variable.type === 'boolean' && typeof value === 'boolean');
    if (!fits || String(value).length > MAX_SAMPLE_LENGTH) throw invalid(`sample_variables.${name}`);
    values[name] = String(value);
  }
  const body = isRecord(contentAst) && typeof contentAst.body === 'string' ? contentAst.body : '';
  const subject = isRecord(contentAst) && typeof contentAst.subject === 'string' ? contentAst.subject : '';
  for (const name of placeholdersOf(`${body} ${subject}`)) if (!Object.hasOwn(values, name)) throw invalid(`sample_variables.${name}`);
  return values;
}
