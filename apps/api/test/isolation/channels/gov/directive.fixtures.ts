import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the directive fragment in the ids of its fixtures. */
const GROUP = 2;

/** The families of ids: the meeting, the directives, the request to move a due day, the events of the timelines and the evidence documents. */
const FAMILY = { meeting: 1, directive: 2, extension: 3, event: 4, evidence: 5 } as const;

/**
 * The directives the isolation suite seeds, each for one command or read, so that a command of the owner changes the directive of its own case only:
 * `assign`, `progress`, `extend` (a request to move the due day is made), `decide` (a request is open and waits for the decision), `close`, `cancel`, `reopen` (a directive that is done)
 * and `read` (a directive of a project in progress, with a note of progress on its timeline).
 */
export type DirectiveRole = 'assign' | 'progress' | 'extend' | 'decide' | 'close' | 'cancel' | 'reopen' | 'read';

export interface DirectiveFixture {
  id: string;
  seq: number;
  code: string;
  text: string;
  scopeKind: 'PROJECT' | 'UNIT';
  /** The status the row is seeded in. */
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE';
  version: number;
  /** The first due day of the directive, which is also the due day it is seeded with. */
  dueOn: string;
  /** The id of the first event of its timeline (CREATED). */
  createdEventId: string;
}

export interface DirectiveFixtures {
  meeting: { id: string; code: string; title: string; summary: string; meetingDate: string };
  directives: Readonly<Record<DirectiveRole, DirectiveFixture>>;
  /** The request to move the due day of the `decide` directive, open and waiting. */
  extension: { id: string; reason: string; proposedDueOn: string; requestedEventId: string };
  /** The note of progress on the timeline of the `read` directive. */
  progress: { eventId: string; note: string };
  /** How the `reopen` directive was closed: the note of the closing and the event that carries the evidence. */
  closing: { eventId: string; note: string; evidenceId: string };
}

const ROLES: ReadonlyArray<{ role: DirectiveRole; text: string; scopeKind: 'PROJECT' | 'UNIT'; status: 'OPEN' | 'IN_PROGRESS' | 'DONE'; version: number; dueOn: string }> = [
  { role: 'assign', text: 'to hand the site clearance report to the operations unit', scopeKind: 'UNIT', status: 'OPEN', version: 1, dueOn: '2026-02-20' },
  { role: 'progress', text: 'to report the progress of the disbursement every week', scopeKind: 'UNIT', status: 'OPEN', version: 1, dueOn: '2026-02-27' },
  { role: 'extend', text: 'to finish the appraisal of the second package', scopeKind: 'UNIT', status: 'OPEN', version: 1, dueOn: '2026-03-01' },
  { role: 'decide', text: 'to settle the dispute with the contractor of the bridge', scopeKind: 'UNIT', status: 'OPEN', version: 2, dueOn: '2026-03-01' },
  { role: 'close', text: 'to publish the minutes of the quarter on the portal', scopeKind: 'UNIT', status: 'OPEN', version: 1, dueOn: '2026-03-05' },
  { role: 'cancel', text: 'to prepare the visit of the delegation of the province', scopeKind: 'UNIT', status: 'OPEN', version: 1, dueOn: '2026-03-10' },
  { role: 'reopen', text: 'to hand over the inspection record of the road section', scopeKind: 'UNIT', status: 'DONE', version: 1, dueOn: '2026-02-15' },
  { role: 'read', text: 'to complete the resettlement records of the project', scopeKind: 'PROJECT', status: 'IN_PROGRESS', version: 2, dueOn: '2026-02-10' },
];

function build(tenant: TenantName): DirectiveFixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  const prefix = tenant === 'TNT-A' ? 'ALPHA' : 'BETA';
  const meetingCode = `${prefix}-GB-2026-001`;
  const entries = ROLES.map((entry, index) => {
    const seq = index + 1;
    const fixture: DirectiveFixture = {
      id: fixtureId(tenant, GROUP, FAMILY.directive, seq),
      seq,
      code: `${meetingCode}/CD-${String(seq).padStart(2, '0')}`,
      text: `${label} directive ${entry.role}: ${entry.text}`,
      scopeKind: entry.scopeKind,
      status: entry.status,
      version: entry.version,
      dueOn: entry.dueOn,
      createdEventId: fixtureId(tenant, GROUP, FAMILY.event, seq),
    };
    return [entry.role, fixture] as const;
  });
  const directives = Object.fromEntries(entries) as Record<DirectiveRole, DirectiveFixture>;
  return {
    meeting: {
      id: fixtureId(tenant, GROUP, FAMILY.meeting),
      code: meetingCode,
      title: `${label} steering meeting of the first quarter`,
      summary: `${label} summary of the steering meeting: the leadership reviewed the disbursement and the site clearance`,
      meetingDate: '2026-01-15',
    },
    directives,
    extension: {
      id: fixtureId(tenant, GROUP, FAMILY.extension),
      reason: `${label} extension reason: the contractor needs more days for the survey`,
      proposedDueOn: '2026-04-15',
      requestedEventId: fixtureId(tenant, GROUP, FAMILY.event, 40),
    },
    progress: { eventId: fixtureId(tenant, GROUP, FAMILY.event, 30), note: `${label} progress note: half of the records are collected` },
    closing: { eventId: fixtureId(tenant, GROUP, FAMILY.event, 70), note: `${label} closing note: the inspection record was handed over`, evidenceId: fixtureId(tenant, GROUP, FAMILY.evidence) },
  };
}

export const DIRECTIVE_FIXTURES: Readonly<Record<TenantName, DirectiveFixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/** Every id and every distinctive text of the directive fixtures of a tenant: none of them may reach an answer given to the other tenant. */
export function directiveMarkers(tenant: TenantName): Marker[] {
  const fixtures = DIRECTIVE_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'steering meeting id', value: fixtures.meeting.id },
    { kind: 'steering meeting code', value: fixtures.meeting.code },
    { kind: 'steering meeting title', value: fixtures.meeting.title },
    { kind: 'steering meeting summary', value: fixtures.meeting.summary },
    { kind: 'directive extension id', value: fixtures.extension.id },
    { kind: 'directive extension reason', value: fixtures.extension.reason },
    { kind: 'directive extension event id', value: fixtures.extension.requestedEventId },
    { kind: 'directive progress event id', value: fixtures.progress.eventId },
    { kind: 'directive progress note', value: fixtures.progress.note },
    { kind: 'directive closing event id', value: fixtures.closing.eventId },
    { kind: 'directive closing note', value: fixtures.closing.note },
    { kind: 'directive evidence id', value: fixtures.closing.evidenceId },
  ];
  for (const directive of Object.values(fixtures.directives)) {
    markers.push(
      { kind: 'directive id', value: directive.id },
      { kind: 'directive code', value: directive.code },
      { kind: 'directive text', value: directive.text },
      { kind: 'directive created event id', value: directive.createdEventId },
    );
  }
  return markers;
}
