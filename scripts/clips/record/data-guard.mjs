// The empty-data guard: a clip is never recorded on a tenant whose key lists are empty. The guard reads the real API of the running stack
// (one GET for each requirement) and refuses with the list of what is missing; a list that cannot be read counts as missing, never as fine.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export class EmptyTenantError extends Error {
  constructor(problems) {
    super(`the seeded tenant looks empty, nothing is recorded: ${problems.join('; ')}`);
    this.name = 'EmptyTenantError';
    this.problems = problems;
  }
}

export function loadRequirements(profile, file = join(HERE, 'requirements.json')) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const list = all[profile];
  if (!Array.isArray(list)) throw new Error(`no requirement profile "${profile}" (known: ${Object.keys(all).filter((key) => key !== 'note').join(', ')})`);
  return list;
}

/** The number a requirement counts in an answer: a path ('items.length', 'total', 'counts.total') or 'auto'; null when the answer has no such number. */
export function countOf(body, spec) {
  if (spec === 'auto') {
    if (Array.isArray(body)) return body.length;
    if (typeof body !== 'object' || body === null) return null;
    const list = Object.values(body).find((value) => Array.isArray(value));
    if (list !== undefined) return list.length;
    return Number.isFinite(body.total) ? body.total : null;
  }
  let value = body;
  for (const part of spec.split('.')) {
    if (value === null || value === undefined) return null;
    value = part === 'length' && Array.isArray(value) ? value.length : value[part];
  }
  return Number.isFinite(value) ? value : null;
}

/** The verdict on the counts: `rows` says for each requirement what was found, `problems` lists what is missing. `scale` raises or lowers every minimum. */
export function evaluateCounts(requirements, counts, { scale = 1 } = {}) {
  const rows = requirements.map((requirement) => {
    const found = counts[requirement.id];
    const min = Math.max(1, Math.ceil(requirement.min * scale));
    const failure = found === undefined || found === null ? (counts.errors?.[requirement.id] ?? 'could not be read') : found < min ? `has ${found} row${found === 1 ? '' : 's'}, at least ${min} needed` : null;
    return { id: requirement.id, label: requirement.label, found: found ?? null, min, ok: failure === null, failure };
  });
  const problems = rows.filter((row) => !row.ok).map((row) => `${row.label} (${row.id}) ${row.failure}`);
  return { ok: problems.length === 0, rows, problems };
}

/** Reads every requirement from the API with `fetchImpl` (injected: a test passes a fake). Never throws for one list; it records why that list could not be read. */
export async function probeTenant({ fetchImpl = fetch, baseUrl, headers, requirements, timeoutMs = 15_000 }) {
  const counts = { errors: {} };
  for (const requirement of requirements) {
    try {
      const response = await fetchImpl(`${baseUrl}${requirement.path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        counts.errors[requirement.id] = `answered ${response.status}`;
        continue;
      }
      counts[requirement.id] = countOf(await response.json(), requirement.count);
      if (counts[requirement.id] === null) counts.errors[requirement.id] = 'answered with no count';
    } catch (error) {
      counts.errors[requirement.id] = `could not be reached (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return counts;
}

/** The guard: probes, judges, and throws EmptyTenantError when the tenant is empty. Returns the verdict when it is not. */
export async function assertSeeded(options) {
  const counts = await probeTenant(options);
  const verdict = evaluateCounts(options.requirements, counts, { scale: options.scale ?? 1 });
  if (!verdict.ok) throw new EmptyTenantError(verdict.problems);
  return verdict;
}

/** The development token of the stack (the same format and key the web session signs with; see apps/web/e2e/support/api.ts). */
export function devToken({ key, tenantId, membershipId, nowMs = Date.now(), ttlSeconds = 300 }) {
  if (!key) throw new Error('the session key is missing (E2E_SESSION_KEY)');
  const payload = Buffer.from(JSON.stringify({ tenantId, membershipId, scopeVersion: 1, exp: Math.floor(nowMs / 1000) + ttlSeconds }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}
