import { ControlDatabase } from '@machvon/db';
import { Pool } from 'pg';
import { definitionOf } from '../../src/notifications/definition';
import { ControlEventTypeCatalog, PayloadValidator } from '../../src/notifications/payload-validator';
import { AuthzHarness } from '../../../../packages/db/test/support/authz-fixtures';

const SCHEMA = {
  type: 'object',
  required: ['project_id', 'at'],
  properties: { project_id: { type: 'string', format: 'uuid' }, at: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' } },
  additionalProperties: false,
};

describe('ControlEventTypeCatalog and PayloadValidator against notification_event_type', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let clock = 1_000_000;

  const insert = (eventType: string, version: number, status: string, schema: unknown = SCHEMA) =>
    harness.owner('00000000-0000-4000-8000-00000000000a', [
      [
        `insert into machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
         values (gen_random_uuid(), $1, 'PRJ', $2, $3::jsonb, '{OPERATIONAL}', 'INTERNAL', $4)`,
        [eventType, version, JSON.stringify(schema), status],
      ],
    ]);

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await insert('prj.stage.changed', 1, 'Active');
    await insert('prj.old.event', 1, 'Deprecated');
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  it('reads a registered event type through the control handle and caches it for 60 seconds, including a miss', async () => {
    const catalog = new ControlEventTypeCatalog(control, () => clock);
    const found = await catalog.get('prj.stage.changed', 1);
    expect(found).toMatchObject({ eventType: 'prj.stage.changed', schemaVersion: 1, allowedPurposes: ['OPERATIONAL'], status: 'Active' });
    expect(await catalog.get('prj.missing', 1)).toBeUndefined();

    // Registered after the first lookup: the cached miss still answers until the 60 seconds are over.
    await insert('prj.missing', 1, 'Active');
    clock += 59_000;
    expect(await catalog.get('prj.missing', 1)).toBeUndefined();
    clock += 2_000;
    expect(await catalog.get('prj.missing', 1)).toMatchObject({ eventType: 'prj.missing' });
  });

  it('accepts a payload that matches the schema, its uuid, date-time and date formats included', async () => {
    const validator = new PayloadValidator(new ControlEventTypeCatalog(control));
    const payload = { project_id: '00000000-0000-4000-8000-0000000000c1', at: '2026-10-23T08:00:00Z', day: '2026-10-23' };
    await expect(validator.validate('prj.stage.changed', 1, payload)).resolves.toMatchObject({ eventType: 'prj.stage.changed' });
  });

  it.each([
    ['a missing field', { at: '2026-10-23T08:00:00Z' }, 'payload'],
    ['an unknown field', { project_id: '00000000-0000-4000-8000-0000000000c1', at: '2026-10-23T08:00:00Z', extra: 1 }, 'payload'],
    ['a bad uuid', { project_id: 'not-a-uuid', at: '2026-10-23T08:00:00Z' }, 'payload/project_id'],
    ['a bad date-time', { project_id: '00000000-0000-4000-8000-0000000000c1', at: 'yesterday' }, 'payload/at'],
    ['a bad date', { project_id: '00000000-0000-4000-8000-0000000000c1', at: '2026-10-23T08:00:00Z', day: '23/10/2026' }, 'payload/day'],
  ])('refuses %s with 422 VALIDATION_FAILED naming the path and never the value', async (_label, payload, path) => {
    const validator = new PayloadValidator(new ControlEventTypeCatalog(control));
    await expect(validator.validate('prj.stage.changed', 1, payload)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: path });
  });

  it('refuses a deprecated, an unknown and a wrong-version event type with 422 EVENT_TYPE_UNKNOWN', async () => {
    const validator = new PayloadValidator(new ControlEventTypeCatalog(control));
    for (const [type, version] of [['prj.old.event', 1], ['prj.nothing', 1], ['prj.stage.changed', 2]] as const) {
      await expect(validator.validate(type, version, {})).rejects.toMatchObject({ code: 'EVENT_TYPE_UNKNOWN', status: 422 });
    }
  });

  it('compiles a changed schema again once the catalogue entry is reloaded', async () => {
    const entries: Array<{ schema: unknown }> = [{ schema: { type: 'object', required: ['a'] } }];
    const catalog = {
      get: async () => ({ eventType: 'x.y', schemaVersion: 1, payloadSchema: entries[0]?.schema, allowedPurposes: ['OPERATIONAL'], status: 'Active' as const }),
    };
    const validator = new PayloadValidator(catalog);
    await expect(validator.validate('x.y', 1, { b: 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    entries[0] = { schema: { type: 'object', required: ['b'] } };
    await expect(validator.validate('x.y', 1, { b: 1 })).resolves.toBeDefined();
  });

  it('validates a schema that declares JSON Schema 2020-12 with its own keywords', async () => {
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' } }, unevaluatedProperties: false };
    const catalog = { get: async () => ({ eventType: 'x.z', schemaVersion: 1, payloadSchema: schema, allowedPurposes: ['OPERATIONAL'], status: 'Active' as const }) };
    const validator = new PayloadValidator(catalog);
    await expect(validator.validate('x.z', 1, { a: 'x' })).resolves.toBeDefined();
    await expect(validator.validate('x.z', 1, { a: 'x', extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('keeps validating after the catalogue reloads an equal schema with an $id as a new object', async () => {
    const reloaded = (): unknown => ({ $id: 'https://machvon.test/schemas/x-w.json', type: 'object', required: ['a'], properties: { a: { type: 'string' } } });
    const catalog = { get: async () => ({ eventType: 'x.w', schemaVersion: 1, payloadSchema: reloaded(), allowedPurposes: ['OPERATIONAL'], status: 'Active' as const }) };
    const validator = new PayloadValidator(catalog);
    await expect(validator.validate('x.w', 1, { a: 'x' })).resolves.toBeDefined();
    // The second delivery sees a new, equal object (a 60 second catalogue refresh) and must not fail with "schema already exists".
    await expect(validator.validate('x.w', 1, { a: 'y' })).resolves.toBeDefined();
    await expect(validator.validate('x.w', 1, {})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('definitionOf (the part of workflow_version.definition_json the core reads)', () => {
  it('applies the defaults to an empty or missing definition', () => {
    for (const raw of [{}, null, undefined, [], 'text']) {
      expect(definitionOf(raw)).toEqual({ channels: [{ channel: 'IN_APP' }], resolver: { kind: 'explicit' }, priority: 'NORMAL', ackRequired: false, expiresAfterMinutes: 10_080, purpose: 'OPERATIONAL', quietHoursOverride: false });
    }
  });

  it('reads every member', () => {
    expect(
      definitionOf({ resolver: { kind: 'role-in-scope', roles: ['LEADER', 'SPECIALIST'] }, priority: 'CRITICAL', ackRequired: true, expiresAfterMinutes: 60, purpose: 'SECURITY' }),
    ).toEqual({ channels: [{ channel: 'IN_APP' }], resolver: { kind: 'role-in-scope', roles: ['LEADER', 'SPECIALIST'] }, priority: 'CRITICAL', ackRequired: true, expiresAfterMinutes: 60, purpose: 'SECURITY', quietHoursOverride: false });
  });

  it('lets only an urgent workflow break the quiet hours (NOT 3.4 quiet_hours_override)', () => {
    expect(definitionOf({ priority: 'CRITICAL', quietHoursOverride: true }).quietHoursOverride).toBe(true);
    for (const priority of ['HIGH', 'NORMAL', 'LOW']) {
      expect(() => definitionOf({ priority, quietHoursOverride: true })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'workflow.definition.quietHoursOverride' }));
    }
    expect(() => definitionOf({ priority: 'CRITICAL', quietHoursOverride: 'yes' })).toThrow(expect.objectContaining({ detail: 'workflow.definition.quietHoursOverride' }));
  });

  it.each([
    ['an unknown priority', { priority: 'URGENT' }, 'workflow.definition.priority'],
    ['a non-boolean ackRequired', { ackRequired: 'yes' }, 'workflow.definition.ackRequired'],
    ['a fractional expiry', { expiresAfterMinutes: 1.5 }, 'workflow.definition.expiresAfterMinutes'],
    ['an expiry of zero', { expiresAfterMinutes: 0 }, 'workflow.definition.expiresAfterMinutes'],
    ['an expiry over a year', { expiresAfterMinutes: 600_000 }, 'workflow.definition.expiresAfterMinutes'],
    ['an empty purpose', { purpose: '' }, 'workflow.definition.purpose'],
    ['a resolver that is not an object', { resolver: 'explicit' }, 'workflow.definition.resolver'],
    ['an unknown resolver kind', { resolver: { kind: 'everyone' } }, 'workflow.definition.resolver.kind'],
    ['a role-in-scope resolver without roles', { resolver: { kind: 'role-in-scope', roles: [] } }, 'workflow.definition.resolver.roles'],
    ['a role-in-scope resolver with a blank role', { resolver: { kind: 'role-in-scope', roles: [''] } }, 'workflow.definition.resolver.roles'],
  ])('refuses %s with 422 VALIDATION_FAILED naming the member', (_label, raw, detail) => {
    expect(() => definitionOf(raw)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail }));
  });
});
