import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { DOCUMENT_FIXTURES, MEMBERSHIP_FIXTURES, PROJECT_FIXTURES, UNIT_FIXTURES } from '../../suite';
import { DIRECTIVE_FIXTURES } from './directive.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';

function foreignUnit(index: number): string {
  const unit = UNIT_FIXTURES[FOREIGN][index];
  if (unit === undefined) throw new Error(`The isolation fixtures hold no unit ${index} for ${FOREIGN}`);
  return unit.id;
}

const meeting = DIRECTIVE_FIXTURES[FOREIGN].meeting;
const directives = DIRECTIVE_FIXTURES[FOREIGN].directives;
const extension = DIRECTIVE_FIXTURES[FOREIGN].extension;
const documentVersionId = DOCUMENT_FIXTURES[FOREIGN].versionId;

/**
 * The foreign-id cases of the steering meetings and the directives (DIR): a TNT-A user names a meeting, a directive, a request to move a due day or a project of TNT-B. Each command and each read has a
 * directive of its own (see `DirectiveRole`), so that what the owner does in the control run never takes the object of another case away. The bodies are valid, so that the request reaches the lookup.
 */
export const DIRECTIVE_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getSteeringMeeting', method: 'GET', id: meeting.id },
  { operation: 'getDirective', method: 'GET', id: directives.read.id },
  { operation: 'listProjectDirectives', method: 'GET', id: PROJECT_FIXTURES[FOREIGN].id },
  { operation: 'attachMeetingMinutes', method: 'POST', id: meeting.id, versioned: true, body: { document_version_id: documentVersionId } },
  {
    operation: 'addDirective',
    method: 'POST',
    id: meeting.id,
    body: { scope_kind: 'UNIT', unit_id: foreignUnit(0), text: 'Isolation foreign directive attempt', assignee_unit_id: foreignUnit(1), due_on: '2026-12-31' },
  },
  { operation: 'assignDirective', method: 'POST', id: directives.assign.id, versioned: true, body: { assignee_unit_id: foreignUnit(0), note: 'Isolation foreign assignment attempt' } },
  { operation: 'recordDirectiveProgress', method: 'POST', id: directives.progress.id, body: { note: 'Isolation foreign progress attempt', progress_pct: 10 } },
  { operation: 'requestDirectiveExtension', method: 'POST', id: directives.extend.id, body: { proposed_due_on: extension.proposedDueOn, reason: 'Isolation foreign extension attempt' } },
  { operation: 'decideDirectiveExtension', method: 'POST', id: extension.id, versioned: true, body: { decision: 'approve', reason: 'Isolation foreign decision attempt' } },
  { operation: 'closeDirective', method: 'POST', id: directives.close.id, versioned: true, body: { note: 'Isolation foreign closing attempt', evidence_document_version_ids: [documentVersionId] } },
  { operation: 'cancelDirective', method: 'POST', id: directives.cancel.id, versioned: true, body: { reason: 'Isolation foreign cancellation attempt' } },
  { operation: 'reopenDirective', method: 'POST', id: directives.reopen.id, versioned: true, body: { reason: 'Isolation foreign reopening attempt' } },
];

/** Every operation of the DIR controllers on the tenant plane: the suite principal holds the permission of each. */
export const DIRECTIVE_OPERATIONS: readonly string[] = [
  'createSteeringMeeting',
  'attachMeetingMinutes',
  'addDirective',
  'assignDirective',
  'recordDirectiveProgress',
  'requestDirectiveExtension',
  'decideDirectiveExtension',
  'closeDirective',
  'cancelDirective',
  'reopenDirective',
  'listDirectives',
  'listOverdueDirectives',
  'getDirectiveSummary',
  'getDirectivesForReport',
  'getDirectiveWidget',
  'getDirective',
  'listProjectDirectives',
  'listSteeringMeetings',
  'getSteeringMeeting',
];

/** The tables the directive seed fills, all with an `id`; nothing in them changes when a row is only read or found. */
export const DIRECTIVE_SNAPSHOT_TABLES: readonly string[] = ['steering_meeting', 'directive', 'directive_extension', 'directive_event', 'directive_evidence'];

const INSERT_MEETING = `insert into machvon.steering_meeting
  (tenant_id, id, code, meeting_year, seq, meeting_date, meeting_type, title, summary, unit_id, version, created_by)
  values ($1, $2, $3, 2026, 1, $4::date, 'MONTHLY', $5, $6, $7, 1, $8) on conflict do nothing`;

