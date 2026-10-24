import { randomUUID } from 'node:crypto';
import { DomainError, compareDecimal, versionConflict } from '@machvon/kernel';
import { boqTotal, linesHash, parseBoqLines, plainDecimal, reconciliationOf, rowErrorsProblem, totalMismatch } from './ctr-boq-lines.ts';
import type { BoqLine, BoqReconciliation, BoqRoundingRule, BoqRowError } from './ctr-boq-lines.ts';
import { SCOPE_FROM } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { tenantLookup } from './master-types.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type BoqImportMode = 'REPLACE' | 'APPEND';
export type BoqSourceKind = 'FILE' | 'LINES';

const MODES: readonly string[] = ['REPLACE', 'APPEND'];
const SHA256 = /^[0-9a-f]{64}$/;
/** The contract states in which the base revision of a contract is still the draft of its terms. */
const BASE_STATES: readonly string[] = ['DRAFT'];
/** The contract states in which a later revision (an amendment or a change order) is drafted. */
const LATER_STATES: readonly string[] = ['ACTIVE', 'SUSPENDED'];
const MAX_DUPLICATE_ROWS = 100;

/** The revision a command acts on, locked for update inside the scope of the caller. */
export interface LockedRevision {
  id: string;
  contractId: string;
  contractCode: string;
  contractStatus: string;
  isJointVenture: boolean;
  kind: string;
  status: string;
  version: number;
  amountVnd: string;
}

/** What an import gave. The figures of a repeated file are those of the first import, with `duplicate` set. */
export interface BoqImportResult {
  importId: string;
  revisionId: string;
  contractId: string;
  /** The version of the revision after the import (unchanged for a repeated file). */
  version: number;
  mode: BoqImportMode;
  sourceKind: BoqSourceKind;
  sourceSha256: string;
  linesImported: number;
  itemsCreated: number;
  /** The lines that took the default retention of the rule `CTR.RETENTION` (zero for a repeated file). */
  retentionDefaulted: number;
  /** What the lines of the revision add up to after the import, against the amount of the revision. */
  reconciliation: BoqReconciliation;
  duplicate: boolean;
}

export interface BoqImportRequest {
  mode: string;
  lines: unknown;
  /** The SHA-256 of the file the lines were read from; absent when the lines were sent as they are. */
  fileSha256?: string | undefined;
  /** Where the file is kept in the object store, for the record of the import; absent for lines sent as they are. */
  fileObjectKey?: string | undefined;
}

/** One line of a revision as the register shows it, with the revision and the contract it belongs to. */
export interface BoqLineRow {
  id: string;
  contractId: string;
  contractCode: string;
  revisionId: string;
  revision: number;
  revisionStatus: string;
  boqItemId: string;
  lineNo: number;
  businessKey: string;
  description: string;
  unitCode: string;
  /** Exact decimal strings written without trailing zeros. */
  quantity: string;
  unitPrice: string;
  roundingRule: BoqRoundingRule;
  amountVnd: string;
  retentionPct: string;
  milestoneCode: string | null;
  milestoneDueOn: string | null;
  partyId: string | null;
  partyContractorId: string | null;
  partyName: string | null;
  reach: ContractPlace;
  /** The ordering key of the list and its cursor. */
  key: string;
}

export interface BoqLineFilter {
  contractId?: string | undefined;
  revisionId?: string | undefined;
}

interface LineSql {
  id: string;
  contract_id: string;
  contract_code: string;
  revision_id: string;
  revision: number;
  revision_status: string;
  boq_item_id: string;
  line_no: number;
  business_key: string;
  description: string;
  unit_code: string;
  quantity: string;
  unit_price: string;
  rounding_rule: BoqRoundingRule;
  amount_vnd: string;
  retention_pct: string;
  milestone_code: string | null;
  milestone_due_on: string | null;
  party_id: string | null;
  party_contractor_id: string | null;
  party_name: string | null;
  project_id: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  key: string;
}

