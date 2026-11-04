import { DomainError, NATIONAL_CODE_MAX_LENGTH, nationalCodeFileFormat, versionConflict, hasControlChar } from '@machvon/kernel';
import type { Difference, NationalCodeRow, Rejection } from '@machvon/kernel';
import type { FileImportAdapter, ImportEntry } from './file-import-store.ts';
import { MasterRules } from './master-rules.ts';
import type { NationalCodeRule } from './master-rules.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification, ProjectStatus } from './prj-project-store.ts';
import { STAGE_SEQUENCE, TERMINAL_STAGES } from './prj-stage-machine.ts';
import { nationalCodeReading } from './prj-stage-store.ts';
import type { GuardReading } from './prj-stage-store.ts';
import { invalid, lockProject, usableDocumentId } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The national project code of a project (ST-PRJ-004, PRJ 3.1 F7, BR-PRJ-02): assigned by hand or taken from the reconciliation file, one code to one
 * project in a tenant, in the format the rule data says, and changed only with a ground once the project is under way. Whether a project without a
 * code may start, or be funded, is the rule NATIONAL_CODE_REQUIRED (`NationalCodeGate` is its one reading for the modules that ask).
 */

const UNIQUE_VIOLATION = '23505';
const CODE_CONSTRAINT = 'project_national_code_uq';
const SAVEPOINT = 'national_code_assign';
/** From this stage on a project is under way: a code it holds is not changed without the document that grounds the change. */
const UNDER_WAY_FROM = STAGE_SEQUENCE.IMPLEMENTATION;
const FROZEN: readonly ProjectStatus[] = TERMINAL_STAGES;

/** The code as it is stored: trimmed, at most as long as the contract says, no control character. */
export function nationalCodeOf(value: string): string {
  const code = value.trim();
  if (code === '' || code.length > NATIONAL_CODE_MAX_LENGTH || hasControlChar(code)) throw invalid('national_project_code');
  return code;
}

/** Whether the code has the format of the rule in force; no format rule means any code does. */
export function hasCodeFormat(rule: NationalCodeRule | undefined, code: string): boolean {
  const format = rule?.format ?? null;
  return format === null || new RegExp(format.pattern).test(code);
}

export interface NationalCodeAssignRequest {
  projectId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
  nationalCode: string;
  /** The document that grounds a change of a code that was assigned already, once the project is under way. */
  evidenceDocumentId?: string | undefined;
  today: string;
}

/** What an assignment left, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface AssignedNationalCode {
  projectId: string;
  /** The internal code of the project. */
  code: string;
  classification: ProjectClassification;
  status: ProjectStatus;
  version: number;
  previous: string | null;
  current: string;
  changed: boolean;
  evidenceDocumentId: string | null;
  via: 'MANUAL' | 'IMPORT';
  importId?: string | undefined;
}

export class PrjNationalCodeStore {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /**
   * Assigns the national code of a project by hand, or changes it. The project must lie in the scope of the permission (readable but not actionable
   * is 403, out of sight 404), the version must be the current one, a project that has ended keeps its code, the code must have the format of the
   * rule in force and belong to no other project of the tenant, and a code that was assigned and is changed once the project is under way needs the
   * document that grounds the change. The same code again changes nothing (no new version).
   */
  async assign(tx: TenantTx, request: NationalCodeAssignRequest): Promise<AssignedNationalCode> {
    const locked = await lockProject(tx, request.projectId, request.scopes);
    if (locked.version !== request.expectedVersion) throw versionConflict(locked.version);
    if (FROZEN.includes(locked.status)) throw new DomainError('STAGE_LOCKED_FIELD', 422, 'national_project_code');
    const code = nationalCodeOf(request.nationalCode);
    const rule = await this.rules.nationalCode(tx, request.today);
    if (!hasCodeFormat(rule, code)) throw new DomainError('NATIONAL_CODE_FORMAT_INVALID', 422, 'national_project_code');
    const previous = locked.nationalProjectCode;
    const evidence = request.evidenceDocumentId === undefined ? null : await usableDocumentId(tx, request.evidenceDocumentId, 'evidence_document_id');
    const base = { projectId: locked.id, code: locked.code, classification: locked.classification, status: locked.status, previous, current: code, evidenceDocumentId: evidence, via: 'MANUAL' as const };
    if (previous === code) return { ...base, version: locked.version, changed: false };
    if (previous !== null && STAGE_SEQUENCE[locked.status] >= UNDER_WAY_FROM && evidence === null) throw new DomainError('DECISION_REQUIRED', 422, 'evidence_document_id');
    await this.assertFree(tx, code, locked.id);
    const version = locked.version + 1;
    await this.setCode(tx, locked.id, code, request.actor, version);
    return { ...base, version, changed: true };
  }

