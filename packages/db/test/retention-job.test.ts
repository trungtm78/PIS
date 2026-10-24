import { randomUUID } from 'node:crypto';
import { objectKey } from '@machvon/kernel';
import type { RetentionPolicyContent, TenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AuditSealJob } from '../src/audit-seal-job';
import { RETENTION_HELD_METRIC, RETENTION_LISTED_METRIC, RETENTION_PAYLOAD_FAILED_METRIC, RETENTION_PURGED_METRIC, RetentionJob, RetentionRunFailed } from '../src/retention-job';
import { RetentionPolicyStore } from '../src/retention-policy-store';
import { BUSINESS_SOURCES } from '../src/retention-sources';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const policies = new RetentionPolicyStore();
const MAKER = 1;
const CHECKER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const NOW = new Date('2026-10-24T01:30:00.000Z');
const TODAY = '2026-10-24';
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const ctxOf = (tenant = TENANT_A): TenantContext => ({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 });

/** Rows are written as the database administrator with the foreign keys switched off: the job only needs the rows, not their parents. */
async function admin<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    return (await client.query(sql, params)).rows as R[];
  } finally {
    await client.end();
  }
}

const count = async (table: string, where = 'true', tenant = TENANT_A): Promise<number> => Number((await admin<{ n: string }>(`select count(*)::text as n from machvon.${table} where tenant_id = $1 and ${where}`, [tenant]))[0]?.n);

async function publish(content: Partial<RetentionPolicyContent> & Pick<RetentionPolicyContent, 'record_class'>, tenant = TENANT_A): Promise<string> {
  const full: RetentionPolicyContent = {
    retention_years: 1,
    retention_basis: 'FROM_CREATED',
    legal_basis_ref: 'Placeholder until CXN-RET-03 is confirmed',
    end_action: 'REVIEW_FOR_DESTRUCTION',
    effective_from: '2026-01-01',
    ...content,
  };
  const row = (await harness.tenants.withTenant(contextFor(tenant, memberId(MAKER)), (tx) => policies.createDraft(tx, full, memberId(MAKER)))).row;
  await harness.tenants.withTenant(contextFor(tenant, memberId(CHECKER)), async (tx) => policies.publish(tx, await policies.lockDraft(tx, row.id, row.version), memberId(CHECKER), TODAY));
  return row.id;
}

const technical = (record_class: string, years: number | undefined = undefined, basis: RetentionPolicyContent['retention_basis'] = 'FROM_CREATED'): Partial<RetentionPolicyContent> & Pick<RetentionPolicyContent, 'record_class'> => ({
  record_class,
  retention_basis: basis,
  retention_years: basis === 'PERMANENT' ? undefined : years,
  end_action: 'AUTO_PURGE_TECHNICAL',
});

let sequence = 0;
const next = (): number => (sequence += 1);

const outbox = (status: string, published: string | null, aggregateId = randomUUID(), tenant = TENANT_A) =>
  admin(
    `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, published_at, aggregate_type, aggregate_version, event_key, correlation_id, status)
     values ($1, gen_random_uuid(), $2, 'x.y.v1', 1, '{}', now(), $3, 'widget', 1, $4, gen_random_uuid(), $5)`,
    [tenant, aggregateId, published, `ev-${next()}`, status],
  );
const session = (revokedAt: string | null, lastSeenAt: string, tenant = TENANT_A) =>
  admin(
    `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary, created_at, last_seen_at, revoked_at)
     values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, 'aal1', repeat('a', 64), 'test', $3, $3, $4)`,
    [tenant, `sess-${next()}`, lastSeenAt, revokedAt],
  );
const inbox = (status: string, receivedAt: string, reference: string | null, tenant = TENANT_A) =>
  admin(
    `insert into machvon.integration_event_inbox (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, payload_purged_at)
     values ($1, gen_random_uuid(), 'TEST', $2, repeat('b', 64), $3, $4, $5, 'k1', case when $3::text is null then $4::timestamptz end)`,
    [tenant, `evt-${next()}`, reference, receivedAt, status],
  );
const attempt = (createdAt: string, tenant = TENANT_A) =>
  admin(
    `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, created_at)
     values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'Delivered', 0, 'EMAIL', gen_random_uuid(), $2)`,
    [tenant, createdAt],
  );
const key = (createdAt: string, expiresInDays: number, tenant = TENANT_A) =>
  admin(
    `insert into machvon.idempotency_record (tenant_id, id, subject_id, operation, key_hash, request_hash, response_ref, status, expires_at, resource_type, resource_id, created_at)
     values ($1, gen_random_uuid(), gen_random_uuid(), 'op', $2, repeat('c', 64), '{}', 'COMPLETED', $3::timestamptz + make_interval(days => $4), 'widget', gen_random_uuid(), $3)`,
    [tenant, `${next()}`.padStart(64, '0'), createdAt, expiresInDays],
  );
