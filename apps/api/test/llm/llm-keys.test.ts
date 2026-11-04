import { randomUUID } from 'node:crypto';
import { AuditWriter, LlmKeyStore, LlmKeySweepJob } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { MockLiteLlm } from '../../src/modules/llm/mock-key-ports';
import { AI_ADMIN, KEY_ADMIN, KEY_READER, LlmApp, NOBODY, READER, SCOPED, TENANT_A, TENANT_B, memberId } from './llm-app';
import type { Reply } from './llm-app';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';

const app = new LlmApp();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());

let since = new Date();
let approved: string;
let proposed: string;
beforeEach(async () => {
  await app.reset();
  app.litellm.keys.clear();
  app.vault.secrets.clear();
  since = new Date();
  const provider = await app.call('POST', '/ai-providers', { member: AI_ADMIN, body: { provider_code: 'VN-1', name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'CONFIDENTIAL' } });
  const model = (id: string) =>
    app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: provider.json.resource_id, model_id: id, capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'INTERNAL' } });
  approved = (await model('llm-approved')).json.resource_id as string;
  proposed = (await model('llm-proposed')).json.resource_id as string;
  // The evaluation that approves a model comes with ST-LLM-004; here the model is put in the state it leaves it in.
  await app.rows("update machvon.ai_model set status = 'APPROVED' where id = $1", [approved]);
});