interface ImportSql {
  id: string;
  seq: number;
  mode: BoqImportMode;
  source_sha256: string;
  source_kind: BoqSourceKind;
  lines_imported: number;
  items_created: number;
}

interface ItemSql {
  id: string;
  business_key: string;
  unit_code: string;
}

const LINE_KEY = `(c.code || '#' || lpad(r.revision::text, 6, '0') || '#' || lpad(l.line_no::text, 6, '0'))`;
const LINE_FROM = `from machvon.boq_line l
  join machvon.contract_revision r on r.tenant_id = l.tenant_id and r.id = l.contract_revision_id
  join ${SCOPE_FROM} on c.tenant_id = r.tenant_id and c.id = r.contract_id`;
const LINE_COLUMNS = `l.id, l.contract_id, c.code as contract_code, l.contract_revision_id as revision_id, r.revision, r.status as revision_status, l.boq_item_id, l.line_no,
  l.business_key, l.description, l.unit_code, l.quantity::text as quantity, l.unit_price::text as unit_price, l.rounding_rule, l.amount_vnd::text as amount_vnd,
  l.retention_pct::text as retention_pct, l.milestone_code, l.milestone_due_on::text as milestone_due_on, l.party_id,
  (select m.contractor_id from machvon.contract_party m where m.tenant_id = l.tenant_id and m.id = l.party_id) as party_contractor_id,
  (select k.legal_name from machvon.contract_party m join machvon.contractor k on k.tenant_id = m.tenant_id and k.id = m.contractor_id where m.tenant_id = l.tenant_id and m.id = l.party_id) as party_name,
  p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path, ${LINE_KEY} as key`;