  private async assertFree(tx: TenantTx, code: string, projectId: string): Promise<void> {
    const holder = await tx.query<{ id: string }>('select id from machvon.project where national_project_code = $1 and id <> $2::uuid', [code, projectId]);
    if (holder[0] !== undefined) throw new DomainError('NATIONAL_CODE_DUPLICATE', 409, 'national_project_code');
  }

  /** The write, under a savepoint: of two assignments of one code at once the loser is told 409 NATIONAL_CODE_DUPLICATE, not a failed transaction. */
  async setCode(tx: TenantTx, projectId: string, code: string, actor: string, version: number): Promise<void> {
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(`update machvon.project set national_project_code = $2, updated_at = now(), updated_by = $3::uuid, version = $4::bigint where id = $1::uuid`, [projectId, code, actor, version]);
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CODE_CONSTRAINT) {
        await tx.query(`rollback to savepoint ${SAVEPOINT}`);
        throw new DomainError('NATIONAL_CODE_DUPLICATE', 409, 'national_project_code');
      }
      throw error;
    }
  }

  /** The adapter that reads the reconciliation file for this caller: the projects it may touch, the rule in force, who acts. */
  async importAdapter(tx: TenantTx, context: { scope: ScopeBuilder; actor: string; today: string }): Promise<NationalCodeImportAdapter> {
    return new NationalCodeImportAdapter(this, { ...context, rule: await this.rules.nationalCode(tx, context.today) });
  }

}

interface ProjectRow {
  id: string;
  code: string;
  status: ProjectStatus;
  classification: ProjectClassification;
  version: string;
  national_project_code: string | null;
}

/** What the import of a file does with one row it accepts. */
export type ImportOutcome = 'ASSIGN' | 'UNCHANGED' | 'MISMATCH';

export interface NationalCodeImportContext {
  scope: ScopeBuilder;
  actor: string;
  rule: NationalCodeRule | undefined;
  today: string;
}

/**
 * The adapter of the national project code file for the file import framework (ST-KERNEL-070): the layout and the judgement of a row are the
 * pure format of the kernel; this half reads what the register holds. A row is applied to a project the caller may touch, whose stage is not
 * an end, with a code of the format of the rule and held by no other project. A project that has another code is not overwritten: the file and the
 * register disagree, which is a difference with an owner (NATIONAL_CODE_MISMATCH), settled by hand with `assignNationalProjectCode`.
 */
export class NationalCodeImportAdapter implements FileImportAdapter<NationalCodeRow> {
  readonly connectorCode = nationalCodeFileFormat.connectorCode;
  readonly formatVersion = nationalCodeFileFormat.formatVersion;
  /** The assignments this import made, for the audit rows and the events of the command. */
  readonly assigned: AssignedNationalCode[] = [];

  private readonly store: PrjNationalCodeStore;
  private readonly context: NationalCodeImportContext;

  constructor(store: PrjNationalCodeStore, context: NationalCodeImportContext) {
    this.store = store;
    this.context = context;
  }

  parse = nationalCodeFileFormat.parse;
  judge = nationalCodeFileFormat.judge;
  mask = nationalCodeFileFormat.mask;

