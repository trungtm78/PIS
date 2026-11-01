/* eslint-disable @typescript-eslint/no-explicit-any -- the replies of the API are read as the JSON they are */
import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, MasterStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { MasterMergeController, MasterMergeReadsController } from '../../src/modules/mdm/master-merge.controller';
import { mdmModule } from '../../src/modules/mdm';
import { liveRecordOfKey, tenantLookup } from '../../../../packages/db/src/master-types';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const CHECKER = 1; // master.merge and master.read
const DRAFTER = 2; // master.survivorship.manage and master.read
const PUBLISHER = 3; // master.survivorship.approve and master.read
const READER = 4; // master.read
const NOBODY = 5; // no right over the master data
const MAKER = 6; // made the entries
const B_CHECKER = 7; // of tenant B
const REASON = 'The two entries are the same contractor.';

interface Reply {
  status: number;
  json: Record<string, any>;
}

describe('the merge of master records and its undoing, and the rules of survivorship (ST-MDM-010, MDM 3.1 F5, MDM-30, MDM-35, MDM-36, UAT-AC274, UAT-AC275)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const asApp = (member: number, sql: string, params: unknown[] = []): Promise<unknown> =>
    harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, (tx) => tx.query(sql, params));

  interface Entry {
    id: string;
    key: string;
    versionId: string;
  }
  /** An entry in force of a type, with the version in force: its source, its label and attributes. */
  async function entry(
    type: string,
    input: { label?: string; attributes?: Record<string, unknown>; source?: string; namespace?: string; status?: string; createdBy?: number; validFrom?: string } = {},
  ): Promise<Entry> {
    counter += 1;
    const id = randomUUID();
    const versionId = randomUUID();
    const key = `${type}-${counter}-${id.slice(0, 6)}`;
    await rows(
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [TENANT_A, id, input.namespace ?? 'TENANT', type, key, input.status ?? 'EFFECTIVE', memberId(input.createdBy ?? MAKER)],
    );
    await rows(
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, source_system, published_at, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 1, $6, $7::jsonb, $11::date, 'EFFECTIVE', $8, $9, now(), $10, $10)`,
      [
        TENANT_A,
        versionId,
        id,
        type,
        key,
        input.label ?? key,
        JSON.stringify(input.attributes ?? {}),
        input.namespace ?? 'TENANT',
        input.source ?? 'TENANT',
        memberId(MAKER),
        input.validFrom ?? '2026-01-01',
      ],
    );
    await rows('update machvon.master_record set current_version_id = $2 where id = $1', [id, versionId]);
    return { id, key, versionId };
  }
  const recordOf = async (id: string) =>
    (
      await rows<{ status: string; merged_into_id: string | null; current_version_id: string; version: string }>(
        'select status, merged_into_id, current_version_id, version::text as version from machvon.master_record where id = $1',
        [id],
      )
    )[0] as { status: string; merged_into_id: string | null; current_version_id: string; version: string };
  const currentOf = async (id: string) =>
    (
      await rows<{ revision: number; label: string; attributes: Record<string, any>; valid_from: string; valid_until: string | null; status: string }>(
        `select v.revision, v.label, v.attributes, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.status from machvon.master_record_version v join machvon.master_record r on r.current_version_id = v.id where r.id = $1`,
        [id],
      )
    )[0] as { revision: number; label: string; attributes: Record<string, any>; valid_from: string; valid_until: string | null; status: string };
  const crosswalk = async (recordId: string, code: string, status = 'ACTIVE'): Promise<string> => {
    const id = randomUUID();
    await rows(
      `insert into machvon.master_crosswalk (tenant_id, id, master_record_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
       values ($1, $2, $3, 'TREASURY', 'AGENCY_CODE', $4, '2024-01-01', 'MANUAL', $5, $6, $6)`,
      [TENANT_A, id, recordId, `${code}-${id.slice(0, 6)}`, status, memberId(MAKER)],
    );
    return id;
  };
  const contractor = async (recordId: string): Promise<string> => {
    const id = randomUUID();
    await rows(
      `with doc as (
         insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
         values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Merge test registration certificate', 'INTERNAL', $2::uuid, $2::uuid)
       )
       insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, master_record_id)
       values (current_setting('app.tenant_id')::uuid, $1::uuid, '09' || lpad((('x' || right(replace($1::uuid::text, '-', ''), 6))::bit(24)::int)::text, 8, '0'), 'Merge test contractor', 'UNVERIFIED', $1::uuid, $2::uuid, $2::uuid, $3::uuid)`,
      [id, memberId(MAKER), recordId],
    );
    return id;
  };
  const pointingAt = async (table: string, recordId: string): Promise<string[]> =>
    (await rows<{ id: string }>(`select id from machvon.${table} where master_record_id = $1 order by id`, [recordId])).map((row) => row.id);

  const mergeNow = (member: number, survivor: string, merged: string, version?: number, extra: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    call('POST', `/master-records/${survivor}/merge`, {
      member,
      ifMatch: `"${version ?? 1}"`,
      body: { merged_record_id: merged, reason: REASON, ...extra },
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  const merge = async (...args: Parameters<typeof mergeNow>): Promise<Reply> => {
    const reply = await mergeNow(...args);
    if (reply.status === 200) await age(reply.json.merge_id);
    return reply;
  };
  /** The version of a record as the merge command is told it. */
  const versionOfRecord = async (id: string): Promise<number> => Number((await recordOf(id)).version);
  const unmergeNow = (member: number, mergeId: string, version: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/master-merges/${mergeId}/unmerge`, { member, ifMatch: `"${version}"`, body: { reason: 'The merge was a mistake.', ...extra } });
  const unmerge = async (member: number, mergeId: string, version: number, extra: Record<string, unknown> = {}): Promise<Reply> => {
    const reply = await unmergeNow(member, mergeId, version, extra);
    if (reply.status === 200) {
      const ends = (await rows<{ survivor_record_id: string; merged_record_id: string }>('select survivor_record_id, merged_record_id from machvon.master_merge where id = $1', [mergeId]))[0]!;
      await compress(ends.survivor_record_id);
      await compress(ends.merged_record_id);
    }
    return reply;
  };
  /** The version an undo starts today is made to have started the day after the one before it did, as in `age`: what a later command does then takes effect today. */
  async function compress(recordId: string): Promise<void> {
    const versions = await rows<{ id: string; valid_from: string; valid_until: string | null }>(
      'select id, valid_from::text as valid_from, valid_until::text as valid_until from machvon.master_record_version where master_record_id = $1 order by revision desc limit 2',
      [recordId],
    );
    const [latest, previous] = versions;
    if (latest === undefined || previous === undefined) return;
    const day = (await rows<{ day: string }>('select ($1::date + 1)::text as day', [previous.valid_from]))[0]!.day;
    if (latest.valid_from <= day) return;
    await rows('update machvon.master_record_version set valid_until = $2::date where id = $1 and valid_until > $2::date', [previous.id, day]);
    await rows('update machvon.master_record_version set valid_from = $2::date where id = $1', [latest.id, day]);
  }
  /**
   * A merge made today starts tomorrow for an entry whose version began today (a version cannot end the day it starts), and the store reads the real clock; so the merges of these tests are made to have happened
   * a day after the versions they ended began (long ago): what a later command does then takes effect today.
   */
  async function age(mergeId: string): Promise<void> {
    const found = await rows<{ alias_json: Record<string, any> }>('select alias_json from machvon.master_merge where id = $1', [mergeId]);
    if (found[0] === undefined) return;
    const { survivor, merged } = found[0].alias_json;
    const day = (
      await rows<{ day: string }>('select (max(valid_from) + 1)::text as day from machvon.master_record_version where id = any($1::uuid[])', [[survivor.version_before_id, merged.version_id]])
    )[0]!.day;
    await rows('update machvon.master_record_version set valid_until = $2::date where id = any($1::uuid[]) and valid_until > $2::date', [[survivor.version_before_id, merged.version_id], day]);
    await rows('update machvon.master_record_version set valid_from = $2::date where id = $1 and valid_from > $2::date', [survivor.version_after_id, day]);
  }
  const draftRule = (member: number, type: string, attribute: string, over: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', '/survivorship-rules', {
      member,
      body: { master_type: type, attribute_name: attribute, strategy: 'SOURCE_PRIORITY', source_priority: ['NATIONAL', 'TREASURY', 'TENANT'], effective_from: '2026-01-01', ...over },
    });
  const publishRule = (member: number, ruleId: string, version = 1): Promise<Reply> => call('POST', `/survivorship-rules/${ruleId}/publish`, { member, ifMatch: `"${version}"`, body: {} });
  async function publishedRule(type: string, attribute: string, over: Record<string, unknown> = {}): Promise<string> {
    const drafted = await draftRule(DRAFTER, type, attribute, over);
    expect(drafted.status).toBe(200);
    const published = await publishRule(PUBLISHER, drafted.json.resource_id, drafted.json.resource_version);
    expect([published.status, published.json.status]).toEqual([200, 'PUBLISHED']);
    return drafted.json.resource_id;
  }
  const events = (type: string) => rows<{ payload: Record<string, any> }>('select payload from machvon.outbox_event where type = $1 order by created_at', [type]);
  const audits = (action: string) =>
    rows<{ resource_id: string; safe_diff: Record<string, any> }>('select resource_id, safe_diff from machvon.audit_event where action = $1 order by occurred_at', [action]);
  const newType = (): string => `PARTY${(counter += 1)}`;
  /** The rules the pairs below are merged by: the phone follows the order NATIONAL, TREASURY, TENANT; the name stays the survivor's. */
  async function rulesFor(type: string): Promise<void> {
    await publishedRule(type, 'phone');
    await publishedRule(type, 'label', { source_priority: ['TENANT', 'NATIONAL', 'TREASURY'] });
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [CHECKER, DRAFTER, PUBLISHER, READER, NOBODY, MAKER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_CHECKER, 1);
    await harness.seedRole(TENANT_A, 1, 'MASTER_CHECKER', ['master.merge', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'SURVIVORSHIP_DRAFTER', ['master.survivorship.manage', 'master.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'SURVIVORSHIP_APPROVER', ['master.survivorship.approve', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'MASTER_READER', ['master.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'MASTER_CHECKER', ['master.merge', 'master.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: CHECKER, role: 1, kind: 'TENANT' },
      { n: 2, member: DRAFTER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_CHECKER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MasterMergeController, MasterMergeReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of MDM', () => {
    for (const controller of [MasterMergeController, MasterMergeReadsController]) expect(mdmModule.controllers).toContain(controller);
  });

  describe('the rules of survivorship', () => {
    it('are drafted by one person and published by another, and a new revision replaces the one before it', async () => {
      const type = newType();
      const first = await draftRule(DRAFTER, type, 'phone');
      expect([first.status, first.json.status, first.json.resource_version]).toEqual([200, 'DRAFT', 1]);
      expect(await publishRule(DRAFTER, first.json.resource_id)).toMatchObject({ status: 403 });
      const own = await call('POST', `/survivorship-rules/${first.json.resource_id}/publish`, { member: PUBLISHER, ifMatch: '"9"', body: {} });
      expect(own.json.code).toBe('VERSION_CONFLICT');
      expect((await publishRule(PUBLISHER, first.json.resource_id)).json).toMatchObject({ status: 'PUBLISHED', resource_version: 2 });
      expect((await publishRule(PUBLISHER, first.json.resource_id, 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      const second = await draftRule(DRAFTER, type, 'phone', { strategy: 'MOST_RECENT', source_priority: [] });
      expect((await publishRule(PUBLISHER, second.json.resource_id)).status).toBe(200);
      const listed = (await call('GET', `/survivorship-rules?master_type=${type}`, { member: READER })).json.items as Array<{ revision: number; status: string; strategy: string }>;
      expect(listed.map((rule) => [rule.revision, rule.status, rule.strategy])).toEqual([
        [2, 'PUBLISHED', 'MOST_RECENT'],
        [1, 'RETIRED', 'SOURCE_PRIORITY'],
      ]);
      expect(
        (await audits('master.survivorship_rule_published')).some(
          (entry) => entry.resource_id === second.json.resource_id && (entry.safe_diff.retired_ids as string[]).includes(first.json.resource_id),
        ),
      ).toBe(true);
    });

    it('keeps the revision in force deciding until the day the next one takes effect, and refuses a draft that a later revision overrides from its day', async () => {
      const type = newType();
      const first = await publishedRule(type, 'phone');
      const future = await publishedRule(type, 'phone', { strategy: 'MOST_RECENT', source_priority: [], effective_from: '2099-01-01' });
      const listed = (await call('GET', `/survivorship-rules?master_type=${type}`, { member: READER })).json.items as Array<{ id: string; status: string }>;
      expect(listed.map((rule) => [rule.id, rule.status]).sort()).toEqual(
        [
          [first, 'PUBLISHED'],
          [future, 'PUBLISHED'],
        ].sort(),
      );
      // The one in force still settles the phone today.
      const { survivor, merged } = await (async () => {
        const survivor = await entry(type, { label: 'A', attributes: { phone: 'tenant-phone' }, source: 'TENANT' });
        const merged = await entry(type, { label: 'A', attributes: { phone: 'national-phone' }, source: 'NATIONAL' });
        return { survivor, merged };
      })();
      expect((await merge(CHECKER, survivor.id, merged.id)).status).toBe(200);
      expect((await currentOf(survivor.id)).attributes.phone).toBe('national-phone');
      // A revision for an earlier day than the future one replaces it; a draft made before and overridden from its day is refused.
      const stale = await draftRule(DRAFTER, type, 'phone', { effective_from: '2099-06-01' });
      const newest = await draftRule(DRAFTER, type, 'phone', { effective_from: '2098-01-01' });
      expect((await publishRule(PUBLISHER, newest.json.resource_id)).status).toBe(200);
      expect(((await call('GET', `/survivorship-rules?master_type=${type}&status=RETIRED`, { member: READER })).json.items as Array<{ id: string }>).map((rule) => rule.id)).toEqual([future]);
      expect(await publishRule(PUBLISHER, stale.json.resource_id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('is the same person publishing their own draft refused by the table as well', async () => {
      const drafted = await draftRule(DRAFTER, newType(), 'phone');
      await expect(asApp(PUBLISHER, "update machvon.survivorship_rule set status = 'PUBLISHED', approved_by = created_by where id = $1", [drafted.json.resource_id])).rejects.toMatchObject({
        code: '23514',
      });
      await expect(asApp(PUBLISHER, "update machvon.survivorship_rule set strategy = 'MOST_RECENT' where id = $1", [drafted.json.resource_id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(PUBLISHER, 'delete from machvon.survivorship_rule where id = $1', [drafted.json.resource_id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(PUBLISHER, 'truncate machvon.survivorship_rule')).rejects.toMatchObject({ code: '42501' });
    });

    it.each([
      ['a strategy that is none', { strategy: 'LUCK' }, 'strategy'],
      ['SOURCE_PRIORITY with no order', { source_priority: [] }, 'source_priority'],
      ['a source twice', { source_priority: ['NATIONAL', 'NATIONAL'] }, 'source_priority'],
      ['a day that is none', { effective_from: '2026-02-30' }, 'effective_from'],
      ['an attribute that is empty', { attribute_name: ' ' }, 'attribute_name'],
    ])('refuse a draft with %s', async (_name, over, detail) => {
      const reply = await draftRule(DRAFTER, newType(), 'phone', over);
      expect([reply.status, reply.json.detail]).toEqual([422, detail]);
    });

    it('are for those who may: drafting needs the right to manage them, publishing the right to approve them', async () => {
      expect((await draftRule(READER, newType(), 'phone')).status).toBe(403);
      expect((await draftRule(CHECKER, newType(), 'phone')).status).toBe(403);
      const drafted = await draftRule(DRAFTER, newType(), 'phone');
      expect((await publishRule(CHECKER, drafted.json.resource_id)).status).toBe(403);
      expect((await publishRule(NOBODY, drafted.json.resource_id)).status).toBe(403);
      expect((await call('GET', '/survivorship-rules', { member: NOBODY })).status).toBe(403);
      expect((await publishRule(PUBLISHER, randomUUID())).status).toBe(404);
      for (const query of ['?status=NEARLY', '?limit=0', '?cursor=bad']) expect((await call('GET', `/survivorship-rules${query}`, { member: READER })).status).toBe(422);
    });
  });

  describe('the merge (UAT-AC274)', () => {
    async function pair(type: string, over: { phone?: [string, string]; sources?: [string, string] } = {}) {
      const [survivorPhone, mergedPhone] = over.phone ?? ['tenant-phone', 'national-phone'];
      const [survivorSource, mergedSource] = over.sources ?? ['TENANT', 'NATIONAL'];
      const survivor = await entry(type, { label: 'CONTRACTOR-A2', attributes: { tax_code: '0101', phone: survivorPhone }, source: survivorSource });
      const merged = await entry(type, { label: 'CONTRACTOR-A', attributes: { tax_code: '0101', phone: mergedPhone, address: 'Cao Bang' }, source: mergedSource });
      return { survivor, merged };
    }

    it('settles each attribute by the rule that is published, points the references that are alive at the survivor, and keeps the history', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const refs = [await crosswalk(merged.id, 'A'), await crosswalk(merged.id, 'B'), await crosswalk(merged.id, 'C'), await contractor(merged.id)];
      const retired = await crosswalk(merged.id, 'OLD', 'RETIRED');
      const done = await merge(CHECKER, survivor.id, merged.id);
      expect([done.status, done.json.status, done.json.resource_version, done.json.repointed]).toEqual([200, 'MERGED', 2, 4]);
      // The survivor has a new version that follows the order of the sources for the phone, and carries what only the merged entry had.
      const after = await currentOf(survivor.id);
      expect(after).toMatchObject({ revision: 2, label: 'CONTRACTOR-A2', status: 'EFFECTIVE', valid_until: null });
      expect(after.attributes).toEqual({ tax_code: '0101', phone: 'national-phone', address: 'Cao Bang' });
      const old = (
        await rows<{ valid_until: string | null; status: string }>('select valid_until::text as valid_until, status from machvon.master_record_version where id = $1', [survivor.versionId])
      )[0];
      expect(old?.valid_until).toBe(after.valid_from);
      // The entry that was merged away is MERGED and points at the survivor; its version ends where the merge starts.
      expect(await recordOf(merged.id)).toMatchObject({ status: 'MERGED', merged_into_id: survivor.id });
      expect(
        (await rows<{ status: string; valid_until: string | null }>('select status, valid_until::text as valid_until from machvon.master_record_version where id = $1', [merged.versionId]))[0],
      ).toMatchObject({ status: 'RETIRED', valid_until: after.valid_from });
      // The references that were alive point at the survivor; the retired crosswalk is where it was.
      expect(await pointingAt('master_crosswalk', survivor.id)).toEqual([...refs.slice(0, 3)].sort());
      expect(await pointingAt('contractor', survivor.id)).toEqual([refs[3]]);
      expect(await pointingAt('master_crosswalk', merged.id)).toEqual([retired]);
      // What was recorded.
      const stored = (await call('GET', `/master-merges?record_id=${survivor.id}`, { member: READER })).json.items[0];
      expect(stored).toMatchObject({
        id: done.json.merge_id,
        status: 'APPLIED',
        survivor_record_id: survivor.id,
        merged_record_id: merged.id,
        survivor_key: survivor.key,
        merged_key: merged.key,
        reason: REASON,
      });
      expect(stored.decisions).toEqual(
        expect.arrayContaining([
          { attribute: 'phone', chosen: 'MERGED', by: 'RULE', strategy: 'SOURCE_PRIORITY', source: 'NATIONAL' },
          { attribute: 'address', chosen: 'MERGED', by: 'ONLY_ONE', strategy: null, source: 'NATIONAL' },
          { attribute: 'tax_code', chosen: 'SURVIVOR', by: 'EQUAL', strategy: null, source: 'TENANT' },
        ]),
      );
      expect(stored.repointed).toHaveLength(4);
      expect(stored.aliases).toEqual({ merged_key: merged.key, merged_label: 'CONTRACTOR-A' });
      expect((await rows<{ change_kind: string; status: string }>('select change_kind, status from machvon.master_change_request where master_record_id = $1', [survivor.id]))[0]).toMatchObject({
        change_kind: 'MERGE',
        status: 'APPLIED',
      });
      expect((await events('master.merged.v1')).some((event) => event.payload.merge_id === done.json.merge_id && event.payload.merged_record_id === merged.id)).toBe(true);
      expect((await audits('master.merged')).some((entry) => entry.resource_id === survivor.id && entry.safe_diff.repointed === 4)).toBe(true);
    });

    it('undoes the merge: the survivor gets back what it took, the merged entry returns as it was, and the four references go back', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const refs = [await crosswalk(merged.id, 'A'), await crosswalk(merged.id, 'B'), await crosswalk(merged.id, 'C'), await contractor(merged.id)];
      const versionOfContractor = async (): Promise<number> =>
        Number((await rows<{ version: string }>('select version::text as version from machvon.contractor where id = $1', [refs[3]]))[0]?.version);
      const contractorBefore = await versionOfContractor();
      const done = await merge(CHECKER, survivor.id, merged.id);
      const mergeId = done.json.merge_id as string;
      // A verification made against the contractor as it was read no longer fits once its master record moved, either way.
      expect(await versionOfContractor()).toBe(contractorBefore + 1);
      const undone = await unmerge(CHECKER, mergeId, 1);
      expect(await versionOfContractor()).toBe(contractorBefore + 2);
      expect([undone.status, undone.json.status, undone.json.restored, undone.json.not_restored]).toEqual([200, 'REVERTED', 4, []]);
      expect(undone.json.reverted.sort()).toEqual(['address', 'phone']);
      // The survivor is as it was before the merge, in a new version; the merged entry is in force again as it was.
      const survivorNow = await currentOf(survivor.id);
      expect(survivorNow.attributes).toEqual({ tax_code: '0101', phone: 'tenant-phone' });
      expect(survivorNow.revision).toBe(3);
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE', merged_into_id: null });
      expect(await currentOf(merged.id)).toMatchObject({
        revision: 2,
        label: 'CONTRACTOR-A',
        status: 'EFFECTIVE',
        valid_until: null,
        attributes: { tax_code: '0101', phone: 'national-phone', address: 'Cao Bang' },
      });
      expect(await pointingAt('master_crosswalk', merged.id)).toEqual([...refs.slice(0, 3)].sort());
      expect(await pointingAt('contractor', merged.id)).toEqual([refs[3]]);
      expect(await pointingAt('master_crosswalk', survivor.id)).toEqual([]);
      const stored = (await call('GET', `/master-merges?record_id=${merged.id}`, { member: READER })).json.items[0];
      expect(stored).toMatchObject({ status: 'REVERTED', revert_reason: 'The merge was a mistake.', reverted_by: memberId(CHECKER) });
      expect((await events('master.unmerged.v1')).some((event) => event.payload.merge_id === mergeId)).toBe(true);
      // A merge is undone once (UAT-PLAN-56).
      expect(await unmerge(CHECKER, mergeId, 2)).toMatchObject({ status: 409, json: { code: 'MERGE_ALREADY_REVERTED' } });
      // The same entries can be merged again.
      expect((await merge(CHECKER, survivor.id, merged.id, await versionOfRecord(survivor.id))).status).toBe(200);
    });

    it('refuses to undo a merge when the survivor edited what it took from the merged entry (409 UNMERGE_CONFLICT) until a steward decides (UAT-AC275)', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const refs = [await crosswalk(merged.id, 'A')];
      const done = await merge(CHECKER, survivor.id, merged.id);
      // The steward edits the phone of the survivor after the merge: a new version.
      const current = await currentOf(survivor.id);
      const edited = randomUUID();
      const editDay = (await rows<{ day: string }>('select ($1::date + 1)::text as day', [current.valid_from]))[0]!.day;
      await rows('update machvon.master_record_version set valid_until = $2::date where master_record_id = $1 and valid_until is null', [survivor.id, editDay]);
      await rows(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, source_system, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'CONTRACTOR-A2', $7::jsonb, $9::date, 'EFFECTIVE', 'TENANT', 'TENANT', now(), $8, $8)`,
        [TENANT_A, edited, survivor.id, type, survivor.key, current.revision + 1, JSON.stringify({ ...current.attributes, phone: 'edited-phone' }), memberId(MAKER), editDay],
      );
      await rows('update machvon.master_record set current_version_id = $2 where id = $1', [survivor.id, edited]);
      const refused = await unmerge(CHECKER, done.json.merge_id, 1);
      expect([refused.status, refused.json.code, refused.json.attributes]).toEqual([409, 'UNMERGE_CONFLICT', ['phone']]);
      expect(await recordOf(merged.id)).toMatchObject({ status: 'MERGED' });
      expect(await pointingAt('master_crosswalk', survivor.id)).toEqual(refs);
      // An answer about an attribute that is not in conflict, or that is none, is refused.
      expect((await unmerge(CHECKER, done.json.merge_id, 1, { steward_decisions: { phone: 'MAYBE' } })).json.detail).toBe('steward_decisions.phone');
      expect((await unmerge(CHECKER, done.json.merge_id, 1, { steward_decisions: { phone: 'KEEP', address: 'KEEP' } })).json.detail).toBe('steward_decisions.address');
      const decided = await unmerge(CHECKER, done.json.merge_id, 1, { steward_decisions: { phone: 'KEEP' } });
      expect([decided.status, decided.json.kept, decided.json.reverted]).toEqual([200, ['phone'], ['address']]);
      expect((await currentOf(survivor.id)).attributes).toEqual({ tax_code: '0101', phone: 'edited-phone' });
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE' });
      expect((await audits('master.unmerged')).some((entry) => entry.resource_id === done.json.merge_id && entry.safe_diff.steward_decisions.includes('phone'))).toBe(true);
    });

    it('is a conflict when no rule settles an attribute (409 MERGE_CONFLICT naming them), until a steward settles it', async () => {
      const type = newType();
      const { survivor, merged } = await pair(type);
      const refused = await merge(CHECKER, survivor.id, merged.id);
      expect([refused.status, refused.json.code, refused.json.attributes]).toEqual([409, 'MERGE_CONFLICT', ['label', 'phone']]);
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE' });
      expect((await rows('select 1 from machvon.master_merge where survivor_record_id = $1', [survivor.id])).length).toBe(0);
      // An override for something that is not in conflict, or that is no side, is refused.
      expect((await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { tax_code: 'MERGED', phone: 'MERGED', label: 'MERGED' } })).json.detail).toBe(
        'survivorship_overrides.tax_code',
      );
      expect((await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { phone: 'BOTH', label: 'MERGED' } })).json.detail).toBe('survivorship_overrides.phone');
      expect((await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: 'phone' })).json.detail).toBe('survivorship_overrides');
      const done = await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { phone: 'SURVIVOR', label: 'SURVIVOR' } });
      expect(done.status).toBe(200);
      expect((await currentOf(survivor.id)).attributes.phone).toBe('tenant-phone');
      expect((await call('GET', `/master-merges?record_id=${survivor.id}`, { member: READER })).json.items[0].decisions).toEqual(
        expect.arrayContaining([{ attribute: 'phone', chosen: 'SURVIVOR', by: 'OVERRIDE', strategy: null, source: 'TENANT' }]),
      );
    });

    it('is refused for an entry with a change that waits: a version published for a later day, or a change that is open (409 STAGE_TRANSITION_DENIED)', async () => {
      const type = newType();
      const { survivor, merged } = await pair(type);
      await rulesFor(type);
      // A published change for a later day has closed the version in force at that day.
      await rows("update machvon.master_record_version set valid_until = '2099-01-01' where id = $1", [survivor.versionId]);
      await rows(
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, source_system, published_at, created_by, updated_by)
         select tenant_id, gen_random_uuid(), master_record_id, master_type, code, 2, label, attributes, '2099-01-01', 'APPROVED', namespace, source_system, now(), created_by, updated_by
           from machvon.master_record_version where id = $1`,
        [survivor.versionId],
      );
      expect(await merge(CHECKER, survivor.id, merged.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await merge(CHECKER, merged.id, survivor.id, await versionOfRecord(merged.id))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect((await currentOf(survivor.id)).revision).toBe(1);
      const other = await pair(type);
      await rows(
        `insert into machvon.master_change_request (tenant_id, id, master_record_id, master_type, change_kind, status, reason, proposed_json, effective_from, created_by, updated_by)
         values ($1, $2, $3, $4, 'UPDATE', 'DRAFT', 'An open change of the entry.', '{}'::jsonb, '2099-01-01', $5, $5)`,
        [TENANT_A, randomUUID(), other.merged.id, type, memberId(MAKER)],
      );
      expect(await merge(CHECKER, other.survivor.id, other.merged.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('is not made the day a version of either entry began: a version cannot end the day it starts, so the merge waits for tomorrow and nothing is half done', async () => {
      const { today } = (await rows<{ today: string }>("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today"))[0]!;
      const type = newType();
      await rulesFor(type);
      const survivor = await entry(type, { label: 'A', attributes: { phone: 'p-1' }, source: 'TENANT', validFrom: today });
      const merged = await entry(type, { label: 'A', attributes: { phone: 'p-2' }, source: 'NATIONAL' });
      const crosswalkId = await crosswalk(merged.id, 'A');
      expect(await mergeNow(CHECKER, survivor.id, merged.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await mergeNow(CHECKER, merged.id, survivor.id, await versionOfRecord(merged.id))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE', merged_into_id: null });
      expect(await pointingAt('master_crosswalk', merged.id)).toEqual([crosswalkId]);
      expect((await currentOf(survivor.id)).revision).toBe(1);
      expect((await rows('select 1 from machvon.master_merge where survivor_record_id = $1 or merged_record_id = $1', [survivor.id])).length).toBe(0);
    });

    it('refuses a merge whose result breaks the rules of the type (422), and writes nothing', async () => {
      await publishedRule('PROGRAM', 'period_from', { source_priority: ['NATIONAL', 'TENANT'] });
      const survivor = await entry('PROGRAM', { label: 'Same', attributes: { kind: 'LOCAL', period_from: 2021, period_to: 2025 }, source: 'TENANT' });
      const merged = await entry('PROGRAM', { label: 'Same', attributes: { kind: 'LOCAL', period_from: 2026, period_to: 2030 }, source: 'NATIONAL' });
      // The rule takes the start of the later program and the steward keeps the end of the earlier one: 2026 to 2025.
      const refused = await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { period_to: 'SURVIVOR' } });
      expect([refused.status, refused.json.detail]).toEqual([422, 'attributes.period_to']);
      expect((await rows('select 1 from machvon.master_merge where survivor_record_id = $1', [survivor.id])).length).toBe(0);
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE' });
      expect((await currentOf(survivor.id)).revision).toBe(1);
      const fine = await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { period_to: 'MERGED' } });
      expect(fine.status).toBe(200);
      expect((await currentOf(survivor.id)).attributes).toMatchObject({ period_from: 2026, period_to: 2030 });
    });

    it('keeps the end date the entries were approved for, for the survivor and for the entry that comes back, and refuses an entry that has run out', async () => {
      const type = newType();
      await rulesFor(type);
      const survivor = await entry(type, { label: 'A', attributes: { phone: 'p-1' }, source: 'TENANT' });
      const merged = await entry(type, { label: 'A', attributes: { phone: 'p-2' }, source: 'NATIONAL' });
      await rows("update machvon.master_record_version set valid_until = '2099-12-31' where id = any($1::uuid[])", [[survivor.versionId, merged.versionId]]);
      const done = await merge(CHECKER, survivor.id, merged.id);
      expect(done.status).toBe(200);
      expect((await currentOf(survivor.id)).valid_until).toBe('2099-12-31');
      expect((await unmerge(CHECKER, done.json.merge_id, 1)).status).toBe(200);
      expect((await currentOf(survivor.id)).valid_until).toBe('2099-12-31');
      expect((await currentOf(merged.id)).valid_until).toBe('2099-12-31');
      // An entry whose version ends before the merge takes effect has run out.
      const old = await entry(type, { label: 'B', attributes: { phone: 'p-1' } });
      const other = await entry(type, { label: 'B', attributes: { phone: 'p-1' } });
      await rows("update machvon.master_record_version set valid_until = '2026-07-01' where id = $1", [old.versionId]);
      expect(await merge(CHECKER, old.id, other.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('finds the survivor by the key of the entry that was merged away, and still finds the entry itself as of a day before the merge', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const done = await merge(CHECKER, survivor.id, merged.id);
      expect(done.status).toBe(200);
      const byKey = (key: string, asOf = vietnamDateOf(new Date())) =>
        harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(READER), scopeVersion: 1 }, (tx) =>
          new MasterStore().search(tx, { masterType: type, businessKey: key, asOf, limit: 10, after: undefined }),
        );
      expect((await byKey(merged.key)).map((row) => [row.id, row.status])).toEqual([[survivor.id, 'EFFECTIVE']]);
      expect((await byKey(survivor.key)).map((row) => row.id)).toEqual([survivor.id]);
      // Before the day of the merge the entry was in force under its own key.
      expect((await byKey(merged.key, '2026-01-01')).map((row) => [row.id, row.status])).toEqual([[merged.id, 'MERGED']]);
      // A chain: the key of the first entry leads to the last survivor.
      const third = await entry(type, { label: 'CONTRACTOR-A2', attributes: { tax_code: '0101', phone: 'tenant-phone', address: 'Cao Bang' }, source: 'NATIONAL' });
      const second = await merge(CHECKER, third.id, survivor.id, await versionOfRecord(third.id));
      expect(second.status).toBe(200);
      expect((await byKey(merged.key)).map((row) => row.id)).toEqual([third.id]);
      expect((await byKey(survivor.key)).map((row) => row.id)).toEqual([third.id]);
      // Each hop is taken on the day asked: between the two merges the first key leads to the first survivor only.
      await rows(`update machvon.master_merge set alias_json = jsonb_set(alias_json, '{day}', to_jsonb($2::text)) where id = $1`, [done.json.merge_id, '2026-01-02']);
      await rows(`update machvon.master_merge set alias_json = jsonb_set(alias_json, '{day}', to_jsonb($2::text)) where id = $1`, [second.json.merge_id, '2026-01-03']);
      expect((await byKey(merged.key, '2026-01-02')).map((row) => row.id)).toEqual([survivor.id]);
      expect((await byKey(merged.key, '2026-01-03')).map((row) => row.id)).toEqual([third.id]);
      // A merge that was undone no longer leads anywhere from the day it was undone.
      expect((await unmerge(CHECKER, second.json.merge_id, 1)).status).toBe(200);
      expect((await byKey(survivor.key)).map((row) => [row.id, row.status])).toEqual([[survivor.id, 'EFFECTIVE']]);
      expect((await byKey(merged.key)).map((row) => row.id)).toEqual([survivor.id]);
      // Undone as well, the entry is itself again today, and the days of the merge still lead to the survivor and to it alone.
      expect((await unmerge(CHECKER, done.json.merge_id, 1)).status).toBe(200);
      expect((await byKey(merged.key)).map((row) => row.id)).toEqual([merged.id]);
      // The entry was away from 2026-01-02 to 2026-01-05, and for those days the key leads to the survivor only.
      await rows(
        'update machvon.master_record_version set valid_from = $2::date where master_record_id = $1 and revision = (select max(revision) from machvon.master_record_version where master_record_id = $1)',
        [merged.id, '2026-01-05'],
      );
      expect((await byKey(merged.key, '2026-01-02')).map((row) => row.id)).toEqual([survivor.id]);
      expect((await byKey(merged.key, '2026-01-05')).map((row) => row.id)).toEqual([merged.id]);
    });

    it('cannot be undone the day it took effect for a survivor whose version began that day: the two entries come back together, or not at all', async () => {
      const type = newType();
      await rulesFor(type);
      const survivor = await entry(type, { label: 'A', attributes: { phone: 'p-1' }, source: 'TENANT' });
      const merged = await entry(type, { label: 'A', attributes: { phone: 'p-2', address: 'Cao Bang' }, source: 'NATIONAL' });
      const done = await mergeNow(CHECKER, survivor.id, merged.id);
      expect(done.status).toBe(200);
      expect(await unmerge(CHECKER, done.json.merge_id, 1)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await recordOf(merged.id)).toMatchObject({ status: 'MERGED', merged_into_id: survivor.id });
      expect((await rows<{ status: string }>('select status from machvon.master_merge where id = $1', [done.json.merge_id]))[0]?.status).toBe('APPLIED');
      expect((await currentOf(survivor.id)).attributes).toMatchObject({ phone: 'p-2', address: 'Cao Bang' });
    });

    it('lets the key of an entry that was merged away stand for the survivor when another entry refers to it', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const lookup = (key: string) => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(READER), scopeVersion: 1 }, (tx) => tenantLookup(tx).entry(type, key));
      expect(await lookup(merged.key)).toMatchObject({ businessKey: merged.key, attributes: { tax_code: '0101' } });
      expect(await lookup('NO-SUCH-KEY')).toBeUndefined();
      expect((await merge(CHECKER, survivor.id, merged.id)).status).toBe(200);
      expect(await lookup(merged.key)).toMatchObject({ businessKey: merged.key, attributes: { tax_code: '0101', address: 'Cao Bang' } });
      expect((await unmerge(CHECKER, (await rows<{ id: string }>('select id from machvon.master_merge where survivor_record_id = $1', [survivor.id]))[0]!.id, 1)).status).toBe(200);
      expect((await lookup(merged.key))?.attributes).toMatchObject({ phone: 'national-phone' });
    });

    it('leaves the rule data of a module to its owner: a checker who is not an approver of the type cannot merge it, even where the tenant owns it (BR-MDM-09)', async () => {
      const type = 'RETENTION_POLICY';
      await rows("insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, $2, 'TENANT_ONLY', $3) on conflict do nothing", [TENANT_A, type, memberId(MAKER)]);
      const survivor = await entry(type, { label: 'Same' });
      const merged = await entry(type, { label: 'Same' });
      expect(await merge(CHECKER, survivor.id, merged.id)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      // An approver of the type is past that door (what stops the merge then is the content of the entries).
      await rows('insert into machvon.master_type_approver (tenant_id, master_type, membership_id, granted_by) values ($1, $2, $3, $4)', [TENANT_A, type, memberId(CHECKER), memberId(MAKER)]);
      expect(await merge(CHECKER, survivor.id, merged.id)).toMatchObject({ status: 422, json: { detail: 'legal_basis' } });
      await rows('delete from machvon.master_type_approver where master_type = $1', [type]);
      await rows('delete from machvon.master_type_policy where master_type = $1', [type]);
    });

    it('refuses an entry that has run out on the day of the merge, whichever side it is on', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      await rows("update machvon.master_record_version set valid_until = '2026-07-01' where id = $1", [merged.versionId]);
      expect(await merge(CHECKER, survivor.id, merged.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await recordOf(merged.id)).toMatchObject({ status: 'EFFECTIVE' });
    });

    it('lets issue intake and the other readers of an entry by its key find the survivor of an entry that was merged away', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const live = (key: string) => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(READER), scopeVersion: 1 }, (tx) => liveRecordOfKey(tx, type, key));
      expect(await live(merged.key)).toEqual({ recordId: merged.id, currentVersionId: merged.versionId });
      const done = await merge(CHECKER, survivor.id, merged.id);
      expect(done.status).toBe(200);
      const current = (await rows<{ current_version_id: string }>('select current_version_id from machvon.master_record where id = $1', [survivor.id]))[0]!.current_version_id;
      expect(await live(merged.key)).toEqual({ recordId: survivor.id, currentVersionId: current });
      expect(await live('NO-SUCH-KEY')).toBeUndefined();
      expect((await unmerge(CHECKER, done.json.merge_id, 1)).status).toBe(200);
      expect((await live(merged.key))?.recordId).toBe(merged.id);
    });

    it('keeps an attribute that is itself called label apart from the name of the entry, and gives it back when the merge is undone', async () => {
      const type = newType();
      const survivor = await entry(type, { label: 'Same name', attributes: { label: 'nested-survivor' }, source: 'TENANT' });
      const merged = await entry(type, { label: 'Same name', attributes: { label: 'nested-merged' }, source: 'NATIONAL' });
      const refused = await merge(CHECKER, survivor.id, merged.id);
      expect([refused.status, refused.json.attributes]).toEqual([409, ['~label']]);
      const done = await merge(CHECKER, survivor.id, merged.id, 1, { survivorship_overrides: { '~label': 'MERGED' } });
      expect(done.status).toBe(200);
      expect(await currentOf(survivor.id)).toMatchObject({ label: 'Same name', attributes: { label: 'nested-merged' } });
      const undone = await unmerge(CHECKER, done.json.merge_id, 1);
      expect([undone.status, undone.json.reverted]).toEqual([200, ['~label']]);
      expect(await currentOf(survivor.id)).toMatchObject({ label: 'Same name', attributes: { label: 'nested-survivor' } });
    });

    it('is refused for an entry of the platform (403 POLICY_LOCKED), for a type the platform owns, and for who made either entry (403 SELF_APPROVAL_DENIED)', async () => {
      const type = newType();
      const platform = await entry(type, { namespace: 'PLATFORM' });
      const own = await entry(type);
      expect(await merge(CHECKER, own.id, platform.id)).toMatchObject({ status: 403, json: { code: 'POLICY_LOCKED' } });
      expect(await merge(CHECKER, platform.id, own.id)).toMatchObject({ status: 403, json: { code: 'POLICY_LOCKED' } });
      const owned = { survivor: await entry('FUND_SOURCE'), merged: await entry('FUND_SOURCE') };
      expect((await merge(CHECKER, owned.survivor.id, owned.merged.id)).json.code).toBe('POLICY_LOCKED');
      const madeByChecker = await entry(type, { createdBy: CHECKER });
      expect(await merge(CHECKER, own.id, madeByChecker.id)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await merge(CHECKER, madeByChecker.id, own.id)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    });

    it('is refused for entries that are the same, of another type, unknown, not in force, or already merged; and against a version that is not the one read', async () => {
      const type = newType();
      const a = await entry(type, { label: 'Same name' });
      const b = await entry(type, { label: 'Same name' });
      expect((await merge(CHECKER, a.id, a.id)).json.detail).toBe('merged_record_id');
      expect((await merge(CHECKER, a.id, (await entry(newType())).id)).json.detail).toBe('merged_record_id');
      expect((await merge(CHECKER, a.id, randomUUID())).json.detail).toBe('merged_record_id');
      expect((await merge(CHECKER, randomUUID(), a.id)).status).toBe(404);
      expect((await merge(CHECKER, a.id, b.id, 7)).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await call('POST', `/master-records/${a.id}/merge`, { member: CHECKER, ifMatch: '"1"', body: { merged_record_id: b.id, reason: 'short' } })).json.detail).toBe('reason');
      const retired = await entry(type, { status: 'RETIRED' });
      expect(await merge(CHECKER, a.id, retired.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await merge(CHECKER, retired.id, a.id)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect((await merge(CHECKER, a.id, b.id)).status).toBe(200);
      // An entry that was merged away cannot be merged again or be a survivor: the circle is closed.
      const c = await entry(type, { label: 'Same name' });
      expect(await merge(CHECKER, c.id, b.id, await versionOfRecord(c.id))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect(await merge(CHECKER, b.id, c.id, await versionOfRecord(b.id))).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    });

    it('cannot undo a merge while the survivor itself is merged away, and each merge is undone in its turn', async () => {
      const type = newType();
      await rulesFor(type);
      const a = await entry(type, { attributes: { phone: 'a' }, source: 'TREASURY' });
      const b = await entry(type, { attributes: { phone: 'b' }, source: 'TENANT' });
      const c = await entry(type, { attributes: { phone: 'c' }, source: 'NATIONAL' });
      const first = await merge(CHECKER, b.id, c.id);
      const second = await merge(CHECKER, a.id, b.id, await versionOfRecord(a.id));
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await unmerge(CHECKER, first.json.merge_id, 1)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      expect((await unmerge(CHECKER, second.json.merge_id, 1)).status).toBe(200);
      expect((await unmerge(CHECKER, first.json.merge_id, 1)).status).toBe(200);
      expect((await recordOf(c.id)).status).toBe('EFFECTIVE');
    });

    it('is for the checker alone, and another tenant sees none of it', async () => {
      const type = newType();
      const a = await entry(type);
      const b = await entry(type);
      expect((await merge(READER, a.id, b.id)).status).toBe(403);
      expect((await merge(DRAFTER, a.id, b.id)).status).toBe(403);
      expect((await merge(NOBODY, a.id, b.id)).status).toBe(403);
      expect((await merge(B_CHECKER, a.id, b.id, 1, {}, TENANT_B)).status).toBe(404);
      expect((await call('GET', '/master-merges', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/master-merges', { member: B_CHECKER, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await unmerge(READER, randomUUID(), 1)).status).toBe(403);
      expect((await unmerge(CHECKER, randomUUID(), 1)).status).toBe(404);
      expect((await rows('select 1 from machvon.master_merge where merged_record_id = $1', [b.id])).length).toBe(0);
    });

    it('lists the merges newest first, by entry and by state, a page at a time', async () => {
      const type = newType();
      await rulesFor(type);
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const { survivor, merged } = await pair(type);
        made.push((await merge(CHECKER, survivor.id, merged.id)).json.merge_id);
      }
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await call('GET', `/master-merges?limit=1${cursor}`, { member: READER });
        seen.push(...reply.json.items.map((item: { id: string }) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${reply.json.next_cursor as string}`;
      }
      expect(seen.slice(0, 3)).toEqual([...made].reverse());
      await unmerge(CHECKER, made[0] as string, 1);
      expect((await call('GET', '/master-merges?status=REVERTED', { member: READER })).json.items.map((item: { id: string }) => item.id)).toContain(made[0]);
      for (const query of ['?status=NEARLY', '?record_id=x', '?limit=0', '?limit=201', '?cursor=bad']) expect((await call('GET', `/master-merges${query}`, { member: READER })).status).toBe(422);
    });

    it('is recorded for good: the table refuses to change what it recorded, to undo it twice or to delete it', async () => {
      const type = newType();
      await rulesFor(type);
      const { survivor, merged } = await pair(type);
      const done = await merge(CHECKER, survivor.id, merged.id);
      const id = done.json.merge_id as string;
      await expect(asApp(CHECKER, "update machvon.master_merge set reason = 'rewritten for the audit' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(CHECKER, "update machvon.master_merge set survivorship_json = '{}'::jsonb where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(CHECKER, 'delete from machvon.master_merge where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(CHECKER, 'truncate machvon.master_merge')).rejects.toMatchObject({ code: '42501' });
      await unmerge(CHECKER, id, 1);
      await expect(asApp(CHECKER, "update machvon.master_merge set status = 'REVERTED', revert_reason = 'another reason' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    });
  });
});
