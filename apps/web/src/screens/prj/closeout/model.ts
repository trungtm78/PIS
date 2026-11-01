import type { HandoverLine, HandoverStatus } from '../../ast/handover/model';
import type { Settlement } from '../../pay/settlement/model';
import { ACCOUNTABILITY_ROLES, openMembers } from '../accountability-model';
import type { AccountabilityRole, AssignmentLine, MemberRole, TaskForceLine } from '../accountability-model';
import type { ProjectStatus } from '../model';

/**
 * PRJ-08, PRJ-11 and PRJ-12: the team of a project, the handover of its assets and its settlement (ST-PRJ-011). These screens own no operation: they read what PRJ, AST and PAY already answer, for one project.
 * The readers of the answers are those of the screens that own them; what is added here is the choice of what belongs to the project and the reading of where its closing stands.
 */
export const TASK_FORCE_READ_PERMISSION = 'taskforce.read';

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read, and the server judges the scope again. */
export const mayRead = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

// ---- PRJ-08: the team ---------------------------------------------------------------------------------------------------------

interface TeamBase {
  key: string;
  person: string | null;
  validFrom: string;
  validUntil: string | null;
}

/** Who answers for the project in the register of assignments (PRJ-17). */
export interface AssignmentRow extends TeamBase {
  kind: 'assignment';
  role: AccountabilityRole;
}

/** A member of a task force (PRJ-18) whose term follows this project. */
export interface TaskForceRow extends TeamBase {
  kind: 'taskForce';
  role: MemberRole;
  forceCode: string;
  forceName: string;
  scopeUnit: string;
}

export type TeamRow = AssignmentRow | TaskForceRow;

/**
 * The people in force on a project: the assignments that are still active, then the members of the task forces still active whose term is on this project (a member without a project follows the whole scope of
 * the force, which is not a team of one project). The assignments come in the order of the roles, the members by force and by name.
 */
export function teamOf(project: { id: string; code: string }, assignments: readonly AssignmentLine[], forces: readonly TaskForceLine[]): TeamRow[] {
  const leaders = assignments
    .filter((line) => line.projectId === project.id && line.status === 'ACTIVE')
    .map((line): AssignmentRow => ({ kind: 'assignment', key: line.id, person: line.leaderName, role: line.role, validFrom: line.validFrom, validUntil: line.validUntil }))
    .sort((a, b) => ACCOUNTABILITY_ROLES.indexOf(a.role) - ACCOUNTABILITY_ROLES.indexOf(b.role));
  const members: TaskForceRow[] = forces
    .filter((force) => force.status === 'ACTIVE')
    .flatMap((force) =>
      openMembers(force)
        .filter((member) => member.projectCode === project.code)
        .map((member): TaskForceRow => ({
          kind: 'taskForce',
          key: member.id,
          person: member.displayName,
          role: member.role,
          validFrom: member.validFrom,
          validUntil: member.validUntil,
          forceCode: force.code,
          forceName: force.name,
          scopeUnit: force.scopeUnitName,
        })),
    )
    .sort((a, b) => a.forceCode.localeCompare(b.forceCode) || (a.person ?? '').localeCompare(b.person ?? ''));
  return [...leaders, ...members];
}

// ---- PRJ-11: the handover ---------------------------------------------------------------------------------------------------

/** The handovers of one project, in the order the read gave them (newest first). */
export const handoversOf = (projectId: string, handovers: readonly HandoverLine[]): HandoverLine[] => handovers.filter((line) => line.projectId === projectId);

const ON_THE_WAY: readonly HandoverStatus[] = ['DRAFT', 'INSPECTING', 'PUNCH_PENDING'];

/** The colour that goes with the state of a handover: accepted is green, on the way is blue, the ones that ended another way are grey. */
export const handoverTone = (status: HandoverStatus): 'green' | 'blue' | 'gray' => (status === 'ACCEPTED' ? 'green' : ON_THE_WAY.includes(status) ? 'blue' : 'gray');

/** How many handovers of the project were accepted, and how many are still on the way (not accepted, rejected or cancelled). */
export function handoverCounts(handovers: readonly HandoverLine[]): { accepted: number; open: number } {
  return { accepted: handovers.filter((line) => line.status === 'ACCEPTED').length, open: handovers.filter((line) => ON_THE_WAY.includes(line.status)).length };
}

// ---- PRJ-12: the settlement -----------------------------------------------------------------------------------------------------

/** The settlements of one project, in the order the read gave them (newest first). */
export const settlementsOf = (projectId: string, settlements: readonly Settlement[]): Settlement[] => settlements.filter((settlement) => settlement.projectId === projectId);

/** The settlement of the whole project that stands now: the revision of that scope with the highest number that was not superseded. */
export function closingSettlement(settlements: readonly Settlement[]): Settlement | undefined {
  return settlements
    .filter((settlement) => settlement.scope === 'PROJECT' && settlement.status !== 'SUPERSEDED')
    .reduce<Settlement | undefined>((best, settlement) => (best === undefined || settlement.revision > best.revision ? settlement : best), undefined);
}

/**
 * Where the closing stands. The project moves to SETTLED only when the settlement of the project closes (PRJ 3.1): `settled` once it has, `closedAwaitingStage` when the settlement closed and the project has not moved yet,
 * `waiting` when the project is completed and the settlement has not closed, and `notReached` before the project is completed (or when it ended another way).
 */
export type Closure = 'settled' | 'closedAwaitingStage' | 'waiting' | 'notReached';

export function closureOf(status: ProjectStatus, closing: Settlement | undefined): Closure {
  if (status === 'SETTLED' || status === 'CLOSED') return 'settled';
  if (status !== 'COMPLETED') return 'notReached';
  return closing?.status === 'CLOSED' ? 'closedAwaitingStage' : 'waiting';
}
