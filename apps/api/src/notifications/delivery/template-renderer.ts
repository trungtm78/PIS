import { DomainError } from '@machvon/kernel';

/** What an adapter is given to send: a subject (e-mail only) and a plain text. */
export interface RenderedMessage {
  subject?: string;
  text: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,59})\s*\}\}/g;
const MAX_SUBJECT = 200;
const MAX_TEXT = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The variables an event offers for its messages: `payload.notification.variables`, strings, numbers and booleans only. */
export function variablesOf(payload: Record<string, unknown> | null): Record<string, string> {
  const notification = payload?.notification;
  const variables = isRecord(notification) ? notification.variables : undefined;
  if (!isRecord(variables)) return {};
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') found[name] = String(value);
  }
  return found;
}

function substitute(text: string, declared: ReadonlySet<string>, variables: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    // A placeholder the template did not declare, or one the event did not supply, is a broken message: it is not sent half filled.
    // Own values only: a variable named constructor or toString is not the function a plain object inherits.
    const value = declared.has(name) && Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (value === undefined) throw new DomainError('TEMPLATE_INVALID', 422, 'variable');
    return value;
  });
}

/**
 * Renders the content of a template version: `content_ast` is `{ subject?, body }` with `{{name}}` placeholders, and `variable_schema` lists the
 * variables the template declares in `properties`. Only declared variables are filled, from the values the event supplied; any other placeholder
 * fails the render (422 TEMPLATE_INVALID) and the send is not made. The text is bounded, and nothing is logged.
 */
export function renderTemplate(contentAst: unknown, variableSchema: unknown, variables: Readonly<Record<string, string>>): RenderedMessage {
  if (!isRecord(contentAst) || typeof contentAst.body !== 'string' || (contentAst.subject !== undefined && typeof contentAst.subject !== 'string')) {
    throw new DomainError('TEMPLATE_INVALID', 422, 'content_ast');
  }
  const properties = isRecord(variableSchema) && isRecord(variableSchema.properties) ? Object.keys(variableSchema.properties) : [];
  const declared = new Set(properties);
  const text = substitute(contentAst.body, declared, variables);
  const subject = contentAst.subject === undefined ? undefined : substitute(contentAst.subject, declared, variables);
  if (text.length > MAX_TEXT || (subject?.length ?? 0) > MAX_SUBJECT) throw new DomainError('TEMPLATE_INVALID', 422, 'length');
  return subject === undefined ? { text } : { subject, text };
}