const INSERT_DIRECTIVE = `insert into machvon.directive
  (tenant_id, id, meeting_id, seq, code, scope_kind, project_id, scope_unit_id, directive_text, assignee_unit_id, assignee_membership_id, original_due_on, due_on,
   extension_count, status, closed_by, closed_at, version, created_by)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $12::date, 0, $13, $14, $15, $16, $17) on conflict do nothing`;

const INSERT_EXTENSION = `insert into machvon.directive_extension
  (tenant_id, id, directive_id, from_due_on, proposed_due_on, reason, status, requested_by, requested_at, version)
  values ($1, $2, $3, $4::date, $5::date, $6, 'REQUESTED', $7, timestamptz '2026-02-25 08:00:00+00', 1) on conflict do nothing`;

const INSERT_EVENT = `insert into machvon.directive_event
  (tenant_id, id, directive_id, event_type, actor_id, occurred_at, note, progress_pct, to_assignee_unit_id, from_due_on, to_due_on, extension_id, directive_version)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing`;

const INSERT_EVIDENCE = `insert into machvon.directive_evidence
  (tenant_id, id, directive_id, event_id, document_version_id, added_by)
  values ($1, $2, $3, $4, $5, $6) on conflict do nothing`;

/**
 * Seeds, for the tenant of the context, one meeting held by its first unit with eight directives: each command and read has the directive in the state it looks for (open, with an open request to move the
 * due day, done), given by a member other than the suite principal, so that the owner may close it and decide the request. The days are fixed and in the past, so that the directives are live and overdue
 * whatever the day the suite runs on, and the request to move a due day is within the days the default policy allows.
 */
export async function seedDirective(client: Client, context: SeedContext): Promise<void> {
  const fixtures = DIRECTIVE_FIXTURES[context.tenant];
  const tenantId = context.tenantId;
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const closer = context.membershipId;
  const project = PROJECT_FIXTURES[context.tenant].id;
  const doingUnit = UNIT_FIXTURES[context.tenant][1]?.id ?? context.home;
  const documentVersion = DOCUMENT_FIXTURES[context.tenant].versionId;
  const raised = `${fixtures.meeting.meetingDate}T09:00:00Z`;

  await client.query(INSERT_MEETING, [tenantId, fixtures.meeting.id, fixtures.meeting.code, fixtures.meeting.meetingDate, fixtures.meeting.title, fixtures.meeting.summary, context.home, maker]);

  for (const directive of Object.values(fixtures.directives)) {
    const aboutProject = directive.scopeKind === 'PROJECT';
    const done = directive.status === 'DONE';
    await client.query(INSERT_DIRECTIVE, [
      tenantId,
      directive.id,
      fixtures.meeting.id,
      directive.seq,
      directive.code,
      directive.scopeKind,
      aboutProject ? project : null,
      context.home,
      directive.text,
      doingUnit,
      aboutProject ? maker : null,
      directive.dueOn,
      directive.status,
      done ? closer : null,
      done ? '2026-02-12T10:00:00Z' : null,
      directive.version,
      maker,
    ]);
    await client.query(INSERT_EVENT, [tenantId, directive.createdEventId, directive.id, 'CREATED', maker, raised, null, null, doingUnit, null, directive.dueOn, null, 1]);
  }

  // The open request to move the due day of the `decide` directive, asked for by the maker, so that the principal may decide it.
  const decide = fixtures.directives.decide;
  await client.query(INSERT_EXTENSION, [tenantId, fixtures.extension.id, decide.id, decide.dueOn, fixtures.extension.proposedDueOn, fixtures.extension.reason, maker]);
  await client.query(INSERT_EVENT, [
    tenantId,
    fixtures.extension.requestedEventId,
    decide.id,
    'EXTENSION_REQUESTED',
    maker,
    '2026-02-25T08:00:00Z',
    fixtures.extension.reason,
    null,
    null,
    decide.dueOn,
    fixtures.extension.proposedDueOn,
    fixtures.extension.id,
    decide.version,
  ]);

  // A note of progress on the timeline of the directive that is read.
  const read = fixtures.directives.read;
  await client.query(INSERT_EVENT, [tenantId, fixtures.progress.eventId, read.id, 'PROGRESS', maker, '2026-02-02T09:00:00Z', fixtures.progress.note, 50, null, null, null, null, read.version]);

  // The closing of the directive that is done, with its evidence document.
  const reopen = fixtures.directives.reopen;
  await client.query(INSERT_EVENT, [tenantId, fixtures.closing.eventId, reopen.id, 'CLOSED', closer, '2026-02-12T10:00:00Z', fixtures.closing.note, null, null, null, null, null, reopen.version]);
  await client.query(INSERT_EVIDENCE, [tenantId, fixtures.closing.evidenceId, reopen.id, fixtures.closing.eventId, documentVersion, closer]);
}
