import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { exifJpeg, loadErrorRegistry, signTenantContext, strippedJpeg } from '@machvon/kernel';
import type { ExifJpegInput } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { PhotoController, PhotoReadsController } from '../../src/modules/qms/photo.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const SUPERVISOR = 21; // photo.upload and photo.read over the whole tenant
const VIEWER = 22; // photo.read only
const NOBODY = 23;
const MEMBERS = [SUPERVISOR, VIEWER, NOBODY];
const FIRST_GUEST = 40;
const HOUR = 3_600_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The clock of a camera in Vietnam, the way EXIF writes it. */
const clock = (instant: Date): string => new Date(instant.getTime() + 7 * HOUR).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, ':');
const ago = (hours: number): Date => new Date(Date.now() - hours * HOUR);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('the site photo register over HTTP (ST-QMS-003)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let files: FileService;
  let contractor = '';
  let projectId = '';
  let operations = 0;
  let guests = FIRST_GUEST;
  let grants = 60;
  let uniques = 0;

  const tenantOf = (member: number, tenantId = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });
  const tokenOf = (member: number): string => signTenantContext(tenantOf(member), SIGNING_KEY);
  const operation = (): string => `00000000-0000-4000-8000-${String((operations += 1)).padStart(12, '0')}`;

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);

  /** A photo in the storage: the bytes are those of a JPEG with the EXIF given (and a body that is unique unless one is named); returns the key and the hash. */
  async function upload(exif: ExifJpegInput = {}, options: { bytes?: Buffer; purpose?: 'site_photo' | 'document'; tenantId?: string } = {}): Promise<{ key: string; sha: string; bytes: Buffer }> {
    uniques += 1;
    const bytes = options.bytes ?? exifJpeg({ ...exif, body: exif.body ?? `photo-${uniques}-${randomUUID()}` });
    const stored = await files.upload(tenantOf(SUPERVISOR, options.tenantId), { purpose: options.purpose ?? 'site_photo', declaredType: 'image/jpeg', bytes });
    return { key: stored.key, sha: sha256(bytes), bytes };
  }

  const register = (member: number, uploaded: { key: string; sha: string }, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/site-photos', { member, ...(key === undefined ? {} : { key }), body: { client_operation_id: operation(), project_id: projectId, object_key: uploaded.key, file_sha256: uploaded.sha, ...overrides } });
  const checks = (member: number, photoId: string) => call('GET', `/site-photos/${photoId}/checks`, { member });
  const list = (member: number, query = '') => call('GET', `/resources/site_photo${query}`, { member });
  const read = (member: number, photoId: string) => call('GET', `/resources/site_photo/${photoId}`, { member });
  const stored = async (photoId: string) =>
    (
      await rows<{ gps_lat: string | null; gps_lng: string | null; gps_accuracy_m: string | null; gps_source: string; geo_consent: boolean; check_time: string; check_geofence: string; check_duplicate: string; check_exif: string; check_summary: string; taken_at_exif: string | null }>(
        'select gps_lat::text, gps_lng::text, gps_accuracy_m::text, gps_source, geo_consent, check_time, check_geofence, check_duplicate, check_exif, check_summary, taken_at_exif::text from machvon.site_photo where id = $1',
        [photoId],
      )
    )[0];
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);

  async function contractOf(): Promise<string> {
    const contractId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, true, 1000000, $7, $7, date '2026-01-01', date '2026-01-02', null, null)`,
        [TENANT_A, contractId, projectId, randomUUID(), contractor, `HD-P-${contractId.slice(0, 8)}`, memberId(SUPERVISOR)],
      ],
    ]);
    return contractId;
  }

  async function diaryOf(contractId: string, day: string): Promise<string> {
    const id = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.site_diary (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5::date, $6, '{"summary": "x"}'::jsonb, $7, 1, $8, 'DRAFT', $7, $7)`,
        [TENANT_A, id, projectId, contractId, day, randomUUID(), memberId(SUPERVISOR), `NK-${id.slice(0, 8)}`],
      ],
    ]);
    return id;
  }

  async function guestOf(contractId: string): Promise<number> {
    guests += 1;
    grants += 1;
    await harness.seedMembership(TENANT_A, guests, ROOT);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guests), contractor]);
    await harness.seedGrants(TENANT_A, [{ n: grants, member: guests, role: 104, kind: 'CONTRACT', refs: [contractId] }]);
    return guests;
  }

  beforeAll(async () => {
    await world.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'QMS_PHOTOGRAPHER', ['photo.upload', 'photo.read'], 40],
      [2, 'QMS_PHOTO_VIEWER', ['photo.read'], 10],
      [4, 'QMS_GUEST', ['photo.upload', 'photo.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: SUPERVISOR, role: 101, kind: 'TENANT' },
      { n: 2, member: VIEWER, role: 102, kind: 'TENANT' },
    ]);
    contractor = await seedContractor(harness);
    projectId = (await world.publishedLine()).projectId;
    // The site of the project, as PRJ will give it: a centre and a radius.
    await world.owner("insert into machvon.project_site_zone (tenant_id, id, project_id, label, center_lat, center_lng, radius_m, created_by) values ($1, $2, $3, 'km0', 10.8, 106.7, 500, $4)", [TENANT_A, randomUUID(), projectId, memberId(SUPERVISOR)]);
    files = new FileService({ storage: new FsObjectStorage(mkdtempSync(join(tmpdir(), 'machvon-photos-'))), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [PhotoController, PhotoReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([PhotoController, PhotoReadsController]));
  });

  it('AC-ST-QMS-003-1: UAT-AC359 registers photos with matching, old, out of zone, inexact, stripped and repeated EXIF as review flags, never as rejections, and the same operation again as the photo it made', async () => {
    const now = new Date();
    const taken = { takenAt: clock(ago(2)), gps: { lat: 10.8002, lng: 106.7003 }, gpsAt: { day: new Date(ago(2).getTime()).toISOString().slice(0, 10).replace(/-/g, ':'), h: ago(2).getUTCHours(), m: ago(2).getUTCMinutes(), s: 0 } };
    // P1: taken two hours ago on the spot with a place that is exact.
    const p1 = await upload(taken);
    const one = await register(SUPERVISOR, p1, { geo_consent: true, device_gps_lat: '10.8002', device_gps_lng: '106.7003', device_gps_accuracy_m: '8' }, '00000000-0000-4000-8000-0000000001b1');
    expect(one).toMatchObject({ status: 200, json: { status: 'PASS', resource_version: 1 } });
    expect(await stored(one.json.resource_id as string)).toMatchObject({ check_time: 'OK', check_geofence: 'INSIDE', check_duplicate: 'UNIQUE', check_exif: 'CONSISTENT', check_summary: 'PASS', gps_source: 'DEVICE_AT_CAPTURE', geo_consent: true });
    // P2: taken five days ago.
    const two = await register(SUPERVISOR, await upload({ takenAt: clock(ago(24 * 5)), gps: { lat: 10.8002, lng: 106.7003 } }), { geo_consent: true, device_gps_lat: '10.8002', device_gps_lng: '106.7003', device_gps_accuracy_m: '8' });
    expect(await stored(two.json.resource_id as string)).toMatchObject({ check_time: 'SKEW', check_geofence: 'INSIDE', check_summary: 'WARN' });
    // P3: a place beyond the zone.
    const three = await register(SUPERVISOR, await upload({ takenAt: clock(ago(1)) }), { geo_consent: true, device_gps_lat: '10.9', device_gps_lng: '106.8', device_gps_accuracy_m: '8' });
    expect(await stored(three.json.resource_id as string)).toMatchObject({ check_time: 'OK', check_geofence: 'OUTSIDE', check_summary: 'WARN' });
    // P4: a place that is not exact.
    const four = await register(SUPERVISOR, await upload({ takenAt: clock(ago(1)) }), { geo_consent: true, device_gps_lat: '10.8', device_gps_lng: '106.7', device_gps_accuracy_m: '120' });
    expect(await stored(four.json.resource_id as string)).toMatchObject({ check_geofence: 'LOW_ACCURACY', check_summary: 'WARN' });
    // P5: no EXIF at all.
    const five = await register(SUPERVISOR, await upload({}, { bytes: strippedJpeg(`stripped-${randomUUID()}`) }), { geo_consent: true });
    expect(await stored(five.json.resource_id as string)).toMatchObject({ check_time: 'MISSING', check_geofence: 'MISSING', check_exif: 'STRIPPED', check_summary: 'WARN', taken_at_exif: null });
    // P6: the same file as P1, stored again.
    const six = await upload({}, { bytes: p1.bytes });
    expect(six.key).not.toBe(p1.key);
    const repeated = await register(SUPERVISOR, six, { geo_consent: true, device_gps_lat: '10.8002', device_gps_lng: '106.7003', device_gps_accuracy_m: '8' });
    expect(await stored(repeated.json.resource_id as string)).toMatchObject({ check_duplicate: 'DUPLICATE_SAME_SITE', check_summary: 'WARN' });
    // Nothing was rejected, and the answer says what it is: flags to review.
    for (const reply of [one, two, three, four, five, repeated]) expect(reply.status).toBe(200);
    // P1 again, with the same operation and another key: the photo it made, and nothing is written twice.
    const op = (await rows<{ client_operation_id: string }>('select client_operation_id from machvon.site_photo where id = $1', [one.json.resource_id as string]))[0]?.client_operation_id;
    const again = await register(SUPERVISOR, p1, { client_operation_id: op, geo_consent: true, device_gps_lat: '10.8002', device_gps_lng: '106.7003', device_gps_accuracy_m: '8' });
    expect(again).toMatchObject({ status: 200, json: { resource_id: one.json.resource_id, status: 'PASS' } });
    expect(await rows('select 1 from machvon.site_photo where file_sha256 = $1', [p1.sha])).toHaveLength(2);
    expect((await audits(one.json.resource_id as string, 'site_photo.replayed')).length).toBe(1);
    // P7: a place with no consent to keep it.
    const seven = await upload({ takenAt: clock(ago(1)) });
    expect(await register(SUPERVISOR, seven, { geo_consent: false, device_gps_lat: '10.8002', device_gps_lng: '106.7003' })).toMatchObject({ status: 422, json: { code: 'GEO_CONSENT_REQUIRED' } });
    expect(await register(SUPERVISOR, seven, { device_gps_lat: '10.8002', device_gps_lng: '106.7003' })).toMatchObject({ status: 422, json: { code: 'GEO_CONSENT_REQUIRED' } });
    expect(await rows('select 1 from machvon.site_photo where object_key = $1', [seven.key])).toHaveLength(0);
    // The checks are read back as flags, and nothing in them says that a photo is real or false.
    const read1 = await checks(SUPERVISOR, one.json.resource_id as string);
    expect(read1.json).toMatchObject({ photo_id: one.json.resource_id, checks: { time: 'OK', geofence: 'INSIDE', duplicate: 'UNIQUE', exif: 'CONSISTENT', summary: 'PASS' }, flags: [], review_note: 'REVIEW_FLAGS_ONLY' });
    expect((await checks(SUPERVISOR, two.json.resource_id as string)).json.flags).toEqual(['TIME_SKEW']);
    expect((await checks(SUPERVISOR, five.json.resource_id as string)).json.flags).toEqual(['TIME_MISSING', 'GEOFENCE_MISSING', 'EXIF_STRIPPED']);
    expect(JSON.stringify([read1.json, (await read(SUPERVISOR, two.json.resource_id as string)).json])).not.toMatch(/authentic|genuine|fake|forged|verified/i);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('AC-ST-QMS-003-2: UAT-AC367 keeps no place without the consent to it, the place inside the file included, and keeps one with it', async () => {
    const file = { takenAt: clock(ago(1)), gps: { lat: 10.8002, lng: 106.7003 } };
    for (const consent of [{}, { geo_consent: false }]) {
      const photo = await register(SUPERVISOR, await upload(file), consent);
      expect(photo.status).toBe(200);
      const row = await stored(photo.json.resource_id as string);
      expect(row).toMatchObject({ gps_lat: null, gps_lng: null, gps_accuracy_m: null, gps_source: 'NONE', geo_consent: false, check_geofence: 'MISSING', check_summary: 'WARN' });
      // Nothing about where it was is shown, stored or sent.
      expect((await read(SUPERVISOR, photo.json.resource_id as string)).json).toMatchObject({ place: null, geo_consent: false });
      expect((await checks(SUPERVISOR, photo.json.resource_id as string)).json).toMatchObject({ place: null });
      expect(JSON.stringify((await audits(photo.json.resource_id as string, 'site_photo.registered'))[0])).not.toContain('10.8002');
      expect(JSON.stringify((await events(photo.json.resource_id as string, 'qms.site_photo.registered.v1'))[0])).not.toContain('10.8002');
    }
    // With the consent the place in the file is kept, as coming from the EXIF.
    const consented = await register(SUPERVISOR, await upload(file), { geo_consent: true });
    expect(await stored(consented.json.resource_id as string)).toMatchObject({ gps_source: 'EXIF', geo_consent: true, check_geofence: 'INSIDE' });
    expect(Number((await stored(consented.json.resource_id as string))?.gps_lat)).toBeCloseTo(10.8002, 5);
    expect((await read(SUPERVISOR, consented.json.resource_id as string)).json).toMatchObject({ place: { source: 'EXIF', accuracy_m: null } });
    // The database says the same, whoever writes.
    await expect(world.owner("update machvon.site_photo set gps_lat = 10.8, gps_lng = 106.7, gps_source = 'MANUAL' where id = $1", [consented.json.resource_id])).rejects.toThrow(/kept as it was registered/);
    await expect(
      rows("insert into machvon.site_photo (tenant_id, id, project_id, client_operation_id, object_key, file_sha256, gps_lat, gps_lng, gps_source, geo_consent, uploaded_by, created_by) values ($1, $2, $3, $4, 'k', $5, 10.8, 106.7, 'EXIF', false, $6, $6)", [
        TENANT_A,
        randomUUID(),
        projectId,
        randomUUID(),
        'a'.repeat(64),
        memberId(SUPERVISOR),
      ]),
    ).rejects.toThrow(/site_photo_place_chk/);
  });

  it('judges the time against the day of the diary the photo is linked to', async () => {
    const contractId = await contractOf();
    const today = new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);
    const old = new Date(Date.now() + 7 * HOUR - 10 * 24 * HOUR).toISOString().slice(0, 10);
    const todays = await diaryOf(contractId, today);
    const olds = await diaryOf(contractId, old);
    const taken = { takenAt: clock(ago(1)) };
    const inDay = await register(SUPERVISOR, await upload(taken), { contract_id: contractId, site_diary_id: todays });
    expect((await stored(inDay.json.resource_id as string))?.check_time).toBe('OK');
    // The same photo, linked to a diary of ten days ago.
    const outOfDay = await register(SUPERVISOR, await upload(taken), { contract_id: contractId, site_diary_id: olds });
    expect((await stored(outOfDay.json.resource_id as string))?.check_time).toBe('SKEW');
    expect((await read(SUPERVISOR, outOfDay.json.resource_id as string)).json).toMatchObject({ site_diary_id: olds, contract: { id: contractId } });
    // A photo from the future of the server is a flag too.
    const future = await register(SUPERVISOR, await upload({ takenAt: clock(new Date(Date.now() + 5 * HOUR)) }), { contract_id: contractId, site_diary_id: todays });
    expect((await stored(future.json.resource_id as string))?.check_time).toBe('SKEW');
  });

  it('refuses a file that is not what was said, not clean, not a photo of this tenant, or registered already, and a project, contract or object that is not what it names', async () => {
    const good = await upload({ takenAt: clock(ago(1)) });
    expect(await register(SUPERVISOR, { ...good, sha: 'b'.repeat(64) })).toMatchObject({ status: 422, json: { code: 'HASH_MISMATCH' } });
    const infected = await upload({}, { bytes: Buffer.concat([exifJpeg({ body: `x-${randomUUID()}` }), Buffer.from(eicarBytes())]) });
    expect(await register(SUPERVISOR, infected)).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
    expect(await register(SUPERVISOR, { key: 'tenants/not-a-key', sha: good.sha })).toMatchObject({ status: 422 });
    expect(await register(SUPERVISOR, { key: `tenants/${TENANT_A}/site_photo/${randomUUID()}`, sha: good.sha })).toMatchObject({ status: 404 });
    // A key of another purpose, and a key of another tenant, are not photos of this one.
    const document = await upload({}, { purpose: 'document' });
    expect(await register(SUPERVISOR, document)).toMatchObject({ status: 422, json: { detail: 'object_key' } });
    const foreign = await upload({}, { tenantId: TENANT_B });
    expect(await register(SUPERVISOR, foreign)).toMatchObject({ status: 422 });
    expect(await rows('select 1 from machvon.site_photo where object_key = any($1::text[])', [[infected.key, document.key, foreign.key]])).toHaveLength(0);
    // The same stored file twice is a mistake of the client.
    expect((await register(SUPERVISOR, good)).status).toBe(200);
    expect(await register(SUPERVISOR, good)).toMatchObject({ status: 422, json: { detail: 'object_key' } });
    // What the request names must exist and belong together.
    const other = await upload({ takenAt: clock(ago(1)) });
    expect(await register(SUPERVISOR, other, { contract_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'contract_id' } });
    expect(await register(SUPERVISOR, other, { site_diary_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'site_diary_id' } });
    expect(await register(SUPERVISOR, other, { inspection_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'inspection_id' } });
    expect(await register(SUPERVISOR, other, { nonconformance_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'nonconformance_id' } });
    expect(await register(SUPERVISOR, other, { issue_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'issue_id' } });
    expect(await register(SUPERVISOR, other, { project_id: randomUUID() })).toMatchObject({ status: 404 });
    expect(await register(SUPERVISOR, other, { device_gps_lat: '95', device_gps_lng: '106.7', geo_consent: true })).toMatchObject({ status: 422, json: { detail: 'device_gps_lat' } });
    expect(await register(SUPERVISOR, other, { device_gps_lat: '10.8', geo_consent: true })).toMatchObject({ status: 422 });
    expect(await register(SUPERVISOR, other, { device_gps_accuracy_m: '8', geo_consent: true })).toMatchObject({ status: 422 });
    expect(await register(SUPERVISOR, other, { caption: '  ' })).toMatchObject({ status: 422 });
    expect(await rows('select 1 from machvon.site_photo where object_key = $1', [other.key])).toHaveLength(0);
  });

  it('registers photos only for whoever holds the right over the project or the contract, and shows them only in the scope of the caller', async () => {
    const contractId = await contractOf();
    const otherContract = await contractOf();
    const guest = await guestOf(contractId);
    const taken = { takenAt: clock(ago(1)) };
    // Whoever may only read, or may do nothing here.
    expect(await register(VIEWER, await upload(taken))).toMatchObject({ status: 403 });
    expect(await register(NOBODY, await upload(taken))).toMatchObject({ status: 403 });
    // The guest of a contractor registers a photo for its own contract, and not for another's, nor for the project.
    const own = await register(guest, await upload(taken), { contract_id: contractId });
    expect(own.status).toBe(200);
    expect(await register(guest, await upload(taken), { contract_id: otherContract })).toMatchObject({ status: 404 });
    expect(await register(guest, await upload(taken))).toMatchObject({ status: 404 });
    const staff = await register(SUPERVISOR, await upload(taken), { contract_id: otherContract });
    // The guest reads what is of its contract; the staff reads all; the viewer reads without writing; nobody reads nothing.
    expect(((await list(guest)).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([own.json.resource_id]);
    expect((await read(guest, staff.json.resource_id as string)).status).toBe(404);
    expect((await checks(guest, staff.json.resource_id as string)).status).toBe(404);
    expect((await read(guest, own.json.resource_id as string)).status).toBe(200);
    expect((await read(VIEWER, staff.json.resource_id as string)).status).toBe(200);
    expect((await list(NOBODY)).status).toBe(403);
    expect((await read(NOBODY, own.json.resource_id as string)).status).toBe(403);
    expect((await audits(own.json.resource_id as string, 'site_photo.registered'))[0]?.safe_diff).toMatchObject({ contract_id: contractId, geo_consent: false, gps_source: 'NONE' });
    expect((await events(own.json.resource_id as string, 'qms.site_photo.registered.v1'))[0]?.payload).toMatchObject({ site_photo_id: own.json.resource_id, check_summary: 'WARN' });
  });

  it('answers an operation seen before only with the photo of the same project and contract, and not with the photo of another contract (Codex review of ST-QMS-003)', async () => {
    const mine = await contractOf();
    const theirs = await contractOf();
    const guestMine = await guestOf(mine);
    const guestTheirs = await guestOf(theirs);
    const taken = { takenAt: clock(ago(1)) };
    const op = '00000000-0000-4000-8000-0000000002a1';
    const made = await register(guestMine, await upload(taken), { client_operation_id: op, contract_id: mine });
    expect(made.status).toBe(200);
    // The other guest, in the same project, sends the operation with its own contract: the photo is not told to it.
    expect(await register(guestTheirs, await upload(taken), { client_operation_id: op, contract_id: theirs })).toMatchObject({ status: 422, json: { detail: 'client_operation_id' } });
    // Nor is it told to staff who name no contract, or another one.
    expect(await register(SUPERVISOR, await upload(taken), { client_operation_id: op })).toMatchObject({ status: 422, json: { detail: 'client_operation_id' } });
    expect(await register(SUPERVISOR, await upload(taken), { client_operation_id: op, contract_id: theirs })).toMatchObject({ status: 422 });
    expect((await audits(made.json.resource_id as string, 'site_photo.replayed')).length).toBe(0);
    // The same registration again is the replay.
    expect(await register(guestMine, await upload(taken), { client_operation_id: op, contract_id: mine })).toMatchObject({ status: 200, json: { resource_id: made.json.resource_id } });
  });

  it('serialises the registrations that share an operation or a file, so that one is first (Codex review of ST-QMS-003)', async () => {
    const taken = { takenAt: clock(ago(1)) };
    // One operation sent twice at once, with two keys: one photo, both answered with it.
    const op = '00000000-0000-4000-8000-0000000002a2';
    const file = await upload(taken);
    const [one, two] = await Promise.all([register(SUPERVISOR, file, { client_operation_id: op }), register(SUPERVISOR, file, { client_operation_id: op })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.json.resource_id).toBe(two.json.resource_id);
    expect(await rows('select 1 from machvon.site_photo where client_operation_id = $1', [op])).toHaveLength(1);
    // Two copies of one file registered at once: one is the first, the other sees it.
    const bytes = exifJpeg({ ...taken, body: `twin-${randomUUID()}` });
    const [first, second] = [await upload({}, { bytes }), await upload({}, { bytes })];
    const both = await Promise.all([register(SUPERVISOR, first), register(SUPERVISOR, second)]);
    expect(both.map((reply) => reply.status)).toEqual([200, 200]);
    const kinds = (await rows<{ check_duplicate: string }>('select check_duplicate from machvon.site_photo where file_sha256 = $1 order by created_at', [first.sha])).map((row) => row.check_duplicate).sort();
    expect(kinds).toEqual(['DUPLICATE_SAME_SITE', 'UNIQUE']);
  });

  it('lists the photos newest first in pages, narrowed by project, contract, diary and summary, and shows each as an allowlist without the object in the storage', async () => {
    const contractId = await contractOf();
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const photo = await register(SUPERVISOR, await upload({ takenAt: clock(ago(1)), ...(index % 2 === 0 ? {} : {}) }), { contract_id: contractId, caption: `Photo ${index}` });
      made.push(photo.json.resource_id as string);
    }
    const first = await list(SUPERVISOR, `?contract_id=${contractId}&limit=2`);
    expect((first.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([made[4], made[3]]);
    expect(first.json.next_cursor).toEqual(expect.any(String));
    const second = await list(SUPERVISOR, `?contract_id=${contractId}&limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
    expect((second.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([made[2], made[1]]);
    const last = await list(SUPERVISOR, `?contract_id=${contractId}&limit=2&cursor=${encodeURIComponent(second.json.next_cursor as string)}`);
    expect((last.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([made[0]]);
    expect(last.json.next_cursor).toBeNull();
    expect(((await list(SUPERVISOR, `?contract_id=${contractId}&summary=PASS`)).json.items as unknown[]).length).toBe(0);
    expect(((await list(SUPERVISOR, `?contract_id=${contractId}&summary=WARN`)).json.items as unknown[]).length).toBe(5);
    expect(((await list(SUPERVISOR, `?project_id=${projectId}&contract_id=${contractId}`)).json.items as unknown[]).length).toBe(5);
    const shown = (await read(SUPERVISOR, made[4] as string)).json;
    expect(Object.keys(shown).sort()).toEqual(
      ['caption', 'checks', 'contract', 'created_at', 'device_id', 'device_model', 'file_sha256', 'flags', 'geo_consent', 'id', 'inspection_id', 'issue_id', 'nonconformance_id', 'place', 'project', 'received_at', 'review_note', 'scan_status', 'site_diary_id', 'taken_at_exif', 'uploaded_by'].sort(),
    );
    expect(JSON.stringify(shown)).not.toContain('object_key');
    for (const bad of ['summary=BAD', 'project_id=x', 'contract_id=x', 'site_diary_id=x', 'limit=0', 'cursor=bad']) expect([bad, (await list(SUPERVISOR, `?${bad}`)).status]).toEqual([bad, 422]);
    expect((await read(SUPERVISOR, randomUUID())).status).toBe(404);
  });

  it('keeps the register as it was made: nobody edits a photo, and the runtime role cannot erase one', async () => {
    const photo = await register(SUPERVISOR, await upload({ takenAt: clock(ago(1)) }));
    const id = photo.json.resource_id as string;
    await expect(world.owner("update machvon.site_photo set caption = 'changed' where id = $1", [id])).rejects.toThrow(/kept as it was registered/);
    await expect(world.owner("update machvon.site_photo set check_summary = 'PASS' where id = $1", [id])).rejects.toThrow(/kept as it was registered/);
    expect((await rows<{ can: boolean }>("select has_table_privilege('machvon_app', 'machvon.site_photo', 'DELETE') as can"))[0]?.can).toBe(false);
    expect((await rows<{ can: boolean }>("select has_table_privilege('machvon_app', 'machvon.site_photo', 'TRUNCATE') as can"))[0]?.can).toBe(false);
  });
});
