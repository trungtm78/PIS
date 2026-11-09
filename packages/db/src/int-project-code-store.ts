import { randomUUID } from 'node:crypto';
import { DomainError, PROJECT_CODE_EXTERNAL_TYPE, assertExternalCodeFits, egpMappingMove, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { EgpMappingMove, EgpMappingStatus, ProjectCodeRequest, SourceSystemKind, SourceSystemRequest } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The systems whose project codes are also read by direct match against the code of our own projects while the crosswalk is being introduced (ENT-3e: Oracle EBS and HPM, expand then contract). A code of such a
 * system may not be mapped to a project when it is, as text, the code of ANOTHER project: the direct reading would have meant that other project and the mapping would move its history. A public process registers none.
 */
const DIRECT_MATCH_SYSTEMS = new Set<string>();
export function registerDirectMatchSystem(code: string): void {
  DIRECT_MATCH_SYSTEMS.add(code);
}
export const isDirectMatchSystem = (code: string): boolean => DIRECT_MATCH_SYSTEMS.has(code);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The systems whose codes we map.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface SourceSystemRow {
  id: string;
  code: string;
  name: string;
  kind: SourceSystemKind;
  codePattern: string | null;
  status: 'ACTIVE' | 'RETIRED';
  retireReason: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  activeCodes: number;
  proposedCodes: number;
  version: number;
  createdAt: string;
}

interface SourceSystemSql {
  id: string;
  code: string;
  name: string;
  kind: SourceSystemKind;
  code_pattern: string | null;
  status: 'ACTIVE' | 'RETIRED';
  retire_reason: string | null;
  retired_by: string | null;
  retired_at: string | null;
  active_codes: string;
  proposed_codes: string;
  version: string;
  created_at: string;
}

const SYSTEM_SELECT = `select s.id, s.code, s.name, s.kind, s.code_pattern, s.status, s.retire_reason, s.retired_by, to_char(s.retired_at at time zone 'UTC', ${ISO}) as retired_at,
    (select count(*) from machvon.master_crosswalk x where x.tenant_id = s.tenant_id and x.source_system = s.code and x.external_type = '${PROJECT_CODE_EXTERNAL_TYPE}' and x.status = 'ACTIVE')::text as active_codes,
    (select count(*) from machvon.master_crosswalk x where x.tenant_id = s.tenant_id and x.source_system = s.code and x.external_type = '${PROJECT_CODE_EXTERNAL_TYPE}' and x.status = 'PROPOSED')::text as proposed_codes,
    s.version::text as version, to_char(s.created_at at time zone 'UTC', ${ISO}) as created_at
  from machvon.int_source_system s`;

const systemOf = (row: SourceSystemSql): SourceSystemRow => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  codePattern: row.code_pattern,
  status: row.status,
  retireReason: row.retire_reason,
  retiredBy: row.retired_by,
  retiredAt: row.retired_at,
  activeCodes: Number(row.active_codes),
  proposedCodes: Number(row.proposed_codes),
  version: Number(row.version),
  createdAt: row.created_at,
});

/** The other systems of the organization whose project codes are mapped (INT-1). A system is registered once under a code of capital letters; it can be retired only when no code of it is ACTIVE or waiting. */
export class SourceSystemStore {
  async list(tx: TenantTx): Promise<SourceSystemRow[]> {
    return (await tx.query<SourceSystemSql>(`${SYSTEM_SELECT} order by s.status, s.code`)).map(systemOf);
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<SourceSystemRow | undefined> {
    const rows = await tx.query<SourceSystemSql>(`${SYSTEM_SELECT} where s.id = $1::uuid${lock ? ' for update of s' : ''}`, [id]);
    return rows[0] === undefined ? undefined : systemOf(rows[0]);
  }

  async byCode(tx: TenantTx, code: string): Promise<SourceSystemRow | undefined> {
    const rows = await tx.query<SourceSystemSql>(`${SYSTEM_SELECT} where s.code = $1`, [code]);
    return rows[0] === undefined ? undefined : systemOf(rows[0]);
  }

  async register(tx: TenantTx, request: SourceSystemRequest, actor: string): Promise<SourceSystemRow> {
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.int_source_system (tenant_id, id, code, name, kind, code_pattern, created_by, updated_by) values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6::uuid, $6::uuid)`,
        [id, request.code, request.name, request.kind, request.codePattern, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('INT_SOURCE_SYSTEM_TAKEN', 409, 'code');
      throw error;
    }
    return (await this.find(tx, id)) as SourceSystemRow;
  }

  /** Retires a system for good, with the reason; refused while a code of it is ACTIVE or waiting for a decision (the codes are retired or rejected first). */
  async retire(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<{ before: SourceSystemRow; row: SourceSystemRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status === 'RETIRED') throw new DomainError('INT_SOURCE_SYSTEM_IN_USE', 409, 'status', { extensions: { reason: 'ALREADY_RETIRED' } });
    if (before.activeCodes > 0 || before.proposedCodes > 0) throw new DomainError('INT_SOURCE_SYSTEM_IN_USE', 409, 'status', { extensions: { reason: 'CODES_OPEN', active: before.activeCodes, proposed: before.proposedCodes } });
    await tx.query(
      `update machvon.int_source_system set status = 'RETIRED', retire_reason = $2, retired_by = $3::uuid, retired_at = $4::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, reason, actor, now.toISOString()],
    );
    return { before, row: (await this.find(tx, id)) as SourceSystemRow };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The codes of our projects in those systems: rows of `master_crosswalk` (subject PROJECT, type PROJECT_CODE).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ProjectCodeRow {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  sourceSystem: string;
  externalCode: string;
  validFrom: string;
  validUntil: string | null;
  status: EgpMappingStatus;
  proposedBy: string;
  proposalReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface ProjectCodeSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  source_system: string;
  external_code: string;
  valid_from: string;
  valid_until: string | null;
  status: EgpMappingStatus;
  created_by: string;
  proposal_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_reason: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
}

