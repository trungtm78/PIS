import { randomUUID } from 'node:crypto';
import { signTenantContext } from '@machvon/kernel';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';

/**
 * What the UAT suites of the enterprise areas share (docs/uat/{ind,rpt,dir,hpm,ebs,hub,int,ent}): a caller that sends what a browser or a phone sends (the tenant token of a member, the
 * Idempotency-Key of a command, the If-Match of a versioned one) and the checks a case is made of. Every check throws on a wrong answer, and a suite proves that with a negative control
 * (`expectCheckFails`): a check that cannot go red proves nothing.
 */

export interface Reply {
  status: number;
  json: Record<string, unknown>;
}

export interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string | number;
  /** The Idempotency-Key of a command; a fresh one by default. */
  key?: string;
  /** Sends the command without an Idempotency-Key. */
  noKey?: boolean;
}

export function callerOf(baseUrl: () => string, signingKey: Buffer): (method: string, url: string, options: CallOptions) => Promise<Reply> {
  return async (method, url, options) => {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, signingKey);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET' && options.noKey !== true) headers['idempotency-key'] = options.key ?? `uat-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${String(options.ifMatch)}"`;
    const response = await fetch(`${baseUrl()}${url}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = { unparsed: text };
    }
    return { status: response.status, json };
  };
}

/** The code of a problem answer (the `code` member of the problem document). */
export const codeOf = (reply: Reply): string | undefined => (typeof reply.json.code === 'string' ? reply.json.code : undefined);

/** The member of the answer that names the problem, for a message that tells a reader what went wrong. */
const describe = (reply: Reply): string => `${reply.status} ${codeOf(reply) ?? JSON.stringify(reply.json).slice(0, 160)}`;

/** The permission check refused the caller: 403 and the code of a permission or scope refusal, never a rule of the command. */
export function assertRefusedForPermission(reply: Reply): void {
  if (reply.status !== 403) throw new Error(`expected a refusal for a missing permission (403), got ${describe(reply)}`);
  const code = codeOf(reply);
  if (code === undefined || !['PERMISSION_DENIED', 'SCOPE_DENIED', 'FORBIDDEN'].includes(code)) throw new Error(`expected a permission refusal code, got ${describe(reply)}`);
}

/**
 * The caller got past the permission check: any answer but a permission refusal or a missing route (the command may refuse the empty body, the id may name nothing). A route that names an object in its path (`namesObject`)
 * may answer 404 with the code of a missing object; a route that does not may not answer 404 at all.
 */
export function assertNotRefusedForPermission(reply: Reply, namesObject: boolean): void {
  if (reply.status === 404 && (codeOf(reply) === undefined || !namesObject)) throw new Error(`the route does not exist: ${describe(reply)}`);
  if (reply.status === 401) throw new Error(`the caller was not authenticated: ${describe(reply)}`);
  if (reply.status >= 500) throw new Error(`the server failed: ${describe(reply)}`);
  const code = codeOf(reply);
  if (reply.status === 403 && code !== undefined && ['PERMISSION_DENIED', 'SCOPE_DENIED', 'FORBIDDEN'].includes(code)) throw new Error(`the holder of the permission was refused: ${describe(reply)}`);
}

export function assertStatus(reply: Reply, status: number, code?: string): void {
  if (reply.status !== status) throw new Error(`expected ${status}, got ${describe(reply)}`);
  if (code !== undefined && codeOf(reply) !== code) throw new Error(`expected the code ${code}, got ${describe(reply)}`);
}

/** The negative control of a suite: the check is fed an answer that is wrong on purpose and must throw. */
export function expectCheckFails(check: () => void): void {
  let failed = false;
  try {
    check();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error('the check accepted an answer that is wrong on purpose: it cannot go red');
}
