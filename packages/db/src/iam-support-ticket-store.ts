import { randomUUID } from 'node:crypto';
import { DomainError, addWorkingTime, asUuid, vietnamDateOf } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

export const TICKET_CATEGORIES = ['ACCESS', 'DATA', 'BILLING', 'INCIDENT', 'HOWTO', 'OTHER'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_STATUSES = ['Open', 'InProgress', 'WaitingCustomer', 'Resolved', 'Closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * How urgent a ticket is, decided by what it is about and not by the member (a member who could choose would choose P1): an incident is P1, trouble with
 * access or with data P2, billing P3, a question or anything else P4. The operator's side may change it later. A working assumption until the business
 * owner signs the table (TODOS.md, ST-IAM-007).
 */
export const PRIORITY_OF_CATEGORY: Readonly<Record<TicketCategory, TicketPriority>> = { INCIDENT: 'P1', ACCESS: 'P2', DATA: 'P2', BILLING: 'P3', HOWTO: 'P4', OTHER: 'P4' };

/**
 * The time to the SLA of a priority (IAM 3.6, an assumption): 4 hours, 1 day, 3 days and 10 days, counted in working time on the working calendar of the
 * tenant (8 working hours a day, BR-ADM-08), and as elapsed hours when the tenant has no published calendar for the years the count needs.
 */
export const SLA_WORKING_HOURS: Readonly<Record<TicketPriority, number>> = { P1: 4, P2: 8, P3: 24, P4: 80 };
export const SLA_ELAPSED_HOURS: Readonly<Record<TicketPriority, number>> = { P1: 4, P2: 24, P3: 72, P4: 240 };
/** The calendar of the tenant that counts the working days of the support SLA. */
export const SUPPORT_CALENDAR_CODE = 'WORKDAY_VN';
export const MAX_ATTACHMENTS = 5;
const SUBJECT_MIN = 5;
const SUBJECT_MAX = 200;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 10_000;
const HOUR_MS = 3_600_000;

export interface TicketInput {
  category: string;
  subject: string;
  description: string;
  attachmentIds?: readonly string[] | undefined;
}

export interface CreatedTicket {
  id: string;
  ticketCode: string;
  category: TicketCategory;
  priority: TicketPriority;
  slaDueAt: Date;
  /** Whether the SLA was counted in working time on the calendar of the tenant (else in elapsed hours). */
  onCalendar: boolean;
  attachmentCount: number;
  version: 1;
  status: 'Open';
}

export interface TicketRow {
  id: string;
  ticketCode: string;
  requesterMembershipId: string;
  category: TicketCategory;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  slaDueAt: string;
  createdAt: string;
  attachmentCount: number;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

interface TicketSql {
  id: string;
  ticket_code: string;
  requester_membership_id: string;
  category: TicketCategory;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  sla_due_at: string;
  created_at: string;
  attachment_count: string;
  version: string;
  created_at_key: string;
}

const SELECT = `select t.id, t.ticket_code, t.requester_membership_id, t.category, t.subject, t.priority, t.status, ${timestampKey('t.sla_due_at')} as sla_due_at, ${timestampKey('t.created_at')} as created_at,
  (select count(*) from machvon.support_ticket_attachment a where a.tenant_id = t.tenant_id and a.ticket_id = t.id)::text as attachment_count,
  t.version::text as version, ${timestampKey('t.created_at')} as created_at_key
  from machvon.support_ticket t`;

const toRow = (row: TicketSql): TicketRow => ({
  id: row.id,
  ticketCode: row.ticket_code,
  requesterMembershipId: row.requester_membership_id,
  category: row.category,
  subject: row.subject,
  priority: row.priority,
  status: row.status,
  slaDueAt: row.sla_due_at,
  createdAt: row.created_at,
  attachmentCount: Number(row.attachment_count),
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

/** Whether the text holds a control character; with `lineBreaks`, tabs and line breaks are allowed (a description spans lines). */
function hasControl(text: string, lineBreaks: boolean): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (lineBreaks && (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN)) continue;
    if (code < SPACE || code === DELETE) return true;
  }
  return false;
}

function textOf(value: unknown, field: string, min: number, max: number, lineBreaks: boolean): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max || hasControl(text, lineBreaks)) throw invalid(field);
  return text;
}

/**
 * The support ticket of a member (ST-IAM-007, IAM 3.6): any member may ask for help; the ticket gets its code (SUP-YYYY-NNNNNN, counted per tenant and
 * year), a priority from what it is about and a time by which the operator must have answered. What the platform operator sees of a ticket is its metadata and
 * its SLA; what the member wrote stays in the tenant's own table, which a view of the metadata never reads.
 */
export class IamSupportTicketStore {
  private readonly calendars: WorkCalendarStore;

  constructor(calendars: WorkCalendarStore = new WorkCalendarStore()) {
    this.calendars = calendars;
  }

  /** Creates the ticket of the requester. Refusals: the shape (422 VALIDATION_FAILED naming the field), an attachment that is not a document of the tenant (422). */
  async create(tx: TenantTx, input: TicketInput, requester: string, now: Date): Promise<CreatedTicket> {
    const category = TICKET_CATEGORIES.find((candidate) => candidate === input.category);
    if (category === undefined) throw invalid('category');
    const subject = textOf(input.subject, 'subject', SUBJECT_MIN, SUBJECT_MAX, false);
    const description = textOf(input.description, 'description', DESCRIPTION_MIN, DESCRIPTION_MAX, true);
    const attachments = this.attachmentsOf(input.attachmentIds);
    await this.assertAttachments(tx, attachments);

    const priority = PRIORITY_OF_CATEGORY[category];
    const due = await this.slaOf(tx, priority, now);
    const year = Number(vietnamDateOf(now).slice(0, 4));
    const counter = await tx.query<{ last_value: number }>(
      `insert into machvon.support_ticket_counter (tenant_id, ticket_year, last_value) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::int, 1)
       on conflict (tenant_id, ticket_year) do update set last_value = machvon.support_ticket_counter.last_value + 1 returning last_value`,
      [year],
    );
    const number = counter[0]?.last_value ?? 1;
    const id = randomUUID();
    const ticketCode = `SUP-${year}-${String(number).padStart(6, '0')}`;
    await tx.query(
      `insert into machvon.support_ticket (tenant_id, id, ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at, created_at, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4, $5, $6, $7, 'Open', $8::timestamptz, $9::timestamptz, 1)`,
      [id, ticketCode, requester, category, subject, `support_ticket_body:${id}`, priority, due.at.toISOString(), now.toISOString()],
    );
    await tx.query(`insert into machvon.support_ticket_body (tenant_id, ticket_id, description) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2)`, [id, description]);
    for (const documentVersionId of attachments) {
      await tx.query(
        `insert into machvon.support_ticket_attachment (tenant_id, ticket_id, document_version_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid)`,
        [id, documentVersionId],
      );
    }
    return { id, ticketCode, category, priority, slaDueAt: due.at, onCalendar: due.onCalendar, attachmentCount: attachments.length, version: 1, status: 'Open' };
  }

  /** The tickets of the tenant, newest first, of one requester when given. */
  async list(tx: TenantTx, filter: { requester?: string | undefined; status?: TicketStatus | undefined }, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<TicketRow[]> {
    const rows = await tx.query<TicketSql>(
      `${SELECT}
        where ($1::uuid is null or t.requester_membership_id = $1::uuid) and ($2::text is null or t.status = $2)
          and ($3::text is null or (${timestampKey('t.created_at')}, t.id) < ($3::text, $4::uuid))
        order by t.created_at desc, t.id desc limit $5`,
      [filter.requester ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** One ticket; undefined when it does not exist in the tenant. */
  async find(tx: TenantTx, id: string): Promise<TicketRow | undefined> {
    const rows = await tx.query<TicketSql>(`${SELECT} where t.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  private attachmentsOf(raw: readonly string[] | undefined): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw invalid('attachment_ids');
    const ids = raw.map((item) => asUuid(item));
    if (ids.some((item) => item === undefined)) throw invalid('attachment_ids');
    const unique = [...new Set(ids as string[])];
    if (unique.length !== ids.length) throw invalid('attachment_ids');
    return unique;
  }

  /** Every attachment is a version of a document of the tenant that is not infected. */
  private async assertAttachments(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.query<{ n: string }>("select count(*)::text as n from machvon.document_version where id = any($1::uuid[]) and scan_status <> 'INFECTED'", [ids]);
    if (Number(rows[0]?.n ?? 0) !== ids.length) throw invalid('attachment_ids');
  }

  /** The time by which an answer is due: working time on the calendar of the tenant, or elapsed hours when the calendar of a year the count needs is not published. */
  private async slaOf(tx: TenantTx, priority: TicketPriority, now: Date): Promise<{ at: Date; onCalendar: boolean }> {
    const source = await this.calendars.source(tx, SUPPORT_CALENDAR_CODE, Number(vietnamDateOf(now).slice(0, 4)));
    try {
      return { at: addWorkingTime(source, now, { hours: SLA_WORKING_HOURS[priority] }), onCalendar: true };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CALENDAR_NOT_EFFECTIVE') throw error;
      return { at: new Date(now.getTime() + SLA_ELAPSED_HOURS[priority] * HOUR_MS), onCalendar: false };
    }
  }
}