const toLineRow = (row: LineSql): BoqLineRow => ({
  id: row.id,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  revisionId: row.revision_id,
  revision: row.revision,
  revisionStatus: row.revision_status,
  boqItemId: row.boq_item_id,
  lineNo: row.line_no,
  businessKey: row.business_key,
  description: row.description,
  unitCode: row.unit_code,
  quantity: plainDecimal(row.quantity),
  unitPrice: plainDecimal(row.unit_price),
  roundingRule: row.rounding_rule,
  amountVnd: row.amount_vnd,
  retentionPct: row.retention_pct,
  milestoneCode: row.milestone_code,
  milestoneDueOn: row.milestone_due_on,
  partyId: row.party_id,
  partyContractorId: row.party_contractor_id,
  partyName: row.party_name,
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
  key: row.key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * The BOQ of a contract revision (ST-CTR-002, CTR 3.1 step 2): the stable items of the contract and the lines that price them in one
 * revision. An import REPLACEs the lines of a draft revision or APPENDs to them; every row is judged before one is written, the amount of
 * a line is the exact product of its quantity and unit price rounded by its rule, and the lines never add up to more than the amount of the
 * revision. The same file (by its hash) is imported once: a repeat answers the first result. A revision that was decided is not touched.
 */
export class CtrBoqStore {
  // ---- reads ---------------------------------------------------------------------------------------------------

  /** The lines in the scope of the caller, ordered by contract code, revision and line number; the cursor is the key and the id of the last line. */
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }, filter: BoqLineFilter = {}): Promise<BoqLineRow[]> {
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `select ${LINE_COLUMNS} ${LINE_FROM}
        where ($1::text is null or (${LINE_KEY}, l.id) > ($1::text, $2::uuid))
          and ($4::uuid is null or l.contract_id = $4::uuid) and ($5::uuid is null or l.contract_revision_id = $5::uuid) and ${predicate.sql}
        order by ${LINE_KEY}, l.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, filter.contractId ?? null, filter.revisionId ?? null, ...predicate.params],
    );
    return rows.map(toLineRow);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<BoqLineRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`select ${LINE_COLUMNS} ${LINE_FROM} where l.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLineRow(rows[0]);
  }

  /** What the lines of a revision add up to against the amount of the revision (BR-CTR-02); the submit for review calls it. */
  async reconcile(tx: TenantTx, revisionId: string): Promise<BoqReconciliation> {
    const rows = await tx.query<{ amount_vnd: string; total_vnd: string; line_count: number }>(
      `select r.amount_vnd::text as amount_vnd,
              (select coalesce(sum(l.amount_vnd), 0)::text from machvon.boq_line l where l.tenant_id = r.tenant_id and l.contract_revision_id = r.id) as total_vnd,
              (select count(*)::int from machvon.boq_line l where l.tenant_id = r.tenant_id and l.contract_revision_id = r.id) as line_count
         from machvon.contract_revision r where r.id = $1::uuid`,
      [revisionId],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reconciliationOf(row.amount_vnd, row.total_vnd, row.line_count);
  }

  /** 422 BOQ_TOTAL_MISMATCH unless the lines add up to the amount of the revision with a difference of zero (and there is at least one line). */
  async assertBalanced(tx: TenantTx, revisionId: string): Promise<BoqReconciliation> {
    const reconciliation = await this.reconcile(tx, revisionId);
    if (!reconciliation.matches || reconciliation.lineCount === 0) throw totalMismatch(reconciliation);
    return reconciliation;
  }

  // ---- the import -------------------------------------------------------------------------------------------------------

  /**
   * Imports the lines into a draft revision. The revision is locked, its version must be the one the caller saw, and it must still be the
   * draft of its terms. Every row is judged (shape, unit in master data, member of the venture, unit of an item that already exists) and the
   * faults of all the rows are answered together; then the lines are written, the items that did not exist are created, the items left
   * without a line by a REPLACE are cancelled, and the import is recorded.
   */
  async importLines(tx: TenantTx, revisionId: string, expectedVersion: number, request: BoqImportRequest, actor: string, scopes: ContractScopes): Promise<BoqImportResult> {
    const revision = await this.lockRevision(tx, revisionId, scopes);
    if (revision.version !== expectedVersion) throw versionConflict(revision.version);
    if (revision.status !== 'DRAFT') throw new DomainError('REVISION_NOT_DRAFT', 422);
    if (!(revision.kind === 'BASE' ? BASE_STATES : LATER_STATES).includes(revision.contractStatus)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    if (!MODES.includes(request.mode)) throw invalid('mode');
    const mode = request.mode as BoqImportMode;
    if (request.fileSha256 !== undefined && !SHA256.test(request.fileSha256)) throw invalid('file_sha256');
    const parsed = parseBoqLines(request.lines);
    if (parsed.errorRows > 0) throw rowErrorsProblem(parsed);
    const sourceKind: BoqSourceKind = request.fileSha256 === undefined ? 'LINES' : 'FILE';
    const sourceSha256 = request.fileSha256 ?? linesHash(parsed.lines);

    const earlier = await this.importInForce(tx, revisionId, mode, sourceSha256);
    if (earlier !== undefined) return this.resultOf(tx, revision, earlier, revision.version, true, 0);

    const parties = await this.partiesByContractor(tx, revision.contractId);
    const faults = await this.contextFaults(tx, revision, parsed.lines, parties);
    if (faults.length > 0) throw rowErrorsProblem({ errors: faults.slice(0, 100), errorRows: new Set(faults.map((fault) => fault.row)).size });

    const kept = mode === 'APPEND' ? await this.currentLines(tx, revisionId) : { keys: new Set<string>(), total: '0', lastNo: 0, count: 0 };
    const clashes = parsed.lines.flatMap((line, index) => (kept.keys.has(line.businessKey) ? [index + 1] : []));
    if (clashes.length > 0) throw new DomainError('BOQ_LINE_DUPLICATE', 409, 'lines', { extensions: { rows: clashes.slice(0, MAX_DUPLICATE_ROWS) } });
    const total = boqTotal([kept.total, ...parsed.lines.map((line) => line.amountVnd)]);
    // A BOQ that is short of the value can still be completed by another pass; one that is above it cannot, so it is refused when it is written.
    if (compareDecimal(total, revision.amountVnd) > 0) throw totalMismatch(reconciliationOf(revision.amountVnd, total, kept.count + parsed.lines.length));

    if (mode === 'REPLACE') await tx.query('delete from machvon.boq_line where contract_revision_id = $1::uuid', [revisionId]);
    const itemsCreated = await this.ensureItems(tx, revision.contractId, parsed.lines, actor);
    await this.insertLines(tx, revision, parsed.lines, kept.lastNo, parties, actor);
    if (mode === 'REPLACE') await this.cancelOrphanItems(tx, revision.contractId, actor);
    const version = revision.version + 1;
    await tx.query('update machvon.contract_revision set updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid', [revisionId, actor, version]);
    const recorded = await this.recordImport(tx, revision, {
      mode,
      sourceSha256,
      sourceKind,
      objectKey: sourceKind === 'FILE' ? (request.fileObjectKey ?? null) : null,
      linesImported: parsed.lines.length,
      itemsCreated,
      linesTotal: total,
      actor,
    });
    const defaulted = parsed.lines.filter((line) => line.retentionDefaulted).length;
    return this.resultOf(tx, revision, recorded, version, false, defaulted);
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  /** Locks the revision for update inside the scope of the caller; one the caller can read but not change is a refusal, not a miss. */
  async lockRevision(tx: TenantTx, revisionId: string, scopes: ContractScopes): Promise<LockedRevision> {
    const predicate = scopes.update(2);
    const rows = await tx.query<{
      contract_id: string;
      contract_code: string;
      contract_status: string;
      is_joint_venture: boolean;
      kind: string;
      status: string;
      version: string;
      amount_vnd: string;
    }>(
      `select r.contract_id, c.code as contract_code, c.status as contract_status, c.is_joint_venture, r.kind, r.status, r.version::text as version, r.amount_vnd::text as amount_vnd
         from machvon.contract_revision r
         join ${SCOPE_FROM} on c.tenant_id = r.tenant_id and c.id = r.contract_id
        where r.id = $1::uuid and ${predicate.sql}
        for update of r`,
      [revisionId, ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query<{ id: string }>(
        `select r.id from machvon.contract_revision r join ${SCOPE_FROM} on c.tenant_id = r.tenant_id and c.id = r.contract_id where r.id = $1::uuid and ${readable.sql}`,
        [revisionId, ...readable.params],
      );
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    return {
      id: revisionId,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      contractStatus: row.contract_status,
      isJointVenture: row.is_joint_venture,
      kind: row.kind,
      status: row.status,
      version: Number(row.version),
      amountVnd: row.amount_vnd,
    };
  }

  /**
   * The import of the same file that is still in force: for an APPEND, any import of that hash since the last REPLACE (the lines are there);
   * for a REPLACE, only the latest import when it is a REPLACE of that hash (nothing changed since, so there is nothing to put back).
   */
  private async importInForce(tx: TenantTx, revisionId: string, mode: BoqImportMode, sha256: string): Promise<ImportSql | undefined> {
    const columns = 'id, seq, mode, source_sha256, source_kind, lines_imported, items_created';
    if (mode === 'REPLACE') {
      const latest = await tx.query<ImportSql>(`select ${columns} from machvon.boq_import where contract_revision_id = $1::uuid order by seq desc limit 1`, [revisionId]);
      const row = latest[0];
      return row !== undefined && row.mode === 'REPLACE' && row.source_sha256 === sha256 ? row : undefined;
    }
    const rows = await tx.query<ImportSql>(
      `select ${columns} from machvon.boq_import
        where contract_revision_id = $1::uuid and source_sha256 = $2
          and seq >= coalesce((select max(seq) from machvon.boq_import where contract_revision_id = $1::uuid and mode = 'REPLACE'), 0)
        order by seq limit 1`,
      [revisionId, sha256],
    );
    return rows[0];
  }

  private async resultOf(tx: TenantTx, revision: LockedRevision, row: ImportSql, version: number, duplicate: boolean, retentionDefaulted: number): Promise<BoqImportResult> {
    return {
      importId: row.id,
      revisionId: revision.id,
      contractId: revision.contractId,
      version,
      mode: row.mode,
      sourceKind: row.source_kind,
      sourceSha256: row.source_sha256,
      linesImported: row.lines_imported,
      itemsCreated: row.items_created,
      retentionDefaulted,
      reconciliation: await this.reconcile(tx, revision.id),
      duplicate,
    };
  }

  private async partiesByContractor(tx: TenantTx, contractId: string): Promise<Map<string, string>> {
    const rows = await tx.query<{ id: string; contractor_id: string }>(`select id, contractor_id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'`, [contractId]);
    return new Map(rows.map((row) => [row.contractor_id, row.id]));
  }

  /**
   * The faults that need the database: a unit that master data does not know, a unit that differs from the one of an item that other
   * revisions already price, a member that is not on the contract.
   */
  private async contextFaults(tx: TenantTx, revision: LockedRevision, lines: readonly BoqLine[], parties: ReadonlyMap<string, string>): Promise<BoqRowError[]> {
    const faults: BoqRowError[] = [];
    const lookup = tenantLookup(tx);
    const known = new Map<string, boolean>();
    for (const code of new Set(lines.map((line) => line.unitCode))) known.set(code, (await lookup.entry('UNIT', code)) !== undefined);
    const priced = await tx.query<ItemSql>(
      `select i.id, i.business_key, i.unit_code from machvon.boq_item i
        where i.contract_id = $1::uuid and i.business_key = any($2::text[])
          and exists (select 1 from machvon.boq_line l where l.tenant_id = i.tenant_id and l.boq_item_id = i.id and l.contract_revision_id <> $3::uuid)`,
      [revision.contractId, lines.map((line) => line.businessKey), revision.id],
    );
    const unitOfItem = new Map(priced.map((item) => [item.business_key, item.unit_code]));
    lines.forEach((line, index) => {
      const row = index + 1;
      if (known.get(line.unitCode) !== true) faults.push({ row, field: 'unit_code', reason: 'unitUnknown' });
      else if (unitOfItem.has(line.businessKey) && unitOfItem.get(line.businessKey) !== line.unitCode) faults.push({ row, field: 'unit_code', reason: 'unitChanged' });
      if (line.partyContractorId !== null && !parties.has(line.partyContractorId)) faults.push({ row, field: 'party_contractor_id', reason: 'partyUnknown' });
    });
    return faults;
  }

  private async currentLines(tx: TenantTx, revisionId: string): Promise<{ keys: Set<string>; total: string; lastNo: number; count: number }> {
    const rows = await tx.query<{ business_key: string; amount_vnd: string; line_no: number }>('select business_key, amount_vnd::text as amount_vnd, line_no from machvon.boq_line where contract_revision_id = $1::uuid', [revisionId]);
    return {
      keys: new Set(rows.map((row) => row.business_key)),
      total: boqTotal(rows.map((row) => row.amount_vnd)),
      lastNo: rows.reduce((last, row) => Math.max(last, row.line_no), 0),
      count: rows.length,
    };
  }

  /**
   * Creates the items the contract does not have yet and returns how many were created. An item that exists is kept as it is; one that no
   * line prices (a draft being put right, or a cancelled item) takes the unit and the wording of the line and is active again.
   */
  private async ensureItems(tx: TenantTx, contractId: string, lines: readonly BoqLine[], actor: string): Promise<number> {
    const rows = await tx.query<{ inserted: boolean }>(
      `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
       select ${TENANT}, gen_random_uuid(), $1::uuid, t.business_key, t.description, t.unit_code, $4::uuid, $4::uuid
         from unnest($2::text[], $3::text[], $5::text[]) as t (business_key, description, unit_code)
       on conflict (tenant_id, contract_id, business_key) do update
         set description = excluded.description, unit_code = excluded.unit_code, status = 'ACTIVE', updated_at = now(), updated_by = excluded.updated_by,
             version = machvon.boq_item.version + 1
        where machvon.boq_item.status = 'CANCELLED'
           or (not exists (select 1 from machvon.boq_line l where l.tenant_id = machvon.boq_item.tenant_id and l.boq_item_id = machvon.boq_item.id)
               and (machvon.boq_item.description, machvon.boq_item.unit_code) is distinct from (excluded.description, excluded.unit_code))
       returning (xmax = 0) as inserted`,
      [contractId, lines.map((line) => line.businessKey), lines.map((line) => line.description), actor, lines.map((line) => line.unitCode)],
    );
    return rows.filter((row) => row.inserted).length;
  }

  private async insertLines(tx: TenantTx, revision: LockedRevision, lines: readonly BoqLine[], lastNo: number, parties: ReadonlyMap<string, string>, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.boq_line
         (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd,
          retention_pct, milestone_code, milestone_due_on, party_id, created_by)
       select ${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, i.id, t.line_no, t.business_key, t.description, t.unit_code, t.quantity::numeric, t.unit_price::numeric, t.rounding_rule,
              t.amount_vnd::numeric, t.retention_pct::numeric, t.milestone_code, t.milestone_due_on::date, t.party_id, $3::uuid
         from unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::uuid[])
              as t (line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, milestone_code, milestone_due_on, party_id)
         join machvon.boq_item i on i.tenant_id = ${TENANT} and i.contract_id = $2::uuid and i.business_key = t.business_key`,
      [
        revision.id,
        revision.contractId,
        actor,
        lines.map((_line, index) => lastNo + index + 1),
        lines.map((line) => line.businessKey),
        lines.map((line) => line.description),
        lines.map((line) => line.unitCode),
        lines.map((line) => line.quantity),
        lines.map((line) => line.unitPrice),
        lines.map((line) => line.roundingRule),
        lines.map((line) => line.amountVnd),
        lines.map((line) => line.retentionPct),
        lines.map((line) => line.milestoneCode),
        lines.map((line) => line.milestoneDueOn),
        lines.map((line) => (line.partyContractorId === null ? null : (parties.get(line.partyContractorId) ?? null))),
      ],
    );
  }

  /** An item that no revision prices any more is cancelled, never deleted: the ledgers that name an item stay whole. */
  private async cancelOrphanItems(tx: TenantTx, contractId: string, actor: string): Promise<void> {
    await tx.query(
      `update machvon.boq_item i set status = 'CANCELLED', updated_at = now(), updated_by = $2::uuid, version = version + 1
        where i.contract_id = $1::uuid and i.status = 'ACTIVE'
          and not exists (select 1 from machvon.boq_line l where l.tenant_id = i.tenant_id and l.boq_item_id = i.id)`,
      [contractId, actor],
    );
  }

  private async recordImport(
    tx: TenantTx,
    revision: LockedRevision,
    entry: { mode: BoqImportMode; sourceSha256: string; sourceKind: BoqSourceKind; objectKey: string | null; linesImported: number; itemsCreated: number; linesTotal: string; actor: string },
  ): Promise<ImportSql> {
    const rows = await tx.query<ImportSql>(
      `insert into machvon.boq_import
         (tenant_id, id, contract_id, contract_revision_id, seq, mode, source_sha256, source_kind, source_object_key, lines_imported, items_created, lines_total_vnd, created_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid,
               coalesce((select max(seq) from machvon.boq_import where contract_revision_id = $3::uuid), 0) + 1, $4, $5, $6, $11, $7::int, $8::int, $9::numeric, $10::uuid)
       returning id, seq, mode, source_sha256, source_kind, lines_imported, items_created`,
      [randomUUID(), revision.contractId, revision.id, entry.mode, entry.sourceSha256, entry.sourceKind, entry.linesImported, entry.itemsCreated, entry.linesTotal, entry.actor, entry.objectKey],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the import was not recorded');
    return row;
  }
}
