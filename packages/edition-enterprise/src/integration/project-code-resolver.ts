import { vietnamDateOf } from '@machvon/kernel';
import { SourceSystemStore, registerDirectMatchSystem } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { ENTERPRISE_CODE_SYSTEMS, ENTERPRISE_SYSTEM_SEEDS, coverageOf, resolveInbound, resolveOutbound } from './project-codes.ts';
import type { CodeMapping, Coverage, InboundResolution, OutboundResolution } from './project-codes.ts';

/**
 * The database half of the project codes of EBS and HPM (ENT-3e): reads the rows of `master_crosswalk` (subject PROJECT, type PROJECT_CODE, the system) and hands them to the pure rules of `project-codes.ts`. Nothing is
 * written here: the maker-checker life of a mapping is the one of INT-03 (`ProjectCodeStore`). The two systems are registered for the tenant by `ensureSystems`, once, by the first command that needs them.
 */
interface MappingSql {
  project_id: string;
  source_system: string;
  external_code: string;
  valid_from: string;
  valid_until: string | null;
  status: CodeMapping['status'];
}

const MAPPING_SELECT = `select x.subject_id as project_id, x.source_system, x.external_code, x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.status
  from machvon.master_crosswalk x where x.subject_type = 'PROJECT' and x.external_type = 'PROJECT_CODE'`;

const mappingOf = (row: MappingSql): CodeMapping => ({
  projectId: row.project_id,
  sourceSystem: row.source_system,
  externalCode: row.external_code,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
});

/** The two systems read by direct match while the crosswalk is being introduced (R25): the proposal and the approval of a mapping keep them from shadowing another project. Idempotent. */
export function registerEnterpriseCodeSystems(): void {
  for (const code of ENTERPRISE_CODE_SYSTEMS) registerDirectMatchSystem(code);
}

export class ProjectCodeResolver {
  /** Registers `EBS` and `HPM` in `int_source_system` of the tenant when they are not there; returns the codes it added. */
  async ensureSystems(tx: TenantTx, actor: string): Promise<string[]> {
    const systems = new SourceSystemStore();
    const added: string[] = [];
    for (const seed of ENTERPRISE_SYSTEM_SEEDS) {
      if ((await systems.byCode(tx, seed.code)) !== undefined) continue;
      await systems.register(tx, { code: seed.code, name: seed.code, kind: seed.kind, codePattern: seed.codePattern }, actor);
      added.push(seed.code);
    }
    return added;
  }

  /** The project a code of the other system stands for on a day (the Vietnam day of `at`): the mapping, else the direct match of the code against the code of one of our projects. */
  async inbound(tx: TenantTx, sourceSystem: string, externalCode: string, at: Date | string): Promise<InboundResolution> {
    const day = typeof at === 'string' ? at : vietnamDateOf(at);
    const mappings = (await tx.query<MappingSql>(`${MAPPING_SELECT} and x.source_system = $1 and x.external_code = $2 and x.status = 'ACTIVE'`, [sourceSystem, externalCode])).map(mappingOf);
    const direct = await tx.query<{ id: string }>('select id from machvon.project where code = $1', [externalCode]);
    return resolveInbound({ mappings, sourceSystem, externalCode, day, directProjectId: direct[0]?.id ?? null });
  }

  /** The code each project goes under in the other system on a day; every project asked for is answered (a project without a mapping goes under its own code, flagged `DIRECT`). */
  async outbound(tx: TenantTx, sourceSystem: string, projectIds: readonly string[], at: Date | string): Promise<Map<string, OutboundResolution & { ourCode: string }>> {
    const day = typeof at === 'string' ? at : vietnamDateOf(at);
    const answer = new Map<string, OutboundResolution & { ourCode: string }>();
    if (projectIds.length === 0) return answer;
    const projects = await tx.query<{ id: string; code: string }>('select id, code from machvon.project where id = any($1::uuid[]) order by code', [[...projectIds]]);
    const mappings = (await tx.query<MappingSql>(`${MAPPING_SELECT} and x.source_system = $1 and x.subject_id = any($2::uuid[]) and x.status = 'ACTIVE'`, [sourceSystem, [...projectIds]])).map(mappingOf);
    for (const project of projects) answer.set(project.id, { ...resolveOutbound({ mappings, sourceSystem, projectId: project.id, ourCode: project.code, day }), ourCode: project.code });
    return answer;
  }

  /** How far the mappings of one system reach over the projects of the tenant on a day (the figure that tells when the fallback may go). */
  async coverage(tx: TenantTx, sourceSystem: string, at: Date | string): Promise<Coverage> {
    const day = typeof at === 'string' ? at : vietnamDateOf(at);
    const projects = await tx.query<{ id: string; code: string }>('select id, code from machvon.project');
    const mappings = (await tx.query<MappingSql>(`${MAPPING_SELECT} and x.source_system = $1 and x.status in ('ACTIVE', 'PROPOSED')`, [sourceSystem])).map(mappingOf);
    return coverageOf({ projects, mappings, sourceSystem, day });
  }
}