const project = (code: string, createdAt: string, status = 'CONCEPT', statusChangedAt: string | null = null, tenant = TENANT_A): Promise<string> => {
  const projectId = randomUUID();
  return admin(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by, created_at, status_changed_at, project_group)
     values ($1, $2, $3, $3, $4, gen_random_uuid(), 'INTERNAL', 1000, $5, 1, $6, $6, $7, $8, 'C')`,
    [tenant, projectId, code, unitId(1), status, memberId(MAKER), createdAt, statusChangedAt ?? createdAt],
  ).then(() => projectId);
};
const hold = async (kind: string, ids: string[], tenant = TENANT_A): Promise<string> => {
  const holdId = randomUUID();
  await admin(
    `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
     values ($1, $2, $3::jsonb, 'Inspection decision 12/2026', 'A hold for the retention test', '2026-01-01T00:00:00Z', 'AUDIT', 'Active', $4, 1)`,
    [tenant, holdId, JSON.stringify({ kind, ids }), memberId(MAKER)],
  );
  return holdId;
};
const release = (holdId: string) => admin("update machvon.legal_hold set status = 'Released', released_at = now(), released_by = $2, release_reason = 'The inspection has ended', version = version + 1 where id = $1", [holdId, memberId(CHECKER)]);

/** Every table the job reads or writes, emptied (as the administrator, with the triggers that guard the rows switched off). */
const clearAll = async (): Promise<void> => {
  for (const table of ['retention_review_item', 'outbox_event', 'user_session', 'integration_event_inbox', 'delivery_attempt', 'idempotency_record', 'project', 'legal_hold', 'data_retention_policy', 'audit_event', 'audit_seal', 'audit_seal_check']) {
    await admin(`delete from machvon.${table}`);
  }
};

describe('RetentionJob (ST-ADM-017, ADM 3.12, BR-ADM-11)', () => {
  const metrics: Array<{ kind: string; name: string; value?: number; labels?: Record<string, string> }> = [];
  const removed: string[] = [];
  let failing: Set<string>;
  const job = (): RetentionJob =>
    new RetentionJob(harness.tenants, {
      metrics: {
        increment: (name, labels) => void metrics.push({ kind: 'increment', name, ...(labels === undefined ? {} : { labels }) }),
        gauge: (name, value, labels) => void metrics.push({ kind: 'gauge', name, value, ...(labels === undefined ? {} : { labels }) }),
      },
      payloads: {
        remove: (_tenant, reference) => {
          if (failing.has(reference)) return Promise.reject(new Error('storage down'));
          removed.push(reference);
          return Promise.resolve(true);
        },
      },
    });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    metrics.length = 0;
    removed.length = 0;
    failing = new Set();
    await clearAll();
  });

  describe('business classes: listed for review, never deleted', () => {
    it('lists the expired project dossier, skips the one a hold contains, deletes nothing, and lists the held one once the hold ends (AC-ST-ADM-017-2, UAT-AC141)', async () => {
      const policyId = await publish({ record_class: 'project_dossier', retention_years: 1, retention_basis: 'FROM_CREATED', end_action: 'REVIEW_FOR_DESTRUCTION' });
      const expired = await project('P-EXPIRED', '2024-03-15T03:00:00Z');
      const held = await project('P-HELD', '2024-03-16T03:00:00Z');
      const young = await project('P-YOUNG', '2026-05-01T03:00:00Z');
      const holdId = await hold('PROJECT', [held]);

      const first = await job().run(ctxOf(), NOW);
      expect(first).toMatchObject({ listed: { project_dossier: 1 }, skippedHeld: { project_dossier: 1 }, purged: {}, noSource: [], pending: 1 });
      expect(await count('project')).toBe(3);
      const items = await admin<{ resource_id: string; resource_type: string; basis_date: string; due_on: string; end_action: string; status: string; policy_id: string }>(
        'select resource_id, resource_type, basis_date::text, due_on::text, end_action, status, policy_id from machvon.retention_review_item order by resource_id',
      );
      expect(items).toEqual([{ resource_id: expired, resource_type: 'project', basis_date: '2024-03-15', due_on: '2025-03-15', end_action: 'REVIEW_FOR_DESTRUCTION', status: 'PENDING_REVIEW', policy_id: policyId }]);
      expect(items.map((item) => item.resource_id)).not.toContain(young);

      const again = await job().run(ctxOf(), NOW);
      expect(again).toMatchObject({ listed: {}, skippedHeld: { project_dossier: 1 }, pending: 1 });
      await release(holdId);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ listed: { project_dossier: 1 }, skippedHeld: {}, pending: 2 });
      expect(await count('project')).toBe(3);
      expect(metrics).toContainEqual({ kind: 'gauge', name: RETENTION_LISTED_METRIC, value: 1, labels: { record_class: 'project_dossier', tenant_id: TENANT_A } });
      expect(metrics).toContainEqual({ kind: 'gauge', name: RETENTION_HELD_METRIC, value: 1, labels: { record_class: 'project_dossier', tenant_id: TENANT_A } });
    });

    it('skips everything under a hold on the whole tenant, and a hold on the unit that owns the project', async () => {
      await publish({ record_class: 'project_dossier', retention_years: 1 });
      await project('P-1', '2024-01-01T03:00:00Z');
      const tenantHold = await hold('TENANT', []);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ listed: {}, skippedHeld: { project_dossier: 1 } });
      await release(tenantHold);
      const unitHold = await hold('UNIT', [unitId(1)]);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ listed: {}, skippedHeld: { project_dossier: 1 } });
      await release(unitHold);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ listed: { project_dossier: 1 } });
    });

    it('counts the period from the day a project was closed, and from nothing for a project that is still open', async () => {
      await publish({ record_class: 'project_dossier', retention_years: 2, retention_basis: 'FROM_CLOSED' });
      const closed = await project('P-CLOSED', '2020-01-01T03:00:00Z', 'CLOSED', '2024-10-01T03:00:00Z');
      await project('P-RECENTLY-CLOSED', '2020-01-01T03:00:00Z', 'CLOSED', '2025-12-01T03:00:00Z');
      await project('P-OPEN', '2020-01-01T03:00:00Z', 'IMPLEMENTATION', '2020-06-01T03:00:00Z');
      await job().run(ctxOf(), NOW);
      expect((await admin<{ resource_id: string; basis_date: string }>('select resource_id, basis_date::text from machvon.retention_review_item')).map((row) => [row.resource_id, row.basis_date])).toEqual([[closed, '2024-10-01']]);
    });

    it('moves 29 February to 28 February when the period ends in a year without one', async () => {
      await publish({ record_class: 'project_dossier', retention_years: 1 });
      await project('P-LEAP', '2024-02-29T03:00:00Z');
      await job().run(ctxOf(), NOW);
      expect(await admin("select basis_date::text, due_on::text from machvon.retention_review_item")).toEqual([{ basis_date: '2024-02-29', due_on: '2025-02-28' }]);
    });

    it('never lists a class that is kept for good, and reports a class or a basis that has no records to read yet', async () => {
      await publish({ record_class: 'project_dossier', retention_basis: 'PERMANENT', retention_years: undefined });
      await project('P-1', '2000-01-01T03:00:00Z');
      await publish({ record_class: 'payment_dossier', retention_years: 3 });
      await publish({ record_class: 'audit_event', retention_years: 3, retention_basis: 'FROM_CLOSED', end_action: 'ARCHIVE_TRANSFER' });
      const result = await job().run(ctxOf(), NOW);
      expect(result.listed).toEqual({});
      expect([...result.noSource].sort()).toEqual(['audit_event:FROM_CLOSED', 'payment_dossier']);
      expect(await count('retention_review_item')).toBe(0);
    });

    it('lists the old seal windows of the audit trail, and keeps a window off the list while one of its rows is held', async () => {
      await publish({ record_class: 'audit_event', retention_years: 1, end_action: 'ARCHIVE_TRANSFER' });
      const resources = [randomUUID(), randomUUID()];
      for (const [index, resource] of resources.entries()) {
        await admin(
          `insert into machvon.audit_event (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at)
           values ($1, gen_random_uuid(), $2, $3, 'widget', $4, '{}', $4, $4, '2024-02-01T00:00:00Z'), ($1, gen_random_uuid(), $2, $3, 'widget', $4, '{}', $4, $4, '2024-02-02T00:00:00Z')`,
          [TENANT_A, memberId(MAKER), `old.${index}`, resource],
        );
        await new AuditSealJob(harness.tenants, { windowRows: 2 }).seal(contextFor(TENANT_A, memberId(MAKER)));
      }
      await admin("update machvon.audit_seal set sealed_at = '2024-02-03T00:00:00Z'");
      const holdId = await hold('RESOURCE', [resources[1] as string]);
      const first = await job().run(ctxOf(), NOW);
      expect(first).toMatchObject({ listed: { audit_event: 1 }, skippedHeld: { audit_event: 1 } });
      expect(await admin('select resource_type, end_action from machvon.retention_review_item')).toEqual([{ resource_type: 'audit_seal', end_action: 'ARCHIVE_TRANSFER' }]);
      expect(await count('audit_event', "action like 'old.%'")).toBe(4);
      await release(holdId);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ listed: { audit_event: 1 } });
    });

    it('reads the records of every class and basis with a query the database accepts', async () => {
      for (const source of Object.values(BUSINESS_SOURCES)) {
        for (const basis of ['FROM_CREATED', 'FROM_CLOSED', 'FROM_CONTRACT_END'] as const) {
          const sql = source.candidates(basis);
          if (sql !== undefined) await expect(admin(`select * from (${sql}) c limit 1`)).resolves.toBeDefined();
        }
      }
      expect(BUSINESS_SOURCES.audit_event?.candidates('FROM_CLOSED')).toBeUndefined();
    });
  });

  describe('technical classes: purged when they have outlived their period', () => {
    it('removes published outbox events after 30 days, never a pending or dead one, and not one that a hold contains', async () => {
      const heldAggregate = randomUUID();
      await outbox('PUBLISHED', daysAgo(40));
      await outbox('PUBLISHED', daysAgo(10));
      await outbox('PENDING', null);
      await outbox('DEAD', daysAgo(400));
      await outbox('PUBLISHED', daysAgo(40), heldAggregate);
      const holdId = await hold('RESOURCE', [heldAggregate]);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { outbox_event: 1 } });
      expect(await count('outbox_event')).toBe(4);
      await release(holdId);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { outbox_event: 1 } });
      expect(await count('outbox_event')).toBe(3);
      expect(metrics).toContainEqual({ kind: 'gauge', name: RETENTION_PURGED_METRIC, value: 1, labels: { record_class: 'outbox_event', tenant_id: TENANT_A } });
    });

    it('removes sessions that ended or went quiet 180 days ago and keeps the recent ones', async () => {
      await session(daysAgo(200), daysAgo(201));
      await session(null, daysAgo(190));
      await session(daysAgo(20), daysAgo(21));
      await session(null, daysAgo(1));
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { user_session: 2 } });
      expect(await count('user_session')).toBe(2);
    });

    it('removes delivery attempts after 365 days and idempotency keys that expired more than 7 days ago', async () => {
      await attempt(daysAgo(400));
      await attempt(daysAgo(100));
      await key(daysAgo(9), 1);
      await key(daysAgo(3), 1);
      await key(daysAgo(1), 7);
      const result = await job().run(ctxOf(), NOW);
      expect(result.purged).toEqual({ delivery_attempt: 1, idempotency_record: 1 });
      expect(await count('delivery_attempt')).toBe(1);
      expect(await count('idempotency_record')).toBe(2);
    });

    it('empties the payload of a finished inbox event after 90 days and removes the stored file, but not that of an event that still waits, and keeps the metadata two years', async () => {
      const stored = objectKey(TENANT_A, 'webhook', randomUUID());
      const failingKey = objectKey(TENANT_A, 'webhook', randomUUID());
      await inbox('PROCESSED', daysAgo(100), stored);
      await inbox('DEAD', daysAgo(100), failingKey);
      await inbox('PROCESSED', daysAgo(100), 'inline:no-file');
      await inbox('FAILED', daysAgo(100), objectKey(TENANT_A, 'webhook', randomUUID()));
      await inbox('RECEIVED', daysAgo(100), objectKey(TENANT_A, 'webhook', randomUUID()));
      await inbox('PROCESSED', daysAgo(10), objectKey(TENANT_A, 'webhook', randomUUID()));
      await inbox('PROCESSED', daysAgo(800), null);
      await inbox('PROCESSED', daysAgo(500), null);
      failing = new Set([failingKey]);

      const result = await job().run(ctxOf(), NOW);
      expect(result.purged).toEqual({ integration_event_inbox: 3 });
      expect(removed).toEqual([stored]);
      expect(metrics).toContainEqual({ kind: 'increment', name: RETENTION_PAYLOAD_FAILED_METRIC, labels: { tenant_id: TENANT_A } });
      // Emptied: the stored one and the inline one; the dead one whose file could not be removed keeps its reference for the next run; the metadata of 800 days went.
      expect(await count('integration_event_inbox', 'payload_reference is null and payload_purged_at is not null')).toBe(3);
      expect(await count('integration_event_inbox', 'payload_reference is not null')).toBe(4);
      expect(await count('integration_event_inbox')).toBe(7);

      failing = new Set();
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { integration_event_inbox: 1 } });
      expect(removed).toEqual([stored, failingKey]);
    });

    it('keeps everything while a hold on the whole tenant is active, and takes it all when it ends', async () => {
      await outbox('PUBLISHED', daysAgo(40));
      await session(daysAgo(200), daysAgo(201));
      await attempt(daysAgo(400));
      await key(daysAgo(9), 1);
      await inbox('PROCESSED', daysAgo(100), objectKey(TENANT_A, 'webhook', randomUUID()));
      const tenantHold = await hold('TENANT', []);
      expect((await job().run(ctxOf(), NOW)).purged).toEqual({});
      expect(removed).toEqual([]);
      expect(await count('outbox_event')).toBe(1);
      await release(tenantHold);
      expect((await job().run(ctxOf(), NOW)).purged).toEqual({ outbox_event: 1, user_session: 1, delivery_attempt: 1, idempotency_record: 1, integration_event_inbox: 1 });
    });

    it('lets a published policy keep a class longer than the platform, never shorter, or for good', async () => {
      await outbox('PUBLISHED', daysAgo(40));
      await outbox('PUBLISHED', daysAgo(400));
      await publish(technical('outbox_event', 1));
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { outbox_event: 1 } });
      expect(await count('outbox_event')).toBe(1);
      await publish(technical('outbox_event', undefined, 'PERMANENT'));
      await outbox('PUBLISHED', daysAgo(900));
      expect((await job().run(ctxOf(), NOW)).purged).toEqual({});
      expect(await count('outbox_event')).toBe(2);
      await publish(technical('user_session', 1));
      await session(daysAgo(300), daysAgo(301));
      expect((await job().run(ctxOf(), NOW)).purged).toEqual({});
    });

    it('does not let a policy keep an idempotency key that has expired', async () => {
      await publish(technical('idempotency_record', 5));
      await key(daysAgo(9), 1);
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: { idempotency_record: 1 } });
    });

    it('works on its own tenant only', async () => {
      await outbox('PUBLISHED', daysAgo(40), randomUUID(), TENANT_B);
      await project('B-1', '2000-01-01T03:00:00Z', 'CONCEPT', null, TENANT_B);
      await publish({ record_class: 'project_dossier', retention_years: 1 });
      expect(await job().run(ctxOf(), NOW)).toMatchObject({ purged: {}, listed: {} });
      expect(await count('outbox_event', 'true', TENANT_B)).toBe(1);
      expect(await count('retention_review_item', 'true', TENANT_B)).toBe(0);
    });

    it('records what it did in the audit trail of the tenant, once per kind of work', async () => {
      await publish({ record_class: 'project_dossier', retention_years: 1 });
      await project('P-1', '2020-01-01T03:00:00Z');
      await outbox('PUBLISHED', daysAgo(40));
      await job().run(ctxOf(), NOW);
      const actions = await admin<{ action: string; actor_id: string; safe_diff: Record<string, unknown> }>(
        "select action, actor_id, safe_diff from machvon.audit_event where action like 'retention.%' order by action",
      );
      expect(actions.map((row) => row.action)).toEqual(['retention.purged', 'retention.review_listed']);
      expect(actions.every((row) => row.actor_id === WORKER)).toBe(true);
      expect(actions[0]?.safe_diff).toMatchObject({ record_class: 'outbox_event', rows: 1 });
      expect(actions[1]?.safe_diff).toMatchObject({ record_class: 'project_dossier', items: 1, skipped_held: 0 });
      await job().run(ctxOf(), NOW);
      expect(await count('audit_event', "action like 'retention.%'")).toBe(2);
    });

    it('finishes the other classes when one fails, then fails naming the class only', async () => {
      await outbox('PUBLISHED', daysAgo(40));
      await session(daysAgo(200), daysAgo(201));
      await admin("create function machvon.retention_test_fail() returns trigger language plpgsql as $f$ begin raise exception 'boom with a secret value'; end $f$");
      await admin('create trigger retention_test_fail before delete on machvon.outbox_event for each row execute function machvon.retention_test_fail()');
      try {
        const failure = await job().run(ctxOf(), NOW).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RetentionRunFailed);
        expect((failure as RetentionRunFailed).classes).toEqual(['outbox_event']);
        expect((failure as RetentionRunFailed).message).not.toContain('secret');
        expect(await count('user_session')).toBe(0);
        expect(await count('outbox_event')).toBe(1);
      } finally {
        await admin('drop trigger retention_test_fail on machvon.outbox_event');
        await admin('drop function machvon.retention_test_fail()');
      }
    });
  });
});
