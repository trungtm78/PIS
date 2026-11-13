import { DomainError, buildSymbol, versionConflict, vietnamDateOf, vietnamYearOf } from '@machvon/kernel';
import type { SymbolParts } from '@machvon/kernel';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type RegisterDirection = 'OUTGOING' | 'INCOMING';
export type RegisterMode = 'MANAGED' | 'MIRRORED';
export type RegisterStatus = 'OPEN' | 'CLOSED';

const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const LOCK_NOT_AVAILABLE = '55P03';
const UNIQUE_VIOLATION = '23505';

export interface NumberRegisterStoreOptions {
  /** How long an allocation waits for the register row (BR-DOC-04: 3 s). */
  lockTimeoutMs?: number;
}

export interface NewRegister {
  registerCode: string;
  name: string;
  direction: RegisterDirection;
  organizationUnitId: string;
  year: number;
  mode: RegisterMode;
  scopeDocTypes: readonly string[];
  actor: string;
}

export interface RegisterRecord {
  id: string;
  registerCode: string;
  name: string;
  direction: RegisterDirection;
  organizationUnitId: string;
  year: number;
  mode: RegisterMode;
  lastNumber: number;
  status: RegisterStatus;
  closedAt: Date | null;
  scopeDocTypes: string[];
  version: number;
}

export interface RegisterPageAnchor {
  code: string;
  id: string;
}

export interface RegisterPage {
  year?: number | undefined;
  direction?: RegisterDirection | undefined;
  status?: 'OPEN' | 'CLOSED' | undefined;
  limit: number;
  after?: RegisterPageAnchor | undefined;
}

export interface AllocateInput {
  registerId: string;
  documentId: string;
  /** The instant of issue: its calendar date in Asia/Ho_Chi_Minh is the issue date and its year must be the register year. */
  issuedAt: Date;
  symbolPattern: string;
  parts: Omit<SymbolParts, 'number'>;
  allocatedBy: string;
}

export interface ExternalNumberInput {
  registerId: string;
  documentId: string;
  /** The number the other system gave, and the symbol and the date of issue written on the document. */
  number: number;
  symbol: string;
  issuedOn: string;
  allocatedBy: string;
}

export interface AllocationResult {
  allocationId: string;
  number: number;
  symbol: string;
  issuedOn: string;
  registerVersion: number;
}

export interface VoidInput {
  reason: string;
  voidedBy: string;
  approvedBy: string;
}

export interface RegisterEntry {
  allocationId: string;
  number: number;
  symbol: string;
  documentId: string;
  issuedOn: string;
  /** The summary (trích yếu) of the numbered document; null for an allocation read without its document. */
  title: string | null;
  /** RECALLED is the ledger's word for a number whose document was recalled: the allocation stays ALLOCATED, the number is never freed (BR-DOC-21). */
  status: 'ALLOCATED' | 'VOIDED' | 'RECALLED';
}

export interface EntryPage {
  limit: number;
  afterNumber?: number | undefined;
}

interface RegisterRow {
  id: string;
  register_code: string;
  name: string;
  direction: RegisterDirection;
  organization_unit_id: string;
  year: number;
  mode: RegisterMode;
  last_number: number;
  status: RegisterStatus;
  closed_at: Date | null;
  scope_policy: { doc_types?: string[] } | null;
  version: string;
}

interface EntryRow {
  id: string;
  number: number;
  symbol: string;
  document_id: string;
  issued_on: string;
  title?: string | null;
  status: 'ALLOCATED' | 'VOIDED' | 'RECALLED';
}

const REGISTER_COLUMNS = `id, register_code, name, direction, organization_unit_id, year, mode, last_number, status, closed_at, scope_policy,
  version::text as version`;

/** The columns of the organisation unit that scope predicates for registers are compiled against. */
export const REGISTER_SCOPE_COLUMNS = { unitPath: 'ou.path', unitId: 'ou.id' } as const;
// A register is in scope when its organisation unit is: the predicate runs over the units, the register columns stay unqualified.
const IN_SCOPE = (predicate: string): string => `organization_unit_id in (select ou.id from machvon.organization_unit ou where ${predicate})`;

