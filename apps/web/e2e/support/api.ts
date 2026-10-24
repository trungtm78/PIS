import { createHmac, randomUUID } from 'node:crypto';
import { membershipOf, stackInfo } from './stack.ts';

/**
 * A call to the API of the stack as a fixture user, for what a flow needs and no screen of the build offers (the draft of a template has
 * no form on DOC-14) or what a screen hides from the person and the server must still refuse (the drafter publishing their own draft).
 * The token is the development token of the stack: the same format and key the web session signs with.
 */

export interface ApiReply {
  status: number;
  json: Record<string, unknown>;
}

function tokenOf(user: string): string {
  const key = process.env.E2E_SESSION_KEY;
  if (key === undefined || key === '') throw new Error('E2E_SESSION_KEY is not set');
  const payload = Buffer.from(JSON.stringify({ tenantId: stackInfo().tenants.A, membershipId: membershipOf(user), scopeVersion: 1, exp: Math.floor(Date.now() / 1000) + 300 }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

export async function apiCall(user: string, method: 'GET' | 'POST' | 'PUT', path: string, options: { body?: unknown; version?: number } = {}): Promise<ApiReply> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokenOf(user)}`, 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = `e2e-${randomUUID()}`;
  if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
  const response = await fetch(`http://127.0.0.1:${stackInfo().apiPort}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