const inAYear = (): string => new Date(Date.now() + 300 * 86_400_000).toISOString();
const create = (body: Record<string, unknown> = {}, member = KEY_ADMIN, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/ai-virtual-keys', { member, body: { key_alias: 'bid-prod', scope_kind: 'TENANT', allowed_model_ids: [approved], expires_at: inAYear(), ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
const etag = (reply: Reply): string => `"${String(reply.json.resource_version)}"`;
const rotate = (id: string, version: string, member = KEY_ADMIN): Promise<Reply> => app.call('POST', `/ai-virtual-keys/${id}/rotation`, { member, ifMatch: version, body: {} });
const revoke = (id: string, version: string, reason = 'The key was exposed in a ticket', member = KEY_ADMIN): Promise<Reply> => app.call('POST', `/ai-virtual-keys/${id}/revocation`, { member, ifMatch: version, body: { reason } });
const row = async (id: string) => (await app.rows<{ status: string; expires_at: string; key_alias: string; fingerprint: string; secret_ref: string; litellm_key_ref: string; revoked_reason: string | null; rotated_from_id: string | null; version: string }>('select status, expires_at, key_alias, fingerprint, secret_ref, litellm_key_ref, revoked_reason, rotated_from_id, version::text as version from machvon.ai_virtual_key where id = $1', [id]))[0]!;
const secretOf = (ref: string): string => app.litellm.keys.get(ref)!.secret;
const audits = (action: string) => app.rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 and occurred_at >= $2 order by occurred_at', [action, since]);
const events = (type: string) => app.rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and created_at >= $2 order by created_at', [type, since]);
const sweep = (now: Date) => {
  const tenants = app.harness.tenants as TenantDatabase;
  const job = new LlmKeySweepJob(new AuditWriter(tenants), app.litellm, app.vault);
  return tenants.withTenant(contextFor(TENANT_A, memberId(AI_ADMIN)), (tx) => job.run(tx, memberId(AI_ADMIN), now));
};

describe('the virtual keys of the AI gateway (ST-LLM-002, LLM F5, BR-LLM-09, LLM-06)', () => {
  it('AC-ST-LLM-002-1: UAT-AC20 makes a key whose secret is in the vault and nowhere else: the answer, the list, the rows, the audit and the events carry only the alias and the fingerprint', async () => {
    const made = await create();
    expect(made.status).toBe(200);
    expect(Object.keys(made.json).sort()).toEqual(['fingerprint', 'key_alias', 'operation_id', 'resource_id', 'resource_version', 'status']);
    const id = made.json.resource_id as string;
    const stored = await row(id);
    const secret = secretOf(stored.litellm_key_ref);
    expect(app.vault.secrets.get(stored.secret_ref)).toBe(secret);
    expect(stored.secret_ref).toBe(`secret://tenants/${TENANT_A}/litellm/${id}`);
    expect(made.json.fingerprint).toBe(stored.fingerprint);
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);

    const listed = await app.call('GET', '/ai-virtual-keys', { member: KEY_READER });
    expect(listed.status).toBe(200);
    const view = (listed.json.items as Array<Record<string, unknown>>)[0]!;
    expect(view).toMatchObject({ id, key_alias: 'bid-prod', fingerprint: stored.fingerprint, scope_kind: 'TENANT', status: 'ACTIVE', allowed_model_ids: [approved] });
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['secret_ref', 'litellm_key_ref', 'secret']));

    // Everything the application wrote or answered, scanned for the secret and for the references.
    const everything = JSON.stringify([
      made.json,
      listed.json,
      await app.rows('select * from machvon.audit_event where occurred_at >= $1', [since]),
      await app.rows('select * from machvon.outbox_event where created_at >= $1', [since]),
      await app.rows('select key_alias, fingerprint, scope_kind, status from machvon.ai_virtual_key'),
    ]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(stored.secret_ref);
    expect(everything).not.toContain(stored.litellm_key_ref);
    expect((await audits('llm.key_created'))[0]?.safe_diff).toMatchObject({ key_alias: 'bid-prod', fingerprint: stored.fingerprint });
    expect((await events('llm.key.created.v1'))[0]?.payload).toMatchObject({ key_id: id, key_alias: 'bid-prod' });
  });

  it('AC-ST-LLM-002-1: UAT-AC20 leaves no secret in a log when the key service fails with a message that carries one, and no key behind', async () => {
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    const logged = jest.spyOn(console, 'error').mockImplementation(((...args: unknown[]) => void lines.push(args.map(String).join(' '))) as never);
    try {
      app.litellm.failNext('upstream refused sk-live-1234567890abcdefghijklmnopqrstuv for bid-prod');
      const failed = await create();
      expect([failed.status, failed.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      expect(JSON.stringify(failed.json)).not.toContain('sk-live');
      // The sweep logs its failures too.
      const made = await create({ key_alias: 'sweep-me' });
      await app.rows("update machvon.ai_virtual_key set status = 'ROTATING', expires_at = now() - interval '1 hour' where id = $1", [made.json.resource_id]);
      app.litellm.failNext('Bearer sk-live-abcdefghijklmnopqrstuvwxyz012345 rejected');
      expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 1 });
    } finally {
      write.mockRestore();
      logged.mockRestore();
    }
    // The failures were logged (by their class), and nothing of the key.
    expect(lines.join('\n')).toContain('litellm failed with Error');
    expect(lines.join('\n')).not.toMatch(/sk-live|1234567890abcdefghijklmnop|Bearer sk/);
    expect((await app.rows('select 1 from machvon.ai_virtual_key where key_alias = $1', ['bid-prod'])).length).toBe(0);
  });

  it('AC-ST-LLM-002-2: UAT-AC20 rotates a key: the new one is ACTIVE with the alias, the old one is ROTATING for a day and works until then, and is then revoked at LiteLLM', async () => {
    const made = await create();
    const oldId = made.json.resource_id as string;
    const oldRow = await row(oldId);
    const oldSecret = secretOf(oldRow.litellm_key_ref);
    const before = Date.now();
    const rotated = await rotate(oldId, etag(made));
    expect(rotated.status).toBe(200);
    expect(rotated.json).toMatchObject({ status: 'ACTIVE', key_alias: 'bid-prod', rotated_from_id: oldId });
    const newId = rotated.json.resource_id as string;
    expect(newId).not.toBe(oldId);
    const [fresh, old] = [await row(newId), await row(oldId)];
    expect([fresh.status, fresh.key_alias, fresh.rotated_from_id]).toEqual(['ACTIVE', 'bid-prod', oldId]);
    expect(old.status).toBe('ROTATING');
    expect(old.key_alias).toBe('bid-prod');
    const endsAt = new Date(old.expires_at).getTime();
    expect(Math.abs(endsAt - (before + 24 * 3_600_000))).toBeLessThan(120_000);
    expect(rotated.json.fingerprint).not.toBe(oldRow.fingerprint);
    expect(JSON.stringify(rotated.json)).not.toContain(oldSecret);

    // Both work now; the old one only until the end of its day.
    const newSecret = secretOf(fresh.litellm_key_ref);
    const now = new Date();
    expect([app.litellm.isUsable(oldSecret, now), app.litellm.isUsable(newSecret, now)]).toEqual([true, true]);
    expect(app.litellm.isUsable(oldSecret, new Date(before + 25 * 3_600_000))).toBe(false);
    expect(app.litellm.isUsable(newSecret, new Date(before + 25 * 3_600_000))).toBe(true);

    // Before the end of the day the sweep leaves it; after it the key is revoked at LiteLLM and its secret leaves the vault.
    expect(await sweep(new Date(before + 23 * 3_600_000))).toEqual({ revoked: 0, failed: 0 });
    expect((await row(oldId)).status).toBe('ROTATING');
    const later = new Date(before + 25 * 3_600_000);
    expect(await sweep(later)).toEqual({ revoked: 1, failed: 0 });
    expect(await row(oldId)).toMatchObject({ status: 'REVOKED', revoked_reason: 'ROTATION_COMPLETED' });
    expect(app.litellm.keys.get(oldRow.litellm_key_ref)?.revoked).toBe(true);
    expect(app.vault.secrets.has(oldRow.secret_ref)).toBe(false);
    expect(app.vault.secrets.has(fresh.secret_ref)).toBe(true);
    // A second pass finds nothing; the audit and the event carry no secret.
    expect(await sweep(later)).toEqual({ revoked: 0, failed: 0 });
    expect((await row(newId)).status).toBe('ACTIVE');
    expect((await audits('llm.key_revoked'))[0]?.safe_diff).toMatchObject({ reason: 'ROTATION_COMPLETED' });
    expect((await events('llm.key.revoked.v1')).length).toBe(1);
    expect((await events('llm.key.rotated.v1'))[0]?.payload).toMatchObject({ key_id: newId, old_key_id: oldId });
  });

  it('records a key past its expiry as revoked, and takes the next pass for one LiteLLM could not be reached for', async () => {
    const made = await create({ key_alias: 'short-lived' });
    const id = made.json.resource_id as string;
    await app.rows("update machvon.ai_virtual_key set expires_at = now() - interval '1 minute' where id = $1", [id]);
    app.litellm.failNext('down');
    expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 1 });
    expect((await row(id)).status).toBe('ACTIVE');
    expect(await sweep(new Date())).toEqual({ revoked: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ status: 'REVOKED', revoked_reason: 'EXPIRED' });
  });

  it('AC-ST-LLM-002-2: UAT-AC20 revokes at once: the key fails at LiteLLM before anything else, and a key LiteLLM cannot stop stays as it is', async () => {
    const made = await create();
    const id = made.json.resource_id as string;
    const stored = await row(id);
    const secret = secretOf(stored.litellm_key_ref);
    expect(app.litellm.isUsable(secret, new Date())).toBe(true);

    app.litellm.failNext('upstream down');
    const down = await revoke(id, etag(made));
    expect([down.status, down.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
    expect((await row(id)).status).toBe('ACTIVE');

    const stale = await revoke(id, '"9"');
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    const done = await revoke(id, etag(made));
    expect([done.status, done.json.status]).toEqual([200, 'REVOKED']);
    expect(app.litellm.isUsable(secret, new Date())).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'REVOKED', revoked_reason: 'The key was exposed in a ticket' });
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(false);
    const again = await revoke(id, etag(done));
    expect([again.status, again.json.code]).toEqual([409, 'KEY_STATE_INVALID']);
    expect((await rotate(id, etag(done))).json.code).toBe('KEY_STATE_INVALID');
    expect((await revoke(id, etag(done), 'short')).status).toBe(422);
    // Ten spaces pass the length of the contract and are no reason: nothing is stopped.
    const other = await create({ key_alias: 'spaces-only' });
    const blank = await revoke(other.json.resource_id as string, etag(other), '          ');
    expect([blank.status, blank.json.code, blank.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
    expect((await row(other.json.resource_id as string)).status).toBe('ACTIVE');
    expect(app.litellm.keys.get((await row(other.json.resource_id as string)).litellm_key_ref)?.revoked).toBe(false);
  });

  it('keeps retrying to take the secret out of the vault when it could not be removed at the revocation, until it is out', async () => {
    const made = await create();
    const id = made.json.resource_id as string;
    const stored = await row(id);
    app.vault.failNextRemoval();
    const done = await revoke(id, etag(made));
    expect([done.status, done.json.status]).toEqual([200, 'REVOKED']);
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(true);
    expect((await app.rows<{ secret_removed_at: string | null }>('select secret_removed_at from machvon.ai_virtual_key where id = $1', [id]))[0]?.secret_removed_at).toBeNull();
    // The next pass asks again, and a vault that still fails is counted and tried at the pass after.
    app.vault.failNextRemoval();
    expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 1 });
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(true);
    expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 0 });
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(false);
    expect((await app.rows<{ secret_removed_at: string | null }>('select secret_removed_at from machvon.ai_virtual_key where id = $1', [id]))[0]?.secret_removed_at).not.toBeNull();
    expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 0 });
  });

  it('keeps the revocation of a key past its end even if the vault does not let go of the secret at once, and takes the secret out at the next pass', async () => {
    const made = await create({ key_alias: 'lapsing' });
    const id = made.json.resource_id as string;
    const stored = await row(id);
    await app.rows("update machvon.ai_virtual_key set expires_at = now() - interval '1 minute' where id = $1", [id]);
    app.vault.failNextRemoval();
    expect(await sweep(new Date())).toEqual({ revoked: 1, failed: 1 });
    expect((await row(id)).status).toBe('REVOKED');
    expect(app.litellm.keys.get(stored.litellm_key_ref)?.revoked).toBe(true);
    expect(await sweep(new Date())).toEqual({ revoked: 0, failed: 0 });
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(false);
  });

  it('gives the references to the keys at LiteLLM that are unique for ever, so that a restart of the process does not make a new key the one of an old row', async () => {
    const first = await new MockLiteLlm().createKey({ alias: 'a', models: [], rpmLimit: null, tpmLimit: null, expiresAt: new Date() });
    const second = await new MockLiteLlm().createKey({ alias: 'a', models: [], rpmLimit: null, tpmLimit: null, expiresAt: new Date() });
    expect(first.keyRef).not.toBe(second.keyRef);
  });

  it('puts the lifetime of the old key back when a rotation fails after it was shortened, so that the key that is ACTIVE again does not die within the day', async () => {
    const made = await create({ key_alias: 'steady' });
    const id = made.json.resource_id as string;
    const stored = await row(id);
    const original = app.litellm.keys.get(stored.litellm_key_ref)!.until.getTime();
    // A failure at the very end of the command: the database refuses the new row.
    await app.rows("create or replace function machvon.llm_test_refuse_rotation() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end $$");
    await app.rows('create trigger llm_test_refuse_rotation before insert on machvon.ai_virtual_key for each row when (new.rotated_from_id is not null) execute function machvon.llm_test_refuse_rotation()');
    try {
      const failed = await rotate(id, etag(made));
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      await app.rows('drop trigger llm_test_refuse_rotation on machvon.ai_virtual_key');
      await app.rows('drop function machvon.llm_test_refuse_rotation()');
    }
    expect((await row(id)).status).toBe('ACTIVE');
    expect(app.litellm.keys.get(stored.litellm_key_ref)!.until.getTime()).toBe(original);
    // The key that was made for the rotation is stopped and its secret removed.
    const live = [...app.litellm.keys.values()].filter((key) => !key.revoked);
    expect(live.length).toBe(1);
    expect(app.vault.secrets.size).toBe(1);
  });

  it('writes down a key that could not be taken back when its command failed, and the sweep stops it and takes its secret out of the vault', async () => {
    await app.rows("create or replace function machvon.llm_test_refuse_key() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end $$");
    await app.rows("create trigger llm_test_refuse_key before insert on machvon.ai_virtual_key for each row when (new.status = 'ACTIVE' and new.key_alias = 'orphan-key') execute function machvon.llm_test_refuse_key()");
    const revokeKey = app.litellm.revokeKey.bind(app.litellm);
    let calls = 0;
    app.litellm.revokeKey = async (ref: string) => {
      calls += 1;
      if (calls === 1) throw new Error('cannot stop sk-live-1234567890abcdefghijklmnopqrstuv');
      return revokeKey(ref);
    };
    try {
      const failed = await create({ key_alias: 'orphan-key' });
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      app.litellm.revokeKey = revokeKey;
      await app.rows('drop trigger llm_test_refuse_key on machvon.ai_virtual_key');
      await app.rows('drop function machvon.llm_test_refuse_key()');
    }
    // The key exists at LiteLLM and works, and the application has it written down as due.
    const [made] = [...app.litellm.keys.entries()];
    expect(made).toBeDefined();
    expect(made![1].revoked).toBe(false);
    const orphan = (await app.rows<{ id: string; status: string; revoked_reason: string }>("select id, status, revoked_reason from machvon.ai_virtual_key where key_alias = 'orphan-key'"))[0]!;
    expect(orphan).toMatchObject({ status: 'ROTATING', revoked_reason: 'CREATION_ABORTED' });
    expect(await sweep(new Date())).toEqual({ revoked: 1, failed: 0 });
    expect(made![1].revoked).toBe(true);
    expect(app.vault.secrets.size).toBe(0);
    expect(await row(orphan.id)).toMatchObject({ status: 'REVOKED', revoked_reason: 'CREATION_ABORTED' });
    // The alias was never held by it: it can be used now.
    expect((await create({ key_alias: 'orphan-key' })).status).toBe(200);
  });

  it('takes a key back even when it is the commit that fails, after the handler had answered, and when the rotation is the one that fails at the commit', async () => {
    await app.rows("create or replace function machvon.llm_test_refuse_commit() returns trigger language plpgsql as $$ begin if new.key_alias like 'late-%' and new.status = 'ACTIVE' then raise exception 'refused at the commit for the test'; end if; return null; end $$");
    await app.rows('create constraint trigger llm_test_refuse_commit after insert on machvon.ai_virtual_key deferrable initially deferred for each row execute function machvon.llm_test_refuse_commit()');
    try {
      const failed = await create({ key_alias: 'late-create' });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect([...app.litellm.keys.values()].every((key) => key.revoked)).toBe(true);
      expect(app.vault.secrets.size).toBe(0);
      expect((await app.rows('select 1 from machvon.ai_virtual_key where key_alias = $1', ['late-create'])).length).toBe(0);
    } finally {
      await app.rows('drop trigger llm_test_refuse_commit on machvon.ai_virtual_key');
    }
    // A rotation that fails at the commit: the new key is taken back and the old one keeps its own end.
    const made = await create({ key_alias: 'late-rotate' });
    const old = await row(made.json.resource_id as string);
    const original = app.litellm.keys.get(old.litellm_key_ref)!.until.getTime();
    await app.rows('create constraint trigger llm_test_refuse_commit after insert on machvon.ai_virtual_key deferrable initially deferred for each row execute function machvon.llm_test_refuse_commit()');
    try {
      const failed = await rotate(made.json.resource_id as string, etag(made));
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      await app.rows('drop trigger llm_test_refuse_commit on machvon.ai_virtual_key');
      await app.rows('drop function machvon.llm_test_refuse_commit()');
    }
    expect((await row(made.json.resource_id as string)).status).toBe('ACTIVE');
    expect(app.litellm.keys.get(old.litellm_key_ref)!.until.getTime()).toBe(original);
    expect([...app.litellm.keys.values()].filter((key) => !key.revoked).length).toBe(1);
    expect(app.vault.secrets.size).toBe(1);
  });

  it('makes the record say that a key is revoked when the revocation was done at LiteLLM and its command did not commit', async () => {
    const made = await create({ key_alias: 'half-revoked' });
    const id = made.json.resource_id as string;
    const stored = await row(id);
    const original = LlmKeyStore.prototype.markRevoked;
    let calls = 0;
    // The command fails after LiteLLM stopped the key: the first write of the state fails, the one of the recovery goes through.
    LlmKeyStore.prototype.markRevoked = async function (this: LlmKeyStore, ...args: Parameters<LlmKeyStore['markRevoked']>) {
      calls += 1;
      if (calls === 1) throw new Error('the database went away');
      return original.apply(this, args);
    };
    try {
      const failed = await revoke(id, etag(made), 'The key was exposed in a ticket');
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      LlmKeyStore.prototype.markRevoked = original;
    }
    expect(app.litellm.keys.get(stored.litellm_key_ref)?.revoked).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'REVOKED', revoked_reason: 'The key was exposed in a ticket' });
    expect(app.vault.secrets.has(stored.secret_ref)).toBe(false);
    expect((await audits('llm.key_revoked')).length).toBe(1);
    expect((await events('llm.key.revoked.v1')).length).toBe(1);
  });

  it('takes what looks like a key out of the reason of a revocation before it is kept, answered or sent', async () => {
    const made = await create();
    const id = made.json.resource_id as string;
    const secret = ['sk', 'live', '1234567890abcdefghijklmnopqrstuv'].join('-');
    const done = await revoke(id, etag(made), `The key ${secret} was pasted in a ticket`);
    expect(done.status).toBe(200);
    expect((await row(id)).revoked_reason).toBe('The key [REDACTED] was pasted in a ticket');
    const listed = await app.call('GET', '/ai-virtual-keys', { member: KEY_READER });
    const everything = JSON.stringify([listed.json, await audits('llm.key_revoked'), await events('llm.key.revoked.v1')]);
    expect(everything).not.toContain(secret);
    expect(everything).toContain('[REDACTED]');
  });

  it('holds an alias for one ACTIVE key: a second is refused, the alias is free after a revocation, and two at once make one key', async () => {
    const first = await create();
    const duplicate = await create();
    expect([duplicate.status, duplicate.json.code]).toEqual([409, 'KEY_ALIAS_DUPLICATE']);
    expect((await revoke(first.json.resource_id as string, etag(first))).status).toBe(200);
    expect((await create()).status).toBe(200);

    const replies = await Promise.all([create({ key_alias: 'race-1' }), create({ key_alias: 'race-1' }), create({ key_alias: 'race-1' })]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409, 409]);
    // The keys that lost were not made, or were stopped and their secrets removed: one live key and one secret remain for the alias.
    const live = [...app.litellm.keys.values()].filter((key) => key.alias === 'race-1' && !key.revoked);
    expect(live.length).toBe(1);
    expect((await app.rows('select 1 from machvon.ai_virtual_key where key_alias = $1', ['race-1'])).length).toBe(1);
    expect(app.vault.secrets.size).toBe([...app.litellm.keys.values()].filter((key) => !key.revoked).length);
  });

  it('refuses a model that is not approved, one that is not there, a past or too distant end, a budget that is not there, and bad rates', async () => {
    expect((await create({ key_alias: 'a1-key', allowed_model_ids: [proposed] })).json.code).toBe('MODEL_NOT_APPROVED');
    expect((await create({ key_alias: 'a2-key', allowed_model_ids: [randomUUID()] })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'allowed_model_ids' });
    expect((await create({ key_alias: 'a3-key', allowed_model_ids: [approved, approved] })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'allowed_model_ids' });
    expect((await create({ key_alias: 'a4-key', expires_at: '2020-01-01T00:00:00Z' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expires_at' });
    expect((await create({ key_alias: 'a5-key', expires_at: '2099-01-01T00:00:00Z' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'expires_at' });
    expect((await create({ key_alias: 'a6-key', budget_id: randomUUID() })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'budget_id' });
    expect((await create({ key_alias: 'a7-key', rpm_limit: 0 })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'rpm_limit' });
    expect((await create({ key_alias: 'no' })).status).toBeGreaterThanOrEqual(400);
    expect((await create({ key_alias: 'a8-key', allowed_model_ids: [] })).status).toBe(200);
    expect(app.litellm.keys.size).toBe(1);
    expect((await create({ key_alias: 'a9-key', secret: 'sk-mine' } as never)).json.code).toBe('FIELD_NOT_ALLOWED');
  });

  it('refuses to rotate a key whose model is no longer approved, one past its end, and a stale version, and leaves nothing behind', async () => {
    const made = await create();
    const id = made.json.resource_id as string;
    const stale = await rotate(id, '"9"');
    expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    await app.rows("update machvon.ai_model set status = 'SUSPENDED' where id = $1", [approved]);
    const refused = await rotate(id, etag(made));
    expect([refused.status, refused.json.code]).toEqual([422, 'MODEL_NOT_APPROVED']);
    expect((await row(id)).status).toBe('ACTIVE');
    expect(app.litellm.keys.size).toBe(1);
    await app.rows("update machvon.ai_model set status = 'APPROVED' where id = $1", [approved]);
    await app.rows("update machvon.ai_virtual_key set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect((await rotate(id, etag(made))).json.code).toBe('KEY_STATE_INVALID');
    expect((await rotate(randomUUID(), '"1"')).status).toBe(404);
    // A failure of LiteLLM on the old key undoes the new one.
    const second = await create({ key_alias: 'second-key' });
    const before = [...app.litellm.keys.values()].filter((key) => !key.revoked).length;
    const original = app.litellm.limitLifetime.bind(app.litellm);
    app.litellm.limitLifetime = async () => {
      throw new Error('cannot shorten sk-live-1234567890abcdefghijklmnopqrstuv');
    };
    const failed = await rotate(second.json.resource_id as string, etag(second));
    app.litellm.limitLifetime = original;
    expect([failed.status, failed.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
    expect([...app.litellm.keys.values()].filter((key) => !key.revoked).length).toBe(before);
    expect((await row(second.json.resource_id as string)).status).toBe('ACTIVE');
  });

  it('is the tenant\'s and the right of whoever manages keys: the holder over one unit, the lister on a command and the person with no grant are refused, and a tenant sees only its keys', async () => {
    const made = await create();
    for (const member of [SCOPED, READER, NOBODY, KEY_READER]) {
      expect((await create({ key_alias: 'denied-key' }, member)).status).toBe(403);
      expect((await rotate(made.json.resource_id as string, etag(made), member)).status).toBe(403);
      expect((await revoke(made.json.resource_id as string, etag(made), 'A long enough reason', member)).status).toBe(403);
    }
    for (const member of [SCOPED, NOBODY, READER]) expect((await app.call('GET', '/ai-virtual-keys', { member })).status).toBe(403);
    const other = await app.call('GET', '/ai-virtual-keys', { member: AI_ADMIN, tenantId: TENANT_B });
    expect([other.status, other.json.items]).toEqual([200, []]);
    expect((await app.call('POST', `/ai-virtual-keys/${made.json.resource_id as string}/revocation`, { member: AI_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'A long enough reason' } })).status).toBe(404);
  });

  it('makes a key once under one idempotency key', async () => {
    const key = `key-${randomUUID()}`;
    const body = { key_alias: 'once-key', scope_kind: 'TENANT', allowed_model_ids: [approved], expires_at: inAYear() };
    const [a, b] = [await app.call('POST', '/ai-virtual-keys', { member: KEY_ADMIN, key, body }), await app.call('POST', '/ai-virtual-keys', { member: KEY_ADMIN, key, body })];
    expect([a.status, b.status, a.json.resource_id === b.json.resource_id]).toEqual([200, 200, true]);
    expect(app.litellm.keys.size).toBe(1);
    expect((await audits('llm.key_created')).length).toBe(1);
  });
});
