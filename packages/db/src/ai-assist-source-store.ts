import { materialKey } from '@machvon/kernel';
import type { Classification, SourceKind, SourcePart, SourceRef } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { NOT_SEALED, VERSION_JOINS } from './document-store.ts';
import { SCOPE_FROM as PROJECT_SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The records and the documents the AI assistant may read for a person (lane AI-2, AI.01, AI.07): each kind is read through the scope of the permission that reads it elsewhere (a document version, a project, a contract, an
 * approved appraisal), so what the assistant is shown, and what it may cite, is exactly what the asker could open on a screen. A source that is outside the scope, belongs to another tenant (row-level security) or does not
 * exist is the same thing here: it is not returned, and nothing says which of the three it was. The text of a document is not read here: the document module's OCR does that (the API layer fills the parts of a document).
 */

export interface AssistReadScopes {
  documents: ScopeBuilder;
  projects: ScopeBuilder;
  contracts: ScopeBuilder;
  appraisals: ScopeBuilder;
}

/** A source the asker may read: its kind, id, title and class, and the parts of a record (the parts of a document are filled in by the caller from its pages). */
export interface ReadableSource {
  kind: SourceKind;
  id: string;
  title: string;
  classification: Classification;
  parts: SourcePart[];
}

interface Sql {
  [column: string]: unknown;
}

const CLASSES: readonly string[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'];
/** The class of a record that has none, or whose label is not one the gateway knows: CONFIDENTIAL (BR-LLM-02). */
const classOf = (value: unknown, fallback: Classification = 'CONFIDENTIAL'): Classification => (typeof value === 'string' && CLASSES.includes(value) ? (value as Classification) : fallback);
const text = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const RECORD_PART_CHARS = 3000;
const MAX_FACT_PARTS = 80;

/** The fields of a record as parts: a field with a value, named as the record names it. */
const fieldParts = (record: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): SourcePart[] =>
  Object.entries(record)
    .filter(([name, value]) => !skip.has(name) && value !== null && value !== undefined && text(value) !== '')
    .slice(0, MAX_FACT_PARTS)
    .map(([name, value]) => ({ locator: `field:${name}`, text: [...text(value)].slice(0, RECORD_PART_CHARS).join('') }));

export class AiAssistSourceStore {
  /**
   * The sources among `refs` that the asker may read, in the order of `refs`. A reference of a kind the asker holds no right over is not returned, and neither is one that does not exist: the caller cannot tell which, and
   * a citation of either is refused the same way.
   */
  async readable(tx: TenantTx, refs: readonly SourceRef[], scopes: AssistReadScopes): Promise<ReadableSource[]> {
    const ids = (kind: SourceKind): string[] => refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    const found = new Map<string, ReadableSource>();
    const keep = (source: ReadableSource): void => {
      found.set(materialKey(source.kind, source.id), source);
    };
    for (const source of await this.documents(tx, ids('DOCUMENT_VERSION'), scopes.documents)) keep(source);
    for (const source of await this.projects(tx, ids('PROJECT'), scopes.projects)) keep(source);
    for (const source of await this.contracts(tx, ids('CONTRACT'), scopes.contracts)) keep(source);
    for (const source of await this.appraisals(tx, ids('APPRAISAL'), scopes.appraisals)) keep(source);
    return refs.map((ref) => found.get(materialKey(ref.kind, ref.id))).filter((source): source is ReadableSource => source !== undefined);
  }

  /** The versions of documents that are clean, not sealed, and inside the scope of the reads of versions; the class is the one of the version (the gateway reads the same). */
  private async documents(tx: TenantTx, ids: readonly string[], scope: ScopeBuilder): Promise<ReadableSource[]> {
    if (ids.length === 0) return [];
    const predicate = scope(2);
    if (predicate.sql === 'false') return [];
    const rows = await tx.query<Sql>(
      `select v.id, v.classification, d.title
         from machvon.document_version v ${VERSION_JOINS}
        where v.id = any($1::uuid[]) and v.scan_status = 'CLEAN' and ${NOT_SEALED} and ${predicate.sql}`,
      [[...ids], ...predicate.params],
    );
    return rows.map((row) => ({ kind: 'DOCUMENT_VERSION' as const, id: row.id as string, title: text(row.title), classification: classOf(row.classification), parts: [] }));
  }

  private async projects(tx: TenantTx, ids: readonly string[], scope: ScopeBuilder): Promise<ReadableSource[]> {
    if (ids.length === 0) return [];
    const predicate = scope(2);
    if (predicate.sql === 'false') return [];
    const rows = await tx.query<Sql>(
      `select p.id, p.code, p.name, p.status, p.project_group, p.classification, p.total_investment_vnd::text as total_investment_vnd, p.start_year, p.end_year, p.national_project_code,
              ou.name as owner_unit_name, iu.name as investor_unit_name
         from ${PROJECT_SCOPE_FROM}
        where p.id = any($1::uuid[]) and ${predicate.sql}`,
      [[...ids], ...predicate.params],
    );
    return rows.map((row) => ({
      kind: 'PROJECT' as const,
      id: row.id as string,
      title: `${text(row.code)} ${text(row.name)}`.trim(),
      classification: classOf(row.classification),
      parts: fieldParts({ code: row.code, name: row.name, status: row.status, project_group: row.project_group, total_investment_vnd: row.total_investment_vnd, start_year: row.start_year, end_year: row.end_year, national_project_code: row.national_project_code, owner_unit_name: row.owner_unit_name, investor_unit_name: row.investor_unit_name }),
    }));
  }

  /** A contract is read as its row of the contract fact (the figures the portfolio reads), inside the scope of `contract.read`. */
  private async contracts(tx: TenantTx, ids: readonly string[], scope: ScopeBuilder): Promise<ReadableSource[]> {
    if (ids.length === 0) return [];
    const predicate = scope(2);
    if (predicate.sql === 'false') return [];
    const rows = await tx.query<Sql>(
      `select c.id, c.code, c.title, to_jsonb(f) as fact
         from ${CONTRACT_SCOPE_FROM}
         join machvon.contract_fact f on f.tenant_id = c.tenant_id and f.id = c.id
        where c.id = any($1::uuid[]) and ${predicate.sql}`,
      [[...ids], ...predicate.params],
    );
    return rows.map((row) => {
      const fact = (row.fact ?? {}) as Record<string, unknown>;
      return {
        kind: 'CONTRACT' as const,
        id: row.id as string,
        title: `${text(row.code)} ${text(row.title)}`.trim(),
        classification: classOf(undefined),
        // The identifiers of the fact are keys of the database, not words of the contract: they are not parts a statement can rest on.
        parts: fieldParts(fact, new Set(['tenant_id', 'id', 'project_id', 'package_id', 'contractor_id', 'unit_id', 'investor_id', 'fund_source_version_id'])),
      };
    });
  }

  /** Only an approved appraisal is a source: its results are frozen and checkable, a draft is not evidence. */
  private async appraisals(tx: TenantTx, ids: readonly string[], scope: ScopeBuilder): Promise<ReadableSource[]> {
    if (ids.length === 0) return [];
    const predicate = scope(2);
    if (predicate.sql === 'false') return [];
    const rows = await tx.query<Sql>(
      `select a.id, a.code, a.revision, a.title, a.kind, a.discount_rate_pct::text as discount_rate_pct, a.frozen_results
         from machvon.investment_appraisal a
         join machvon.organization_unit ou on ou.tenant_id = a.tenant_id and ou.id = a.owner_unit_id
        where a.id = any($1::uuid[]) and a.status = 'APPROVED' and ${predicate.sql}`,
      [[...ids], ...predicate.params],
    );
    return rows.map((row) => ({
      kind: 'APPRAISAL' as const,
      id: row.id as string,
      title: `${text(row.code)} ${text(row.title)}`.trim(),
      classification: classOf(undefined),
      parts: fieldParts({ code: row.code, revision: row.revision, title: row.title, kind: row.kind, discount_rate_pct: row.discount_rate_pct, frozen_results: row.frozen_results }),
    }));
  }

  /** The contracts of a project the asker may read (at most `limit`), for a question asked about the project as a whole. */
  async contractsOfProject(tx: TenantTx, projectId: string, scope: ScopeBuilder, limit: number): Promise<string[]> {
    const predicate = scope(3);
    if (predicate.sql === 'false') return [];
    const rows = await tx.query<Sql>(`select c.id from ${CONTRACT_SCOPE_FROM} where c.project_id = $1::uuid and ${predicate.sql} order by c.code, c.id limit $2::int`, [projectId, limit, ...predicate.params]);
    return rows.map((row) => row.id as string);
  }

  /** The project of a contract the asker may read, for a question asked about the contract. */
  async projectOfContract(tx: TenantTx, contractId: string, scope: ScopeBuilder): Promise<string | undefined> {
    const predicate = scope(2);
    if (predicate.sql === 'false') return undefined;
    const rows = await tx.query<Sql>(`select c.project_id from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`, [contractId, ...predicate.params]);
    return rows[0]?.project_id as string | undefined;
  }
}
