// A small read-only client of the real API for `clip-seed verify`: it signs the development session token the stack accepts (the same format and key
// the web session uses) for one of the people of the guide and follows list cursors. Local use only: the key comes from the environment.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The development session token of a membership: `<payload>.<hmac>`, valid for five minutes. */
export function sessionToken({ key, tenantId, membershipId, now = Date.now() }) {
  const payload = Buffer.from(JSON.stringify({ tenantId, membershipId, scopeVersion: 1, exp: Math.floor(now / 1000) + 300 }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

/** The membership of a person of the guide by key, from the fixture file of the e2e layer. */
export function membershipOfPerson(fixturesPath, key) {
  const users = JSON.parse(readFileSync(fixturesPath, 'utf8')).users;
  const found = users.find((user) => user.key === key);
  if (found === undefined) throw new Error(`the person ${key} has no fixture account`);
  return found.membershipId;
}

/** `new ApiReader({ base, key, tenantId, fixturesPath })`: `get(person, path, query)` and `list(person, path, query)` (every row of a cursor list). */
export class ApiReader {
  constructor({ base, key, tenantId, fixturesPath, fetchImpl = fetch }) {
    this.base = base.replace(/\/+$/u, '');
    this.key = key;
    this.tenantId = tenantId;
    this.fixturesPath = fixturesPath;
    this.fetchImpl = fetchImpl;
    this.calls = 0;
  }

  async get(person, path, query = {}) {
    const search = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
      .join('&');
    const token = sessionToken({ key: this.key, tenantId: this.tenantId, membershipId: membershipOfPerson(this.fixturesPath, person) });
    this.calls += 1;
    const response = await this.fetchImpl(`${this.base}${path}${search === '' ? '' : `?${search}`}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const text = await response.text();
    let json;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, ok: response.ok, json, text };
  }

  async list(person, path, query = {}) {
    const rows = [];
    let cursor;
    for (let page = 0; page < 200; page += 1) {
      const reply = await this.get(person, path, { limit: 200, ...query, cursor });
      if (!reply.ok) throw new Error(`GET ${path} answered ${reply.status}: ${reply.text.slice(0, 300)}`);
      const items = Array.isArray(reply.json) ? reply.json : (reply.json.items ?? reply.json.rows ?? reply.json.data);
      if (!Array.isArray(items)) return rows;
      rows.push(...items);
      cursor = typeof reply.json.next_cursor === 'string' && reply.json.next_cursor !== '' ? reply.json.next_cursor : undefined;
      if (cursor === undefined) break;
    }
    return rows;
  }
}