const CODE_SELECT = `select x.id, x.subject_id as project_id, p.code as project_code, p.name as project_name, x.source_system, x.external_code, x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.status,
    x.created_by, x.proposal_reason, x.approved_by, to_char(x.approved_at at time zone 'UTC', ${ISO}) as approved_at, x.decision_reason, x.retired_by, to_char(x.retired_at at time zone 'UTC', ${ISO}) as retired_at,
    x.retire_reason, x.version::text as version, to_char(x.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('x.created_at')} as created_at_key
  from machvon.master_crosswalk x join machvon.project p on p.tenant_id = x.tenant_id and p.id = x.subject_id
 where x.subject_type = 'PROJECT' and x.external_type = '${PROJECT_CODE_EXTERNAL_TYPE}'`;

const codeOf = (row: ProjectCodeSql): ProjectCodeRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  sourceSystem: row.source_system,
  externalCode: row.external_code,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  proposedBy: row.created_by,
  proposalReason: row.proposal_reason,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  decisionReason: row.decision_reason,
  retiredBy: row.retired_by,
  retiredAt: row.retired_at,
  retireReason: row.retire_reason,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface ProjectCodeFilter {
  sourceSystem?: string | undefined;
  status?: EgpMappingStatus | undefined;
  q?: string | undefined;
}

/**
 * The codes of our projects in the other systems of the organization (INT-1 part 3), on `master_crosswalk`. The life is the one of EGP-1 (V1940): a code is PROPOSED by one person and becomes ACTIVE when ANOTHER
 * approves it, REJECTED and RETIRED are final, and one code stands for one project in a system at a time, one project holds one ACTIVE code per system. The database holds the same rules (unique indexes, the CHECKs of
 * V1940, the trigger of V2203 for the registered system and the format), so a race ends in the same answer.
 */
