import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import {
  IamSupportTicketStore,
  MAX_ATTACHMENTS,
  PRIORITY_OF_CATEGORY,
  SLA_ELAPSED_HOURS,
  SLA_WORKING_HOURS,
  SUPPORT_CALENDAR_CODE,
  TICKET_CATEGORIES,
} from '../src/iam-support-ticket-store';
import type { TicketInput } from '../src/iam-support-ticket-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const tickets = new IamSupportTicketStore();
const MEMBER = 1;
const OTHER = 2;
const HOUR_MS = 3_600_000;
// Monday 2026-10-26, 09:00 in Vietnam: a working morning of the calendar below.
const MONDAY_NINE = new Date('2026-10-26T02:00:00.000Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MEMBER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const input = (overrides: Partial<TicketInput> = {}): TicketInput => ({ category: 'ACCESS', subject: 'I cannot open the project register', description: 'Since this morning the register says I have no access to it.', ...overrides });
const create = (data: TicketInput, now = MONDAY_NINE, member = MEMBER, tenant = TENANT_A) => as((tx) => tickets.create(tx, data, memberId(member), now), member, tenant);
const row = async (ticketId: string) =>
  (await owner<{ ticket_code: string; priority: string; status: string; sla_due_at: string; requester_membership_id: string; description_ref: string; version: string }>(
    'select ticket_code, priority, status, sla_due_at::text as sla_due_at, requester_membership_id, description_ref, version::text as version from machvon.support_ticket where id = $1::uuid',
    [ticketId],
  ))[0];

async function documentVersion(options: { infected?: boolean; tenant?: string } = {}): Promise<string> {
  const tenant = options.tenant ?? TENANT_A;
  const documentId = randomUUID();
  const versionId = randomUUID();
  await owner(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Screenshot', 'INTERNAL', $3, $3)`, [tenant, documentId, memberId(MEMBER)], tenant);
  await owner(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'image/png', 1, 'INTERNAL', $5, '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenant, versionId, documentId, `tenants/test/${versionId}.png`, options.infected === true ? 'INFECTED' : 'CLEAN'],
    tenant,
  );
  return versionId;
}

describe('IamSupportTicketStore (the support ticket, ST-IAM-007)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const member of [MEMBER, OTHER]) await harness.seedMembership(tenant, member, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the code', () => {
    it('numbers the tickets SUP-YYYY-NNNNNN per tenant and per year, from 1, in the Vietnam year (AC-ST-IAM-007-1)', async () => {
      const first = await create(input(), new Date('2028-03-01T02:00:00.000Z'));
      const second = await create(input(), new Date('2028-03-01T03:00:00.000Z'));
      expect([first.ticketCode, second.ticketCode]).toEqual(['SUP-2028-000001', 'SUP-2028-000002']);
      // 17:30 UTC on the last day of the year is already the next day in Vietnam.
      const newYear = await create(input(), new Date('2028-12-31T17:30:00.000Z'));
      expect(newYear.ticketCode).toBe('SUP-2029-000001');
      const other = await create(input(), new Date('2028-03-01T02:00:00.000Z'), MEMBER, TENANT_B);
      expect(other.ticketCode).toBe('SUP-2028-000001');
      expect((await row(first.id))?.ticket_code).toBe('SUP-2028-000001');
    });

    it('never gives one code to two tickets asked for at the same moment', async () => {
      const now = new Date('2030-05-01T02:00:00.000Z');
      const made = await Promise.all(Array.from({ length: 6 }, () => create(input(), now)));
      expect(made.map((ticket) => ticket.ticketCode).sort()).toEqual(['SUP-2030-000001', 'SUP-2030-000002', 'SUP-2030-000003', 'SUP-2030-000004', 'SUP-2030-000005', 'SUP-2030-000006']);
    });
  });

  describe('the priority and the SLA', () => {
    it('takes the priority from the category, not from the member', async () => {
      expect(PRIORITY_OF_CATEGORY).toEqual({ INCIDENT: 'P1', ACCESS: 'P2', DATA: 'P2', BILLING: 'P3', HOWTO: 'P4', OTHER: 'P4' });
      for (const category of TICKET_CATEGORIES) expect((await create(input({ category }))).priority).toBe(PRIORITY_OF_CATEGORY[category]);
    });

    it('counts the SLA in elapsed hours while the tenant has no published calendar (P2 is a day later)', async () => {
      expect(SLA_ELAPSED_HOURS).toEqual({ P1: 4, P2: 24, P3: 72, P4: 240 });
      for (const [category, hours] of [['INCIDENT', 4], ['ACCESS', 24], ['BILLING', 72], ['OTHER', 240]] as const) {
        const ticket = await create(input({ category }), MONDAY_NINE, MEMBER, TENANT_B);
        expect(ticket.onCalendar).toBe(false);
        expect(ticket.slaDueAt.getTime() - MONDAY_NINE.getTime()).toBe(hours * HOUR_MS);
      }
    });

    it('counts the SLA in working time on the calendar of the tenant: a P2 ticket made on a Friday afternoon is due on Monday (AC-ST-IAM-007-1)', async () => {
      await owner(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         select $1, gen_random_uuid(), $2, y, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $3, $3, now() from generate_series(2026, 2030) as y`,
        [TENANT_A, SUPPORT_CALENDAR_CODE, memberId(MEMBER)],
      );
      expect(SLA_WORKING_HOURS).toEqual({ P1: 4, P2: 8, P3: 24, P4: 80 });
      // Monday 09:00 + 1 working day (8 working hours: 09:00-12:00, 13:00-17:00 and 08:00-09:00 of Tuesday) = Tuesday 09:00 Vietnam time.
      const monday = await create(input({ category: 'ACCESS' }), MONDAY_NINE);
      expect(monday.onCalendar).toBe(true);
      expect(monday.slaDueAt.toISOString()).toBe('2026-10-27T02:00:00.000Z');
      // Friday 15:00 + 8 working hours: 2 hours that afternoon, 6 on Monday from 08:00 = Monday 15:00 (the lunch hour is not worked).
      const friday = await create(input({ category: 'DATA' }), new Date('2026-10-30T08:00:00.000Z'));
      expect(friday.slaDueAt.toISOString()).toBe('2026-11-02T08:00:00.000Z');
      expect((await row(friday.id))?.sla_due_at).toContain('2026-11-02');
      // Four working hours for an incident, three working days for billing and ten for a question.
      expect((await create(input({ category: 'INCIDENT' }), MONDAY_NINE)).slaDueAt.toISOString()).toBe('2026-10-26T07:00:00.000Z');
      expect((await create(input({ category: 'BILLING' }), MONDAY_NINE)).slaDueAt.toISOString()).toBe('2026-10-29T02:00:00.000Z');
      expect((await create(input({ category: 'HOWTO' }), MONDAY_NINE)).slaDueAt.toISOString()).toBe('2026-11-09T02:00:00.000Z');
    });

    it('falls back to elapsed hours when the count runs into a year without a calendar', async () => {
      // The calendar of the tenant ends in 2030: a P4 ticket made late in 2030 needs 2031.
      const ticket = await create(input({ category: 'OTHER' }), new Date('2030-12-20T02:00:00.000Z'));
      expect(ticket.onCalendar).toBe(false);
      expect(ticket.slaDueAt.getTime() - new Date('2030-12-20T02:00:00.000Z').getTime()).toBe(240 * HOUR_MS);
    });
  });

  describe('create', () => {
    it('keeps the metadata in the ticket and what the member wrote apart, and the ticket starts open', async () => {
      const ticket = await create(input({ subject: '  I cannot open the project register  ', description: '  Since this morning.\nPlease help!  ' }));
      expect(ticket).toMatchObject({ category: 'ACCESS', priority: 'P2', version: 1, status: 'Open', attachmentCount: 0 });
      expect(await row(ticket.id)).toMatchObject({ status: 'Open', version: '1', requester_membership_id: memberId(MEMBER), description_ref: `support_ticket_body:${ticket.id}` });
      expect(await owner('select subject from machvon.support_ticket where id = $1::uuid', [ticket.id])).toEqual([{ subject: 'I cannot open the project register' }]);
      expect(await owner('select description from machvon.support_ticket_body where ticket_id = $1::uuid', [ticket.id])).toEqual([{ description: 'Since this morning.\nPlease help!' }]);
      // The ticket row itself carries no text beyond the subject.
      const columns = await owner<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'machvon' and table_name = 'support_ticket' order by ordinal_position");
      expect(columns.map((column) => column.column_name)).not.toContain('description');
    });

    it('takes up to five attachments that are documents of the tenant and not infected', async () => {
      const documents = await Promise.all(Array.from({ length: 2 }, () => documentVersion()));
      const ticket = await create(input({ attachmentIds: documents }));
      expect(ticket.attachmentCount).toBe(2);
      expect(await owner('select document_version_id from machvon.support_ticket_attachment where ticket_id = $1::uuid order by document_version_id', [ticket.id])).toHaveLength(2);
      const infected = await documentVersion({ infected: true });
      const foreign = await documentVersion({ tenant: TENANT_B });
      for (const bad of [[infected], [foreign], [randomUUID()], ['x'], [documents[0] as string, documents[0] as string], Array.from({ length: MAX_ATTACHMENTS + 1 }, () => randomUUID())]) {
        expect(await refusal(create(input({ attachmentIds: bad })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'attachment_ids' });
      }
    });

    it.each([
      ['a category that is not one', { category: 'OPINION' }, 'category'],
      ['a subject that is too short', { subject: 'Help' }, 'subject'],
      ['a subject that is only spaces', { subject: '       ' }, 'subject'],
      ['a subject that is too long', { subject: 'x'.repeat(201) }, 'subject'],
      ['a subject with a control character', { subject: 'bell\u0007 in it' }, 'subject'],
      ['a subject with a line break', { subject: 'two\nlines of subject' }, 'subject'],
      ['a description that is too short', { description: 'Help me' }, 'description'],
      ['a description that is too long', { description: 'x'.repeat(10_001) }, 'description'],
      ['a description with a control character', { description: 'bell\u0007 in the description' }, 'description'],
      ['a description that is not text', { description: 5 as unknown as string }, 'description'],
    ])('refuses %s and writes nothing', async (_name, change, field) => {
      const before = Number((await owner<{ n: string }>('select count(*)::text as n from machvon.support_ticket'))[0]?.n);
      expect(await refusal(create(input(change as Partial<TicketInput>)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.support_ticket'))[0]?.n)).toBe(before);
    });
  });

  describe('the reads', () => {
    const page = { limit: 100, after: undefined };

    it('lists the tickets newest first, of one requester or of the tenant, by status, in pages', async () => {
      const mine = await create(input({ subject: 'Mine only for the list' }), new Date('2031-01-05T02:00:00.000Z'), MEMBER);
      const theirs = await create(input({ subject: 'Theirs only for the list' }), new Date('2031-01-05T03:00:00.000Z'), OTHER);
      await owner("update machvon.support_ticket set status = 'InProgress', version = version + 1 where id = $1::uuid", [theirs.id]);
      const ownOnly = await as((tx) => tickets.list(tx, { requester: memberId(MEMBER) }, page));
      expect(ownOnly.some((item) => item.id === theirs.id)).toBe(false);
      expect(ownOnly.find((item) => item.id === mine.id)).toMatchObject({ ticketCode: mine.ticketCode, category: 'ACCESS', priority: 'P2', status: 'Open', attachmentCount: 0, version: 1, requesterMembershipId: memberId(MEMBER) });
      const all = await as((tx) => tickets.list(tx, {}, page));
      const indexOf = (id: string) => all.findIndex((item) => item.id === id);
      expect(indexOf(theirs.id)).toBeLessThan(indexOf(mine.id));
      expect((await as((tx) => tickets.list(tx, { status: 'InProgress' }, page))).map((item) => item.id)).toEqual([theirs.id]);
      const page1 = await as((tx) => tickets.list(tx, {}, { limit: 1, after: undefined }));
      const anchor = page1[0] as { createdAtKey: string; id: string };
      const page2 = await as((tx) => tickets.list(tx, {}, { limit: 1, after: { code: anchor.createdAtKey, id: anchor.id } }));
      expect(page2[0]?.id).not.toBe(anchor.id);
      expect((await as((tx) => tickets.find(tx, mine.id)))?.ticketCode).toBe(mine.ticketCode);
      expect(await as((tx) => tickets.find(tx, randomUUID()))).toBeUndefined();
    });

    it('keeps the tickets of one tenant out of sight of another', async () => {
      const ticket = await create(input({ subject: 'Only tenant A sees this one' }), MONDAY_NINE);
      expect((await as((tx) => tickets.list(tx, {}, page), MEMBER, TENANT_B)).some((item) => item.id === ticket.id)).toBe(false);
      expect(await as((tx) => tickets.find(tx, ticket.id), MEMBER, TENANT_B)).toBeUndefined();
    });
  });

  describe('what the database keeps', () => {
    it('keeps what the member asked for and the SLA: the status, the assignee and the version are what the operator moves', async () => {
      const ticket = await create(input());
      for (const change of [
        "subject = 'Another subject entirely'",
        "category = 'DATA'",
        "priority = 'P1'",
        "ticket_code = 'SUP-2026-999999'",
        "sla_due_at = sla_due_at + interval '1 day'",
        `requester_membership_id = '${memberId(OTHER)}'`,
        "description_ref = 'elsewhere'",
        "created_at = created_at - interval '1 day'",
      ]) {
        expect(await databaseRefusal(owner(`update machvon.support_ticket set ${change} where id = $1::uuid`, [ticket.id]))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('keeps what the member asked for') });
      }
      await owner("update machvon.support_ticket set status = 'InProgress', assignee_operator_id = $2::uuid, version = version + 1 where id = $1::uuid", [ticket.id, memberId(OTHER)]);
      expect((await row(ticket.id))?.status).toBe('InProgress');
    });

    it('is never deleted, starts open, and what the member wrote is never changed or deleted', async () => {
      const ticket = await create(input());
      expect(await databaseRefusal(owner('delete from machvon.support_ticket where id = $1::uuid', [ticket.id]))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never deleted') });
      expect(await databaseRefusal(owner("update machvon.support_ticket_body set description = 'Another description of the trouble' where ticket_id = $1::uuid", [ticket.id]))).toMatchObject({ sqlstate: '23514' });
      expect(await databaseRefusal(owner('delete from machvon.support_ticket_body where ticket_id = $1::uuid', [ticket.id]))).toMatchObject({ sqlstate: '23514' });
      const grants = await owner<{ table_name: string; can_delete: boolean }>(
        "select t as table_name, has_table_privilege('machvon_app', 'machvon.' || t, 'DELETE') as can_delete from unnest(array['support_ticket', 'support_ticket_body', 'support_ticket_attachment', 'support_ticket_counter']) as t",
      );
      expect(grants.every((grant) => !grant.can_delete)).toBe(true);
      const code = await owner<{ n: string }>('select count(*)::text as n from machvon.support_ticket_counter');
      expect(Number(code[0]?.n)).toBeGreaterThanOrEqual(1);
      expect(await databaseRefusal(owner(`insert into machvon.support_ticket (tenant_id, id, ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at)
        values ($1, $2, 'SUP-2026-777777', $3, 'OTHER', 'A ticket that starts closed', 'x', 'P4', 'Closed', now() + interval '1 day')`, [TENANT_A, randomUUID(), memberId(MEMBER)]))).toMatchObject({ message: expect.stringContaining('starts open') });
    });

    it('holds the checks of the table: the code has its shape, the subject its length, the SLA is after the creation', async () => {
      const insert = (code: string, subject: string, due: string) =>
        owner(
          `insert into machvon.support_ticket (tenant_id, id, ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at)
           values ($1, $2, $3, $4, 'OTHER', $5, 'x', 'P4', 'Open', ${due})`,
          [TENANT_A, randomUUID(), code, memberId(MEMBER), subject],
        );
      expect(await databaseRefusal(insert('TICKET-1', 'A valid subject', "now() + interval '1 day'"))).toMatchObject({ message: expect.stringContaining('support_ticket_code_chk') });
      expect(await databaseRefusal(insert('SUP-2026-888888', 'Help', "now() + interval '1 day'"))).toMatchObject({ message: expect.stringContaining('support_ticket_subject_chk') });
      expect(await databaseRefusal(insert('SUP-2026-888889', 'A valid subject', "now() - interval '1 day'"))).toMatchObject({ message: expect.stringContaining('support_ticket_sla_chk') });
      expect(vietnamDateOf(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