function toRegister(row: RegisterRow): RegisterRecord {
  return {
    id: row.id,
    registerCode: row.register_code,
    name: row.name,
    direction: row.direction,
    organizationUnitId: row.organization_unit_id,
    year: row.year,
    mode: row.mode,
    lastNumber: row.last_number,
    status: row.status,
    closedAt: row.closed_at,
    scopeDocTypes: row.scope_policy?.doc_types ?? [],
    version: Number(row.version),
  };
}

function toEntry(row: EntryRow): RegisterEntry {
  return { allocationId: row.id, number: row.number, symbol: row.symbol, documentId: row.document_id, issuedOn: row.issued_on, title: row.title ?? null, status: row.status };
}

function notFound(): DomainError {
  return new DomainError('RESOURCE_NOT_FOUND', 404);
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE;
}

/**
 * The number registers of ST-DOC-002 (BR-DOC-02 to BR-DOC-06). A number is handed out under a row lock on the register
 * in the transaction of the caller, so a failure anywhere rolls the counter back and the numbers stay gap-free.
 */
export class NumberRegisterStore {
  private readonly lockTimeoutMs: number;

  constructor(options: NumberRegisterStoreOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async openRegister(tx: TenantTx, input: NewRegister): Promise<RegisterRecord> {
    const [unit] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [input.organizationUnitId]);
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'organization_unit_id');
    const [row] = await tx.query<RegisterRow>(
      `insert into machvon.document_number_register
         (tenant_id, id, register_code, name, direction, organization_unit_id, year, mode, scope_policy, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8::uuid, $8::uuid)
       on conflict (tenant_id, register_code, organization_unit_id, year) do nothing
       returning ${REGISTER_COLUMNS}`,
      [input.registerCode, input.name, input.direction, input.organizationUnitId, input.year, input.mode, JSON.stringify({ doc_types: input.scopeDocTypes }), input.actor],
    );
    if (row === undefined) throw new DomainError('REGISTER_ALREADY_EXISTS', 409, 'register_code');
    return toRegister(row);
  }

  /** The id and path of an organisation unit of the tenant: what a scope check of the caller needs. */
  async unitRef(tx: TenantTx, unitId: string): Promise<{ id: string; path: string } | undefined> {
    const [row] = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [unitId]);
    return row;
  }

  /** One register; `scope` (compiled over `REGISTER_SCOPE_COLUMNS`) narrows it to what the caller may see. */
  async findRegister(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<RegisterRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<RegisterRow>(
      `select ${REGISTER_COLUMNS} from machvon.document_number_register where id = $1::uuid and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}`,
      [id, ...(predicate?.params ?? [])],
    );
    return row === undefined ? undefined : toRegister(row);
  }

  /** Registers by code, in keyset pages of the code and the id. */
  async listRegisters(tx: TenantTx, page: RegisterPage, scope?: ScopeBuilder): Promise<RegisterRecord[]> {
    const predicate = scope?.(7);
    const rows = await tx.query<RegisterRow>(
      `select ${REGISTER_COLUMNS} from machvon.document_number_register
        where ($1::int is null or year = $1) and ($2::text is null or direction = $2) and ($6::text is null or status = $6)
          and ($3::text is null or (register_code, id) > ($3, $4::uuid)) and ${predicate === undefined ? 'true' : IN_SCOPE(predicate.sql)}
        order by register_code, id limit $5`,
      [page.year ?? null, page.direction ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, page.status ?? null, ...(predicate?.params ?? [])],
    );
    return rows.map(toRegister);
  }

  /**
   * Closes a register for good (BR-DOC-02): it needs the current version, an open register and no outgoing document of
   * the register that is numbered but not yet issued. The reason stays with the register.
   */
  async closeRegister(tx: TenantTx, id: string, input: { expectedVersion: number; reason: string; actor: string }): Promise<RegisterRecord> {
    const [current] = await tx.query<RegisterRow>(`select ${REGISTER_COLUMNS} from machvon.document_number_register where id = $1::uuid for update`, [id]);
    if (current === undefined) throw notFound();
    if (Number(current.version) !== input.expectedVersion) throw versionConflict(Number(current.version));
    if (current.status !== 'OPEN') throw new DomainError('REGISTER_NOT_OPEN', 409);
    const [pending] = await tx.query<{ id: string }>("select id from machvon.outgoing_document where register_id = $1::uuid and status = 'NUMBERED' limit 1", [id]);
    if (pending !== undefined) throw new DomainError('REGISTER_HAS_OPEN_NUMBERED_DOCUMENTS', 409);
    const [closed] = await tx.query<RegisterRow>(
      `update machvon.document_number_register
          set status = 'CLOSED', closed_at = now(), scope_policy = scope_policy || jsonb_build_object('closed_reason', $2::text),
              updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid returning ${REGISTER_COLUMNS}`,
      [id, input.reason, input.actor],
    );
    if (closed === undefined) throw new Error('register vanished while it was locked');
    return toRegister(closed);
  }

  /**
   * BR-DOC-04: SELECT FOR UPDATE on the register, number = last_number + 1, allocation row and document in one
   * transaction. BR-DOC-02: the register must be the one of the year of the issue date in Asia/Ho_Chi_Minh.
   */
  async allocateNumber(tx: TenantTx, input: AllocateInput): Promise<AllocationResult> {
    await tx.query("select set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
    const register = await this.lockRegister(tx, input.registerId);
    if (register.status !== 'OPEN') throw new DomainError('REGISTER_NOT_OPEN', 409);
    if (register.mode !== 'MANAGED') throw new DomainError('REGISTER_MODE_MISMATCH', 409);
    if (register.year !== vietnamYearOf(input.issuedAt)) throw new DomainError('REGISTER_YEAR_MISMATCH', 409, 'issued_on');
    const [document] = await tx.query<{ doc_kind: string }>('select doc_kind from machvon.document where id = $1::uuid for update', [input.documentId]);
    if (document === undefined) throw notFound();
    if (document.doc_kind !== register.direction) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'doc_kind');
    const [numbered] = await tx.query<{ id: string }>("select id from machvon.document_number_allocation where document_id = $1::uuid and status = 'ALLOCATED'", [input.documentId]);
    if (numbered !== undefined) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'document_number');
    const number = register.last_number + 1;
    const symbol = buildSymbol(input.symbolPattern, { ...input.parts, number });
    const issuedOn = vietnamDateOf(input.issuedAt);
    const [bumped] = await tx.query<{ version: string }>(
      'update machvon.document_number_register set last_number = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
      [register.id, number, input.allocatedBy],
    );
    const [allocation] = await tx.query<{ id: string }>(
      `insert into machvon.document_number_allocation (tenant_id, id, register_id, number, symbol, document_id, issued_on, allocated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::date, $6::uuid)
       returning id`,
      [register.id, number, symbol, input.documentId, issuedOn, input.allocatedBy],
    );
    if (allocation === undefined || bumped === undefined) throw new Error('number allocation returned no row');
    await this.claimSymbol(tx, input.documentId, { number, year: register.year, symbol, issuedOn, actor: input.allocatedBy });
    return { allocationId: allocation.id, number, symbol, issuedOn, registerVersion: Number(bumped.version) };
  }

  /**
   * DOC.md F5 (b): a document that was signed and numbered in another system is entered in the register as it was numbered. A MANAGED register is the
   * source of its numbers, so the declared number must be the next one; a MIRRORED register copies the numbers of the other system, so the number only
   * has to be free (a number that is taken, voided ones included, is 409 NUMBER_ALREADY_REGISTERED) and the counter becomes the larger of the two.
   */
  async registerExternal(tx: TenantTx, input: ExternalNumberInput): Promise<AllocationResult> {
    await tx.query("select set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
    const register = await this.lockRegister(tx, input.registerId);
    if (register.status !== 'OPEN') throw new DomainError('REGISTER_NOT_OPEN', 409);
    if (register.year !== Number(input.issuedOn.slice(0, 4))) throw new DomainError('REGISTER_YEAR_MISMATCH', 409, 'declared_issued_on');
    const [document] = await tx.query<{ doc_kind: string }>('select doc_kind from machvon.document where id = $1::uuid for update', [input.documentId]);
    if (document === undefined) throw notFound();
    if (document.doc_kind !== register.direction) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'doc_kind');
    if (register.mode === 'MANAGED' && input.number !== register.last_number + 1) throw new DomainError('REGISTER_MODE_MISMATCH', 409, 'declared_number');
    const [taken] = await tx.query<{ id: string }>('select id from machvon.document_number_allocation where register_id = $1::uuid and number = $2', [register.id, input.number]);
    if (taken !== undefined) throw new DomainError('NUMBER_ALREADY_REGISTERED', 409, 'declared_number');
    const counter = Math.max(register.last_number, input.number);
    const [bumped] = await tx.query<{ version: string }>(
      'update machvon.document_number_register set last_number = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
      [register.id, counter, input.allocatedBy],
    );
    let allocation: { id: string } | undefined;
    await tx.query('savepoint external_number');
    try {
      [allocation] = await tx.query<{ id: string }>(
        `insert into machvon.document_number_allocation (tenant_id, id, register_id, number, symbol, document_id, issued_on, allocated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::date, $6::uuid)
         returning id`,
        [register.id, input.number, input.symbol, input.documentId, input.issuedOn, input.allocatedBy],
      );
      await tx.query(
        `update machvon.document set document_number = $2, number_year = $3, symbol = $4, issued_on = $5::date, updated_at = now(), updated_by = $6::uuid, version = version + 1
          where id = $1::uuid`,
        [input.documentId, input.number, register.year, input.symbol, input.issuedOn, input.allocatedBy],
      );
      await tx.query('release savepoint external_number');
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== UNIQUE_VIOLATION) throw error;
      // The same number or the same symbol came in under a race: the first one to commit holds it.
      await tx.query('rollback to savepoint external_number');
      throw new DomainError('NUMBER_ALREADY_REGISTERED', 409, 'declared_number');
    }
    if (allocation === undefined || bumped === undefined) throw new Error('external number registration returned no row');
    return { allocationId: allocation.id, number: input.number, symbol: input.symbol, issuedOn: input.issuedOn, registerVersion: Number(bumped.version) };
  }

  /**
   * BR-DOC-03: a number is never deleted or reused; the approved void marks it VOIDED with a reason and a second person.
   * The document gives up the number when it is still pending.
   */
  async voidAllocation(tx: TenantTx, allocationId: string, input: VoidInput): Promise<RegisterEntry> {
    const [current] = await tx.query<EntryRow & { allocated_by: string }>(
      `select id, number, symbol, document_id, issued_on::text as issued_on, status, allocated_by
         from machvon.document_number_allocation where id = $1::uuid for update`,
      [allocationId],
    );
    if (current === undefined) throw notFound();
    if (input.approvedBy === input.voidedBy || input.approvedBy === current.allocated_by) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approved_by');
    if (current.status !== 'ALLOCATED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'allocation');
    await tx.query(
      `update machvon.document_number_allocation
          set status = 'VOIDED', voided_at = now(), voided_by = $2::uuid, void_reason = $3, void_approved_by = $4::uuid
        where id = $1::uuid`,
      [allocationId, input.voidedBy, input.reason, input.approvedBy],
    );
    await tx.query(
      `update machvon.document set document_number = null, number_year = null, symbol = null, issued_on = null, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid and symbol = $2 and effect_status = 'PENDING'`,
      [current.document_id, current.symbol, input.voidedBy],
    );
    return toEntry({ ...current, status: 'VOIDED' });
  }

  /** The log of a register in number order, in keyset pages of the number. */
  async listEntries(tx: TenantTx, registerId: string, page: EntryPage): Promise<RegisterEntry[]> {
    const rows = await tx.query<EntryRow>(
      `select a.id, a.number, a.symbol, a.document_id, a.issued_on::text as issued_on, d.title,
              case when a.status = 'ALLOCATED' and d.effect_status = 'RECALLED' then 'RECALLED' else a.status end as status
         from machvon.document_number_allocation a join machvon.document d on d.tenant_id = a.tenant_id and d.id = a.document_id
        where a.register_id = $1::uuid and a.number > $2 order by a.number limit $3`,
      [registerId, page.afterNumber ?? 0, page.limit],
    );
    return rows.map(toEntry);
  }

  /** The numbers of a register that were voided, in order: they stay in the ledger and are not gaps (BR-DOC-03). */
  async voidedNumbers(tx: TenantTx, registerId: string): Promise<number[]> {
    const rows = await tx.query<{ number: number }>("select number from machvon.document_number_allocation where register_id = $1::uuid and status = 'VOIDED' order by number", [registerId]);
    return rows.map((row) => row.number);
  }

  /** The numbers missing from 1..last_number of a register: any answer is a serious error (BR-DOC-03). */
  async gaps(tx: TenantTx, registerId: string): Promise<number[]> {
    const rows = await tx.query<{ number: number }>('select machvon.register_gaps($1::uuid) as number', [registerId]);
    return rows.map((row) => row.number);
  }

  /**
   * BR-DOC-02: opens the next year for every open register of `fromYear` that has none, with the counter at zero. Safe
   * to run twice. The scheduler that calls it at 00:00 on 1 January (Asia/Ho_Chi_Minh) belongs to the platform jobs.
   */
  async rollover(tx: TenantTx, input: { fromYear: number; actor: string }): Promise<RegisterRecord[]> {
    const rows = await tx.query<RegisterRow>(
      `insert into machvon.document_number_register
         (tenant_id, id, register_code, name, direction, organization_unit_id, year, mode, scope_policy, created_by, updated_by)
       select tenant_id, gen_random_uuid(), register_code, name, direction, organization_unit_id, year + 1, mode, scope_policy - 'closed_reason', $2::uuid, $2::uuid
         from machvon.document_number_register r
        where r.year = $1 and r.status = 'OPEN'
        order by r.register_code, r.id
       on conflict (tenant_id, register_code, organization_unit_id, year) do nothing
       returning ${REGISTER_COLUMNS}`,
      [input.fromYear, input.actor],
    );
    return rows.map(toRegister).sort((left, right) => left.registerCode.localeCompare(right.registerCode));
  }

  /** Writes the number to the document; a symbol already carried by another outgoing document of the year is a pattern error. */
  private async claimSymbol(tx: TenantTx, documentId: string, claim: { number: number; year: number; symbol: string; issuedOn: string; actor: string }): Promise<void> {
    try {
      await tx.query(
        `update machvon.document set document_number = $2, number_year = $3, symbol = $4, issued_on = $5::date, updated_at = now(), updated_by = $6::uuid, version = version + 1
          where id = $1::uuid`,
        [documentId, claim.number, claim.year, claim.symbol, claim.issuedOn, claim.actor],
      );
    } catch (error) {
      if ((error as { code?: string } | null)?.code === UNIQUE_VIOLATION) throw new DomainError('SYMBOL_PATTERN_INVALID', 409, 'symbol_pattern');
      throw error;
    }
  }

  private async lockRegister(tx: TenantTx, id: string): Promise<RegisterRow> {
    try {
      const [row] = await tx.query<RegisterRow>(`select ${REGISTER_COLUMNS} from machvon.document_number_register where id = $1::uuid for update`, [id]);
      if (row === undefined) throw notFound();
      return row;
    } catch (error) {
      if (isLockTimeout(error)) throw new DomainError('REGISTER_LOCK_TIMEOUT', 409);
      throw error;
    }
  }
}
