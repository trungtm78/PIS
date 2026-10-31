import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { DgvDatasetStore } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The binding of glossary terms to datasets (ST-DGV-007, DGV 3.1, DGV-02). DGV holds no table of terms: a binding points at one revision of a term of MDM, which must be PUBLISHED when it is bound. When a newer
 * revision is published the one bound is DEPRECATED by MDM, and the read says so and offers the revision in force; binding that revision replaces the old binding for the column, which stays in the history.
 */
export const GLOSSARY_BINDING_RESOURCE = 'dataset_glossary_binding';

export interface BindRequest {
  datasetId: string;
  viewer: DatasetViewer;
  termId: string;
  columnName: string | undefined;
  actor: string;
}

export interface BoundTerm {
  bindingId: string;
  datasetId: string;
  datasetCode: string;
  termId: string;
  termCode: string;
  revision: number;
  columnName: string | null;
  /** The term was already bound to the dataset or the column: nothing was written. */
  existing: boolean;
}

export interface GlossaryBindingLine {
  id: string;
  columnName: string | null;
  term: { id: string; termCode: string; termVi: string; definition: string; revision: number; status: string };
  boundBy: { membershipId: string; displayName: string | null };
  boundAt: string;
  /** The revision bound is no longer in force. */
  deprecated: boolean;
  /** The revision of the same term that is in force now, when the one bound is not. */
  successor: { id: string; revision: number } | null;
  /** A newer binding of the same term on the same column took its place: this one is history. */
  replaced: boolean;
}

export interface GlossaryCoverage {
  /** The bindings in force: one per column and term, the latest. */
  bound: number;
  /** Of those, the ones whose revision is deprecated. */
  deprecated: number;
  /** The terms, by code, that the dataset is bound to. */
  terms: number;
}

interface TermSql {
  id: string;
  term_code: string;
  revision: number;
  status: string;
}

interface LineSql {
  id: string;
  column_name: string | null;
  bound_at: string;
  bound_by: string;
  bound_name: string | null;
  term_id: string;
  term_code: string;
  term_vi: string;
  definition: string;
  revision: number;
  status: string;
  successor_id: string | null;
  successor_revision: number | null;
  replaced: boolean;
}

export class DgvGlossaryStore {
  private readonly datasets = new DgvDatasetStore();

  /**
   * Binds a revision of a term to a dataset or to one of its columns. The dataset must be visible to the caller (404 otherwise), the term must exist (422 on `glossary_term_id`) and be PUBLISHED (422
   * `GLOSSARY_TERM_NOT_PUBLISHED`). Binding what is already bound writes nothing and answers the binding that stands. The term is read under a share lock, so a publication that deprecates it waits for this transaction (or is seen by it).
   */
  async bind(tx: TenantTx, request: BindRequest): Promise<BoundTerm> {
    const dataset = await this.datasets.find(tx, request.datasetId, request.viewer);
    if (dataset === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const terms = await tx.query<TermSql>('select id, term_code, revision, status from machvon.glossary_term where id = $1::uuid for share', [request.termId]);
    const term = terms[0];
    if (term === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'glossary_term_id');
    if (term.status !== 'PUBLISHED') throw new DomainError('GLOSSARY_TERM_NOT_PUBLISHED', 422, 'glossary_term_id', { extensions: { status: term.status } });
    const column = request.columnName === undefined ? null : request.columnName.trim();
    if (column !== null && (column.length < 1 || column.length > 120)) throw new DomainError('VALIDATION_FAILED', 422, 'column_name');
    const bound = { datasetId: dataset.id, datasetCode: dataset.datasetCode, termId: term.id, termCode: term.term_code, revision: term.revision, columnName: column };
    // Two callers binding the same thing at once: the insert that loses writes nothing and answers the binding that won.
    const written = await tx.query<{ id: string }>(
      `insert into machvon.dataset_glossary_binding (tenant_id, id, dataset_id, column_name, glossary_term_id, bound_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)
       on conflict (tenant_id, dataset_id, glossary_term_id, (coalesce(column_name, ''))) do nothing returning id`,
      [randomUUID(), dataset.id, column, term.id, request.actor],
    );
    if (written[0] !== undefined) return { ...bound, bindingId: written[0].id, existing: false };
    const held = await tx.query<{ id: string }>(
      "select id from machvon.dataset_glossary_binding where dataset_id = $1::uuid and glossary_term_id = $2::uuid and coalesce(column_name, '') = coalesce($3::text, '')",
      [dataset.id, term.id, column],
    );
    return { ...bound, bindingId: held[0]?.id ?? '', existing: true };
  }

  /**
   * The bindings of a dataset the caller may see, the latest first, with the term as it stands now. A binding whose revision was deprecated says so and names the revision in force. Several bindings of one term on
   * one column are history but the one of the newest revision (the clock of the transaction does not decide: a binding made while a publication was waiting can carry an earlier time than the binding it replaces). A dataset out of sight is not found.
   */
  async list(tx: TenantTx, datasetId: string, viewer: DatasetViewer): Promise<{ lines: GlossaryBindingLine[]; coverage: GlossaryCoverage }> {
    const dataset = await this.datasets.find(tx, datasetId, viewer);
    if (dataset === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const rows = await tx.query<LineSql>(
      `select b.id, b.column_name, to_char(b.bound_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at, b.bound_by, d.display_name as bound_name,
              t.id as term_id, t.term_code, t.term_vi, t.definition, t.revision, t.status,
              s.id as successor_id, s.revision as successor_revision,
              (row_number() over (partition by coalesce(b.column_name, ''), t.term_code order by t.revision desc, b.bound_at desc, b.id desc) > 1) as replaced
         from machvon.dataset_glossary_binding b
         join machvon.glossary_term t on t.tenant_id = b.tenant_id and t.id = b.glossary_term_id
         left join machvon.glossary_term s on s.tenant_id = t.tenant_id and s.term_code = t.term_code and s.status = 'PUBLISHED' and t.status <> 'PUBLISHED'
         left join machvon.tenant_user_directory d on d.tenant_id = b.tenant_id and d.membership_id = b.bound_by
        where b.dataset_id = $1::uuid
        order by b.bound_at desc, b.id desc`,
      [dataset.id],
    );
    const lines = rows.map((row) => ({
      id: row.id,
      columnName: row.column_name,
      term: { id: row.term_id, termCode: row.term_code, termVi: row.term_vi, definition: row.definition, revision: row.revision, status: row.status },
      boundBy: { membershipId: row.bound_by, displayName: row.bound_name },
      boundAt: row.bound_at,
      deprecated: row.status === 'DEPRECATED',
      successor: row.successor_id === null || row.successor_revision === null ? null : { id: row.successor_id, revision: row.successor_revision },
      replaced: row.replaced,
    }));
    const current = lines.filter((line) => !line.replaced);
    return { lines, coverage: { bound: current.length, deprecated: current.filter((line) => line.deprecated).length, terms: new Set(current.map((line) => line.term.termCode)).size } };
  }
}