  private async project(tx: TenantTx, internalCode: string, lock: boolean): Promise<ProjectRow | undefined> {
    const predicate = this.context.scope(2);
    const rows = await tx.query<ProjectRow>(
      `select p.id, p.code, p.status, p.classification, p.version::text as version, p.national_project_code
         from ${SCOPE_FROM} where p.code = $1 and ${predicate.sql}${lock ? ' for update of p' : ''}`,
      [internalCode, ...predicate.params],
    );
    return rows[0];
  }

  async examine(tx: TenantTx, entry: ImportEntry<NationalCodeRow>): Promise<Rejection | undefined> {
    const project = await this.project(tx, entry.record.internalCode, false);
    // A project outside the scope of the caller is indistinguishable from one that does not exist.
    if (project === undefined) return { code: 'PROJECT_NOT_FOUND', field: 'internal_code' };
    if (FROZEN.includes(project.status)) return { code: 'PROJECT_STAGE_LOCKED', field: 'internal_code' };
    if (!hasCodeFormat(this.context.rule, entry.record.nationalCode)) return { code: 'NATIONAL_CODE_FORMAT_INVALID', field: 'national_project_code' };
    // Only a project the caller may see can hold the code against the row: a code held outside the scope is not revealed by a dry run. The apply is made
    // on the whole tenant (the command requires it), so it judges every project.
    const visible = this.context.scope(3);
    const holder = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.national_project_code = $1 and p.id <> $2::uuid and ${visible.sql}`, [entry.record.nationalCode, project.id, ...visible.params]);
    if (holder[0] !== undefined) return { code: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code' };
    return undefined;
  }

  /** What the apply would do with the row (the dry run says it): set the code, leave it as it is, or open a difference. */
  async outcomeOf(tx: TenantTx, entry: ImportEntry<NationalCodeRow>): Promise<ImportOutcome> {
    const project = await this.project(tx, entry.record.internalCode, false);
    if (project === undefined || project.national_project_code === null) return 'ASSIGN';
    return project.national_project_code === entry.record.nationalCode ? 'UNCHANGED' : 'MISMATCH';
  }

  /** Sets the code of a project that has none; a project that has the code is left alone, one that has another code is a difference. */
  async apply(tx: TenantTx, entry: ImportEntry<NationalCodeRow>, applyContext: { importId: string }): Promise<readonly Difference[]> {
    const project = await this.project(tx, entry.record.internalCode, true);
    if (project === undefined) throw new Error('a project that examine found is gone before apply');
    const code = entry.record.nationalCode;
    if (project.national_project_code === code) return [];
    if (project.national_project_code !== null) {
      return [{ code: 'NATIONAL_CODE_MISMATCH', expected: project.national_project_code, actual: code, detail: project.code }];
    }
    const version = Number(project.version) + 1;
    await this.store.setCode(tx, project.id, code, this.context.actor, version);
    this.assigned.push({
      projectId: project.id,
      code: project.code,
      classification: project.classification,
      status: project.status,
      version,
      previous: null,
      current: code,
      changed: true,
      evidenceDocumentId: null,
      via: 'IMPORT',
      importId: applyContext.importId,
    });
    return [];
  }
}

export interface CodeGateReading {
  projectId: string;
  reading: GuardReading;
}

/**
 * The one reading of the rule NATIONAL_CODE_REQUIRED for the modules that ask whether a project may go on (BLOCK or WARN, from the stage the rule
 * names, the format of the rule): the start of the implementation judges it with `nationalCodeReading`, and the publication of a capital plan asks
 * the same through this gate for the projects the plan funds (a project that becomes BUDGETED is judged as one that is going to be funded).
 */
export class NationalCodeGate {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  async assess(tx: TenantTx, projectIds: readonly string[], today: string, target: ProjectStatus = 'BUDGETED'): Promise<CodeGateReading[]> {
    if (projectIds.length === 0) return [];
    const rule = await this.rules.nationalCode(tx, today);
    const rows = await tx.query<{ id: string; national_project_code: string | null }>('select id, national_project_code from machvon.project where id = any($1::uuid[]) order by id', [[...projectIds]]);
    return rows.map((row) => ({ projectId: row.id, reading: nationalCodeReading(rule, target, row.national_project_code) }));
  }
}