export class ProjectCodeStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<ProjectCodeRow | undefined> {
    const rows = await tx.query<ProjectCodeSql>(`${CODE_SELECT} and x.id = $1::uuid${lock ? ' for update of x' : ''}`, [id]);
    return rows[0] === undefined ? undefined : codeOf(rows[0]);
  }

  async list(tx: TenantTx, filter: ProjectCodeFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<ProjectCodeRow[]> {
    const like = filter.q === undefined ? null : `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.query<ProjectCodeSql>(
      `select * from (${CODE_SELECT}) m
        where ($1::text is null or m.source_system = $1) and ($2::text is null or m.status = $2)
          and ($3::text is null or m.external_code ilike $3 escape '\\' or m.project_code ilike $3 escape '\\' or m.project_name ilike $3 escape '\\')
          and ($4::text is null or (m.created_at_key, m.id) < ($4::text, $5::uuid))
        order by m.created_at_key desc, m.id desc limit $6`,
      [filter.sourceSystem ?? null, filter.status ?? null, like, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(codeOf);
  }

  async counts(tx: TenantTx): Promise<Record<EgpMappingStatus, number>> {
    const rows = await tx.query<{ status: EgpMappingStatus; n: string }>(
      `select status, count(*)::text as n from machvon.master_crosswalk where subject_type = 'PROJECT' and external_type = '${PROJECT_CODE_EXTERNAL_TYPE}' group by status`,
    );
    const counts: Record<EgpMappingStatus, number> = { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  /** Proposes the code of a project in a system. Our project is found by its code (422 `our_code` when there is none); the system must be registered and ACTIVE and the code must fit its format. */
  async propose(tx: TenantTx, request: ProjectCodeRequest & { reason: string }, actor: string, now: Date): Promise<ProjectCodeRow> {
    const systems = new SourceSystemStore();
    const system = await systems.byCode(tx, request.sourceSystem);
    if (system === undefined || system.status !== 'ACTIVE') throw new DomainError('VALIDATION_FAILED', 422, 'source_system');
    assertExternalCodeFits(system, request.externalCode);
    const projects = await tx.query<{ id: string }>('select id from machvon.project where code = $1', [request.ourCode]);
    if (projects[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'our_code');
    const projectId = projects[0].id;
    const validFrom = request.validFrom ?? vietnamDateOf(now);
    if (request.validUntil !== null && request.validUntil <= validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    // Another project holds the code, or this project holds another code in the system: the person retires the old mapping first, nothing is relinked silently.
    const taken = await tx.query<{ subject_id: string }>(
      `select subject_id from machvon.master_crosswalk where source_system = $1 and external_type = '${PROJECT_CODE_EXTERNAL_TYPE}' and status = 'ACTIVE' and (external_code = $2 or subject_id = $3::uuid)`,
      [request.sourceSystem, request.externalCode, projectId],
    );
    if (taken.length > 0) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: taken.some((row) => row.subject_id !== projectId) ? 'EXTERNAL_CODE_TAKEN' : 'SUBJECT_HAS_OTHER_CODE' } });
    await this.assertKeepsHistory(tx, request.sourceSystem, request.externalCode, projectId);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.master_crosswalk
           (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, valid_until, match_method, status, proposal_reason, created_by, updated_by)
         values (${TENANT}, $1::uuid, null, 'PROJECT', $2::uuid, $3, '${PROJECT_CODE_EXTERNAL_TYPE}', $4, $5::date, $6::date, 'MANUAL', 'PROPOSED', $7, $8::uuid, $8::uuid)`,
        [id, projectId, request.sourceSystem, request.externalCode, validFrom, request.validUntil, request.reason, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: 'ALREADY_PROPOSED' } });
      throw error;
    }
    return (await this.find(tx, id)) as ProjectCodeRow;
  }

  /** For a system that is also read by direct match: the code may not be the code of another project (409 `CROSSWALK_DUPLICATE`, reason `EXTERNAL_CODE_IS_OTHER_PROJECT`). */
  private async assertKeepsHistory(tx: TenantTx, sourceSystem: string, externalCode: string, projectId: string): Promise<void> {
    if (!isDirectMatchSystem(sourceSystem)) return;
    const other = await tx.query<{ id: string }>('select id from machvon.project where code = $1 and id <> $2::uuid', [externalCode, projectId]);
    if (other.length > 0) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: 'EXTERNAL_CODE_IS_OTHER_PROJECT' } });
  }

  /** Approves, rejects or retires a code (a versioned command). The kernel decides the edge, the maker-checker rule and the reason; an approval is judged once more against the ACTIVE codes. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { move: EgpMappingMove; reason: unknown }, actor: string, now: Date): Promise<{ before: ProjectCodeRow; row: ProjectCodeRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = egpMappingMove({ status: before.status, proposedBy: before.proposedBy }, { move: step.move, actorId: actor, reason: step.reason });
    const today = vietnamDateOf(now);
    try {
      if (step.move === 'RETIRE') {
        // The day it no longer holds is today, never on or before the day it began.
        await tx.query(
          `update machvon.master_crosswalk
              set status = 'RETIRED', valid_until = least(coalesce(valid_until, 'infinity'::date), greatest($2::date, valid_from + 1)), retired_by = $3::uuid, retired_at = $5::timestamptz, retire_reason = $4,
                  updated_at = now(), updated_by = $3::uuid, version = version + 1
            where id = $1::uuid`,
          [id, today, actor, decided.reason, now.toISOString()],
        );
      } else {
        if (step.move === 'APPROVE') {
          if (before.validUntil !== null && before.validUntil <= today) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
          const system = await new SourceSystemStore().byCode(tx, before.sourceSystem);
          if (system === undefined || system.status !== 'ACTIVE') throw new DomainError('VALIDATION_FAILED', 422, 'source_system');
          await this.assertKeepsHistory(tx, before.sourceSystem, before.externalCode, before.projectId);
        }
        await tx.query(
          `update machvon.master_crosswalk set status = $2, approved_by = $3::uuid, approved_at = $5::timestamptz, decision_reason = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
          [id, decided.to, actor, decided.reason, now.toISOString()],
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code');
      throw error;
    }
    return { before, row: (await this.find(tx, id)) as ProjectCodeRow };
  }
}
