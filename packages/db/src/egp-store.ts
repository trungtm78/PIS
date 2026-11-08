import { randomUUID } from 'node:crypto';
import {
  DomainError,
  EGP_ADAPTER_STATUS,
  EGP_CONNECTOR_CODE,
  EGP_EXTERNAL_TYPES,
  EGP_FRESHNESS_RULE_CODE,
  EGP_FRESHNESS_RULE_TYPE,
  EGP_LAYOUT_KINDS,
  EGP_LAYOUT_VERSION,
  EGP_POSITIONS,
  EGP_SOURCE_SYSTEM,
  EGP_SUGGESTION_THRESHOLD,
  assertEgpLayoutKnown,
  crosswalkMethodOf,
  egpConnectionMove,
  egpConnectionView,
  egpFreshnessParamsOf,
  egpKindOfPosition,
  egpMappingMove,
  egpMappingOutcome,
  suggestPackageMatches,
  validateEgpMapping,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type {
  EgpConnectionView,
  EgpIdMapping,
  EgpLayoutKind,
  EgpMappingMove,
  EgpMappingRequest,
  EgpMappingStatus,
  EgpMatchMethod,
  EgpPackageCandidate,
  EgpSubjectType,
  ResolvedGovernanceRule,
} from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const POSITION_CODES: readonly string[] = EGP_LAYOUT_KINDS.map((kind) => EGP_POSITIONS[kind]);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The connection.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpConnectionRow {
  id: string | null;
  connectorCode: string;
  enabled: boolean;
  layoutVersion: string;
  stateReason: string | null;
  stateChangedBy: string | null;
  stateChangedAt: string | null;
  /** 1 for a tenant that never used the connection: the first command creates the row at version 1. */
  version: number;
  updatedAt: string | null;
}

interface ConnectionSql {
  id: string;
  connector_code: string;
  enabled: boolean;
  layout_version: string;
  state_reason: string | null;
  state_changed_by: string | null;
  state_changed_at: string | null;
  version: string;
  updated_at: string;
}

const CONNECTION_SELECT = `select id, connector_code, enabled, layout_version, state_reason, state_changed_by, to_char(state_changed_at at time zone 'UTC', ${ISO}) as state_changed_at,
  version::text as version, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at from machvon.egp_connection`;

const connectionOf = (row: ConnectionSql): EgpConnectionRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  enabled: row.enabled,
  layoutVersion: row.layout_version,
  stateReason: row.state_reason,
  stateChangedBy: row.state_changed_by,
  stateChangedAt: row.state_changed_at,
  version: Number(row.version),
  updatedAt: row.updated_at,
});

/** What a tenant that never touched the connection sees: on, under the layout of the module, version 1 (what the first command will create). */
const DEFAULT_CONNECTION: EgpConnectionRow = {
  id: null,
  connectorCode: EGP_CONNECTOR_CODE,
  enabled: true,
  layoutVersion: EGP_LAYOUT_VERSION,
  stateReason: null,
  stateChangedBy: null,
  stateChangedAt: null,
  version: 1,
  updatedAt: null,
};

export interface EgpPositionRow {
  kind: EgpLayoutKind;
  connectorCode: string;
  cursorStatus: string | null;
  adapterStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastFileSha256: string | null;
}

export interface EgpRunRow {
  id: string;
  kind: EgpLayoutKind;
  connectorCode: string;
  layoutVersion: string;
  fileSha256: string;
  status: 'IMPORTING' | 'APPLIED' | 'FAILED';
  errorCode: string | null;
  counts: { total: number; applied: number; duplicate: number; conflict: number; quarantined: number; differencesOpened: number };
  openDifferences: number;
  importedBy: string;
  createdAt: string;
  createdAtKey: string;
  completedAt: string | null;
}

interface RunSql {
  id: string;
  connector_code: string;
  format_version: string;
  file_sha256: string;
  status: EgpRunRow['status'];
  error_code: string | null;
  rows_total: number;
  rows_applied: number;
  rows_duplicate: number;
  rows_conflict: number;
  rows_quarantined: number;
  differences_opened: number;
  open_differences: string;
  imported_by: string;
  created_at: string;
  created_at_key: string;
  completed_at: string | null;
}

const RUN_SELECT = `select i.id, i.connector_code, i.format_version, i.file_sha256, i.status, i.error_code, i.rows_total, i.rows_applied, i.rows_duplicate, i.rows_conflict, i.rows_quarantined,
  i.differences_opened, (select count(*) from machvon.file_import_reconciliation_item r where r.import_id = i.id and r.status = 'OPEN')::text as open_differences, i.imported_by,
  to_char(i.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('i.created_at')} as created_at_key, to_char(i.completed_at at time zone 'UTC', ${ISO}) as completed_at
  from machvon.file_import i`;

const runOf = (row: RunSql): EgpRunRow => ({
  id: row.id,
  kind: egpKindOfPosition(row.connector_code) as EgpLayoutKind,
  connectorCode: row.connector_code,
  layoutVersion: row.format_version,
  fileSha256: row.file_sha256,
  status: row.status,
  errorCode: row.error_code,
  counts: { total: row.rows_total, applied: row.rows_applied, duplicate: row.rows_duplicate, conflict: row.rows_conflict, quarantined: row.rows_quarantined, differencesOpened: row.differences_opened },
  openDifferences: Number(row.open_differences),
  importedBy: row.imported_by,
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
  completedAt: row.completed_at,
});

export interface EgpHealthReading {
  view: EgpConnectionView;
  lastImportAt: string | null;
  lastImportKind: EgpLayoutKind | null;
  /** The rule that decided the thresholds, with where its numbers come from and whether anybody confirmed them (an "i" on the screen). */
  rule: {
    source: ResolvedGovernanceRule['source'];
    version: number;
    unverified: boolean;
    formula: string | null;
    sourceText: string | null;
    asOf: string | null;
    legalStatus: string | null;
    params: { warnAfterHours: number; maxAgeHours: number; staleSeverity: string; figuresBlockedWhenStale: boolean };
  };
}

/**
 * The connection `egp.muasamcong` of a tenant (BID-22): the entry of the connector registry (ADM, mode FILE_IMPORT, adapter PROPOSED, Draft), the switch with its reason and history, the five positions of the
 * file import framework, and the health (the age of the last applied file against the rule `CONNECTOR_FRESHNESS`, code `EGP_FILE`). Nothing here opens a connection to the network.
 */
export class EgpConnectionStore {
  private readonly policy = new GovernancePolicyPort();

  /** The connection as the tenant has it, or the default a first command will create. A read never writes. */
  async current(tx: TenantTx): Promise<EgpConnectionRow> {
    const rows = await tx.query<ConnectionSql>(`${CONNECTION_SELECT} where connector_code = $1`, [EGP_CONNECTOR_CODE]);
    return rows[0] === undefined ? DEFAULT_CONNECTION : connectionOf(rows[0]);
  }

  /**
   * Gives the tenant the connection: the row of the switch (on, under the layout of the module, with a CREATED event), the entry of the connector registry (Draft, PROPOSED, mode FILE_IMPORT: only a
   * VERIFIED adapter may be Active, so it stays Draft) and the five positions of the file import. What the tenant already has is left as it is. Returns whether the switch row was created.
   */
  async ensure(tx: TenantTx, actor: string): Promise<{ row: EgpConnectionRow; created: boolean }> {
    const inserted = await tx.query<ConnectionSql>(
      `insert into machvon.egp_connection (tenant_id, id, connector_code, enabled, layout_version, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, true, $2, 1, $3::uuid, $3::uuid)
       on conflict (tenant_id, connector_code) do nothing
       returning id, connector_code, enabled, layout_version, state_reason, state_changed_by, null::text as state_changed_at, version::text as version, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at`,
      [EGP_CONNECTOR_CODE, EGP_LAYOUT_VERSION, actor],
    );
    if (inserted[0] !== undefined) {
      await tx.query(
        `insert into machvon.egp_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version) values (${TENANT}, gen_random_uuid(), $1::uuid, 'CREATED', null, $2::uuid, 1)`,
        [inserted[0].id, actor],
      );
    }
    await tx.query(
      `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, mapping_version, status, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, 'FILE_IMPORT', $3::jsonb, $4, 'Draft', 1, $5::uuid, $5::uuid)
       on conflict (tenant_id, connector_code) do nothing`,
      [EGP_CONNECTOR_CODE, EGP_ADAPTER_STATUS, JSON.stringify({ positions: EGP_POSITIONS, source_system: EGP_SOURCE_SYSTEM, credentials: 'none' }), EGP_LAYOUT_VERSION, actor],
    );
    for (const code of POSITION_CODES) {
      await tx.query(
        `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, updated_by)
         values (${TENANT}, gen_random_uuid(), $1, 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', $2::uuid)
         on conflict (tenant_id, connector_code, source_scope) do nothing`,
        [code, actor],
      );
    }
    const row = (await this.current(tx)) as EgpConnectionRow;
    return { row, created: inserted[0] !== undefined };
  }

  /** The registry entry of the connector, or undefined for a tenant that has not used it yet. */
  async registryEntry(tx: TenantTx): Promise<{ status: string; adapterStatus: string; mode: string; mappingVersion: string | null } | undefined> {
    const rows = await tx.query<{ status: string; adapter_status: string; mode: string; mapping_version: string | null }>(
      'select status, adapter_status, mode, mapping_version from machvon.integration_connector where connector_code = $1',
      [EGP_CONNECTOR_CODE],
    );
    return rows[0] === undefined ? undefined : { status: rows[0].status, adapterStatus: rows[0].adapter_status, mode: rows[0].mode, mappingVersion: rows[0].mapping_version };
  }

  /**
   * Switches the connection on or off (a versioned command): the person says why, a stale version is 409 VERSION_CONFLICT, a move to the state it is already in is 422. The row, the history event and the
   * reason are written in the transaction of the command.
   */
  async setState(tx: TenantTx, expectedVersion: number, move: { enabled: unknown; reason: unknown }, actor: string): Promise<{ before: EgpConnectionRow; row: EgpConnectionRow }> {
    await this.ensure(tx, actor);
    const locked = await tx.query<ConnectionSql>(`${CONNECTION_SELECT} where connector_code = $1 for update`, [EGP_CONNECTOR_CODE]);
    const before = connectionOf(locked[0] as ConnectionSql);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = egpConnectionMove(before, move);
    await tx.query(
      `update machvon.egp_connection set enabled = $2, state_reason = $3, state_changed_by = $4::uuid, state_changed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp(), updated_by = $4::uuid
        where id = $1::uuid`,
      [before.id, decided.enabled, decided.reason, actor],
    );
    await tx.query(
      `insert into machvon.egp_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::bigint)`,
      [before.id, decided.enabled ? 'ENABLED' : 'DISABLED', decided.reason, actor, before.version + 1],
    );
    return { before, row: (await this.current(tx)) as EgpConnectionRow };
  }

  /** The newest events of the switch, for the history of the screen. */
  async events(tx: TenantTx, limit: number): Promise<Array<{ id: string; action: string; reason: string | null; actorId: string; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: string; reason: string | null; actor_id: string; connection_version: string; occurred_at: string }>(
      `select e.id, e.action, e.reason, e.actor_id, e.connection_version::text as connection_version, to_char(e.occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.egp_connection_event e join machvon.egp_connection c on c.tenant_id = e.tenant_id and c.id = e.connection_id
        where c.connector_code = $1 order by e.connection_version desc, e.occurred_at desc, e.id desc limit $2`,
      [EGP_CONNECTOR_CODE, limit],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason, actorId: row.actor_id, version: Number(row.connection_version), occurredAt: row.occurred_at }));
  }

  /** The five positions of the file import with what each last did (a position never used shows nulls, never "fine"). */
  async positions(tx: TenantTx): Promise<EgpPositionRow[]> {
    const rows = await tx.query<{ connector_code: string; status: string; adapter_status: string; last_success_at: string | null; last_error_code: string | null; last_file_sha256: string | null }>(
      `select connector_code, status, adapter_status, to_char(last_success_at at time zone 'UTC', ${ISO}) as last_success_at, last_error_code, last_file_sha256
         from machvon.integration_cursor where connector_code = any($1::text[]) and source_scope = 'DEFAULT'`,
      [[...POSITION_CODES]],
    );
    return EGP_LAYOUT_KINDS.map((kind) => {
      const found = rows.find((row) => row.connector_code === EGP_POSITIONS[kind]);
      return {
        kind,
        connectorCode: EGP_POSITIONS[kind],
        cursorStatus: found?.status ?? null,
        adapterStatus: found?.adapter_status ?? null,
        lastSuccessAt: found?.last_success_at ?? null,
        lastErrorCode: found?.last_error_code ?? null,
        lastFileSha256: found?.last_file_sha256 ?? null,
      };
    });
  }

  /** The newest tries of every kind (a FAILED try is a run too), with the open differences each left. */
  async lastRuns(tx: TenantTx, limit: number): Promise<EgpRunRow[]> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} where i.connector_code = any($1::text[]) order by i.created_at desc, i.id desc limit $2`, [[...POSITION_CODES], limit]);
    return rows.map(runOf);
  }

  /** The time the last file was applied, whichever kind (the source of the age): the `completed_at` of the newest APPLIED `file_import` of the five positions. */
  async lastImport(tx: TenantTx): Promise<{ at: Date; kind: EgpLayoutKind } | undefined> {
    const rows = await tx.query<{ completed_at: string; connector_code: string }>(
      `select completed_at, connector_code from machvon.file_import where connector_code = any($1::text[]) and status = 'APPLIED' order by completed_at desc limit 1`,
      [[...POSITION_CODES]],
    );
    const row = rows[0];
    return row === undefined ? undefined : { at: new Date(row.completed_at), kind: egpKindOfPosition(row.connector_code) as EgpLayoutKind };
  }

  /**
   * The health the screen shows and the alert source reads: the freshness rule in force today (a tenant rule, else the built-in default with its source, its as-of day and `legalStatus` UNVERIFIED),
   * the age of the last applied file, the status FRESH, AGING, STALE or NEVER_IMPORTED, the alert, and whether the figures are blocked.
   */
  async health(tx: TenantTx, now: Date, connection: EgpConnectionRow): Promise<EgpHealthReading> {
    const rule = await this.policy.require(tx, EGP_FRESHNESS_RULE_TYPE, EGP_FRESHNESS_RULE_CODE, now);
    const params = egpFreshnessParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>);
    const last = await this.lastImport(tx);
    const registry = await this.registryEntry(tx);
    const view = egpConnectionView({ lastImportAt: last?.at ?? null, now, params, enabled: connection.enabled, layoutVersion: connection.layoutVersion, adapterStatus: (registry?.adapterStatus ?? EGP_ADAPTER_STATUS) as typeof EGP_ADAPTER_STATUS });
    return {
      view,
      lastImportAt: last === undefined ? null : last.at.toISOString(),
      lastImportKind: last?.kind ?? null,
      rule: {
        source: rule.source,
        version: rule.version,
        unverified: rule.unverified,
        formula: rule.provenance?.formula ?? null,
        sourceText: rule.provenance?.source ?? null,
        asOf: rule.provenance?.asOf ?? null,
        legalStatus: rule.provenance?.legalStatus ?? null,
        params: { warnAfterHours: params.warn_after_hours, maxAgeHours: params.max_age_hours, staleSeverity: params.stale_severity, figuresBlockedWhenStale: params.figures_blocked_when_stale },
      },
    };
  }

  /** The layout a request names, judged before the file is opened (422 `EGP_LAYOUT_VERSION_UNKNOWN`); without one, the layout of the connection. */
  layoutOf(requested: string | undefined, connection: EgpConnectionRow): string {
    return assertEgpLayoutKnown(requested ?? connection.layoutVersion);
  }

  async listRuns(tx: TenantTx, request: { kind?: EgpLayoutKind | undefined; limit: number; after: { key: string; id: string } | undefined }): Promise<EgpRunRow[]> {
    const rows = await tx.query<RunSql>(
      `${RUN_SELECT}
        where i.connector_code = any($1::text[]) and ($2::text is null or i.connector_code = $2)
          and ($3::text is null or (${timestampKey('i.created_at')}, i.id) < ($3::text, $4::uuid))
        order by i.created_at desc, i.id desc limit $5`,
      [[...POSITION_CODES], request.kind === undefined ? null : EGP_POSITIONS[request.kind], request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(runOf);
  }

  async findRun(tx: TenantTx, id: string): Promise<EgpRunRow | undefined> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} where i.id = $1::uuid and i.connector_code = any($2::text[])`, [id, [...POSITION_CODES]]);
    return rows[0] === undefined ? undefined : runOf(rows[0]);
  }

  /** The file kinds that were applied at least once and how many records each holds: what BID-22 says the register has of the network. */
  async recordCounts(tx: TenantTx): Promise<Record<EgpLayoutKind, number>> {
    const rows = await tx.query<{ kind: EgpLayoutKind; n: string }>('select kind, count(*)::text as n from machvon.egp_record group by kind');
    const counts = { KHLCNT: 0, TBMT: 0, RESULT: 0, CONTRACTOR: 0, RESTRICTION: 0 } as Record<EgpLayoutKind, number>;
    for (const row of rows) counts[row.kind] = Number(row.n);
    return counts;
  }

  /** The differences that no one has settled, over the five positions. */
  async openDifferences(tx: TenantTx): Promise<number> {
    const rows = await tx.query<{ n: string }>("select count(*)::text as n from machvon.file_import_reconciliation_item where connector_code = any($1::text[]) and status = 'OPEN'", [[...POSITION_CODES]]);
    return Number(rows[0]?.n ?? 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Our side of a mapping.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpSubject {
  id: string;
  /** Our code as it is stored (a project code, a package code, a contract code, a tax id). */
  code: string;
}

export type EgpSubjectLookup = { found: EgpSubject } | { missing: 'NOT_FOUND' | 'AMBIGUOUS' };

const TAX_IDENTIFIER = /^(\d{10})(?:-?(\d{3}))?$/;

/** Finds the row of ours that a code names. A code that names two rows (a package code used in two projects) is AMBIGUOUS until the project code says which; the subject is never guessed. */
export async function resolveEgpSubject(tx: TenantTx, subjectType: EgpSubjectType, ourCode: string, projectCode: string | null): Promise<EgpSubjectLookup> {
  const answer = (rows: Array<{ id: string; code: string }>): EgpSubjectLookup => (rows.length === 0 ? { missing: 'NOT_FOUND' } : rows.length > 1 ? { missing: 'AMBIGUOUS' } : { found: { id: (rows[0] as { id: string }).id, code: (rows[0] as { code: string }).code } });
  switch (subjectType) {
    case 'PROJECT':
      return answer(await tx.query<{ id: string; code: string }>('select id, code from machvon.project where code = $1', [ourCode]));
    case 'PLAN': {
      // The plan of a project: the one in force (APPROVED), else the newest revision that is not cancelled. The code is the code of the project.
      const rows = await tx.query<{ id: string; code: string }>(
        `select pl.id, p.code from machvon.procurement_plan pl join machvon.project p on p.tenant_id = pl.tenant_id and p.id = pl.project_id
          where p.code = $1 and pl.status <> 'CANCELLED' order by (pl.status = 'APPROVED') desc, pl.revision desc limit 2`,
        [ourCode],
      );
      return rows.length === 0 ? { missing: 'NOT_FOUND' } : { found: { id: (rows[0] as { id: string }).id, code: (rows[0] as { code: string }).code } };
    }
    case 'PACKAGE':
    case 'NOTICE':
    case 'RESULT':
      return answer(
        await tx.query<{ id: string; code: string }>(
          `select k.id, k.code from machvon.procurement_package k join machvon.project p on p.tenant_id = k.tenant_id and p.id = k.project_id
            where k.code = $1 and ($2::text is null or p.code = $2) and k.status <> 'CANCELLED' order by k.id limit 2`,
          [ourCode, projectCode],
        ),
      );
    case 'CONTRACT':
      return answer(await tx.query<{ id: string; code: string }>('select id, code from machvon.contract where code = $1 order by id limit 2', [ourCode]));
    case 'CONTRACTOR': {
      // By tax id only, never by name; the verified contractor of that tax id stands when there are several.
      const match = TAX_IDENTIFIER.exec(ourCode.replace(/\s+/g, ''));
      if (match === null) return { missing: 'NOT_FOUND' };
      const tax = match[2] === undefined ? (match[1] as string) : `${match[1]}-${match[2]}`;
      const rows = await tx.query<{ id: string; code: string; verified: boolean }>(
        `select id, tax_identifier as code, (verification_status = 'VERIFIED') as verified from machvon.contractor where tax_identifier = $1 order by (verification_status = 'VERIFIED') desc, id limit 3`,
        [tax],
      );
      if (rows.length === 0) return { missing: 'NOT_FOUND' };
      const verified = rows.filter((row) => row.verified);
      if (verified.length === 1) return { found: { id: (verified[0] as { id: string }).id, code: tax } };
      return rows.length === 1 ? { found: { id: (rows[0] as { id: string }).id, code: tax } } : { missing: 'AMBIGUOUS' };
    }
    default:
      return { missing: 'NOT_FOUND' };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The mappings.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EgpMappingRow {
  id: string;
  subjectType: EgpSubjectType;
  subjectId: string;
  ourCode: string | null;
  projectCode: string | null;
  externalType: string;
  externalCode: string;
  matchMethod: 'MANUAL' | 'IMPORT' | 'RULE';
  confidence: number | null;
  validFrom: string;
  validUntil: string | null;
  status: EgpMappingStatus;
  proposedBy: string;
  proposalReason: string | null;
  importId: string | null;
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

interface MappingSql {
  id: string;
  subject_type: EgpSubjectType;
  subject_id: string;
  our_code: string | null;
  project_code: string | null;
  external_type: string;
  external_code: string;
  match_method: EgpMappingRow['matchMethod'];
  confidence: string | null;
  valid_from: string;
  valid_until: string | null;
  status: EgpMappingStatus;
  created_by: string;
  proposal_reason: string | null;
  import_id: string | null;
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

/** Our code and the code of its project, read from the table the subject lives in (a notice and a result are about a package). */
const OUR_CODE = `case x.subject_type
    when 'PROJECT' then (select p.code from machvon.project p where p.id = x.subject_id)
    when 'PLAN' then (select p.code from machvon.procurement_plan pl join machvon.project p on p.tenant_id = pl.tenant_id and p.id = pl.project_id where pl.id = x.subject_id)
    when 'CONTRACT' then (select c.code from machvon.contract c where c.id = x.subject_id)
    when 'CONTRACTOR' then (select c.tax_identifier from machvon.contractor c where c.id = x.subject_id)
    else (select k.code from machvon.procurement_package k where k.id = x.subject_id)
  end`;
const PROJECT_CODE = `case x.subject_type
    when 'PROJECT' then (select p.code from machvon.project p where p.id = x.subject_id)
    when 'PLAN' then (select p.code from machvon.procurement_plan pl join machvon.project p on p.tenant_id = pl.tenant_id and p.id = pl.project_id where pl.id = x.subject_id)
    when 'CONTRACT' then (select p.code from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id where c.id = x.subject_id)
    when 'CONTRACTOR' then null
    else (select p.code from machvon.procurement_package k join machvon.project p on p.tenant_id = k.tenant_id and p.id = k.project_id where k.id = x.subject_id)
  end`;

const MAPPING_SELECT = `select x.id, x.subject_type, x.subject_id, ${OUR_CODE} as our_code, ${PROJECT_CODE} as project_code, x.external_type, x.external_code, x.match_method, x.confidence::text as confidence,
  x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.status, x.created_by, x.proposal_reason, x.import_id, x.approved_by, to_char(x.approved_at at time zone 'UTC', ${ISO}) as approved_at,
  x.decision_reason, x.retired_by, to_char(x.retired_at at time zone 'UTC', ${ISO}) as retired_at, x.retire_reason, x.version::text as version,
  to_char(x.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('x.created_at')} as created_at_key
  from machvon.master_crosswalk x where x.subject_type is not null and x.source_system = '${EGP_SOURCE_SYSTEM}'`;

const mappingOf = (row: MappingSql): EgpMappingRow => ({
  id: row.id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  ourCode: row.our_code,
  projectCode: row.project_code,
  externalType: row.external_type,
  externalCode: row.external_code,
  matchMethod: row.match_method,
  confidence: row.confidence === null ? null : Number(row.confidence),
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  proposedBy: row.created_by,
  proposalReason: row.proposal_reason,
  importId: row.import_id,
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

/** The mapping as the kernel judges it. */
export const egpMappingOf = (row: Pick<EgpMappingRow, 'subjectType' | 'subjectId' | 'externalType' | 'externalCode' | 'validFrom' | 'validUntil' | 'matchMethod' | 'confidence' | 'status'>): EgpIdMapping => ({
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  sourceSystem: EGP_SOURCE_SYSTEM,
  externalType: row.externalType,
  externalCode: row.externalCode,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  matchMethod: row.matchMethod === 'IMPORT' ? 'EXACT_CODE' : row.matchMethod === 'RULE' ? 'TAX_CODE' : row.confidence === null ? 'MANUAL' : 'NAME_SUGGESTION',
  confidence: row.confidence,
  status: row.status === 'ACTIVE' ? 'ACTIVE' : 'RETIRED',
});

export interface EgpMappingFilter {
  subjectType?: EgpSubjectType | undefined;
  status?: EgpMappingStatus | undefined;
  q?: string | undefined;
}

export interface EgpMappingCounts {
  PROPOSED: number;
  ACTIVE: number;
  REJECTED: number;
  RETIRED: number;
}

export interface EgpSuggestion {
  externalCode: string;
  importedName: string;
  importedPrice: string;
  planCode: string;
  importId: string;
  candidates: Array<{ id: string; code: string; name: string; budget: string; confidence: number }>;
}

/**
 * The codes of the national network on `master_crosswalk` (BID-23, BR-BID-15). A mapping is PROPOSED by one person, or by the import of a file whose loader is the maker, and becomes ACTIVE when another person
 * approves it. One external code stands for one subject at a time and one subject holds one code at a time: a proposal that would break either is refused (409 `CROSSWALK_DUPLICATE`) and, for an
 * import, becomes a difference for a person. The database holds the same rules (unique indexes, the CHECKs of V1940), so a race ends in the same answer.
 */
export class EgpMappingStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<EgpMappingRow | undefined> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} and x.id = $1::uuid${lock ? ' for update of x' : ''}`, [id]);
    return rows[0] === undefined ? undefined : mappingOf(rows[0]);
  }

  /** The mappings, the newest first, by kind of subject, status and a text found in either code. */
  async list(tx: TenantTx, filter: EgpMappingFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<EgpMappingRow[]> {
    const like = filter.q === undefined ? null : `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.query<MappingSql>(
      `select * from (${MAPPING_SELECT}) m
        where ($1::text is null or m.subject_type = $1) and ($2::text is null or m.status = $2)
          and ($3::text is null or m.external_code ilike $3 escape '\\' or m.our_code ilike $3 escape '\\')
          and ($4::text is null or (m.created_at_key, m.id) < ($4::text, $5::uuid))
        order by m.created_at_key desc, m.id desc limit $6`,
      [filter.subjectType ?? null, filter.status ?? null, like, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(mappingOf);
  }

  async counts(tx: TenantTx): Promise<EgpMappingCounts> {
    const rows = await tx.query<{ status: EgpMappingStatus; n: string }>(`select status, count(*)::text as n from machvon.master_crosswalk where subject_type is not null and source_system = '${EGP_SOURCE_SYSTEM}' group by status`);
    const counts: EgpMappingCounts = { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  /** The ACTIVE mappings that touch a proposal: the ones holding its code and the ones of its subject, as the kernel reads them. */
  async activeAround(tx: TenantTx, subjectType: EgpSubjectType, subjectId: string, externalType: string, externalCode: string): Promise<EgpIdMapping[]> {
    const rows = await tx.query<MappingSql>(
      `${MAPPING_SELECT} and x.status = 'ACTIVE' and x.external_type = $1 and ((x.external_code = $2) or (x.subject_type = $3 and x.subject_id = $4::uuid))`,
      [externalType, externalCode, subjectType, subjectId],
    );
    return rows.map((row) => egpMappingOf(mappingOf(row)));
  }

  /** Whether the same subject and code already wait for a decision. */
  async waiting(tx: TenantTx, subjectId: string, externalType: string, externalCode: string): Promise<EgpMappingRow | undefined> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} and x.status = 'PROPOSED' and x.external_type = $1 and x.external_code = $2 and x.subject_id = $3::uuid`, [externalType, externalCode, subjectId]);
    return rows[0] === undefined ? undefined : mappingOf(rows[0]);
  }

  /** Inserts a PROPOSED mapping (the caller has judged it). Returns undefined when the same proposal already waits. */
  async insertProposed(
    tx: TenantTx,
    input: { subject: EgpSubject; subjectType: EgpSubjectType; externalCode: string; validFrom: string; validUntil: string | null; method: EgpMatchMethod; confidence: number | null; reason: string; importId: string | null },
    actor: string,
  ): Promise<{ id: string } | undefined> {
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.master_crosswalk
           (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, valid_until, match_method, confidence, status, proposal_reason, import_id, created_by, updated_by)
         values (${TENANT}, $1::uuid, null, $2, $3::uuid, $4, $5, $6, $7::date, $8::date, $9, $10::numeric, 'PROPOSED', $11, $12::uuid, $13::uuid, $13::uuid)`,
        [id, input.subjectType, input.subject.id, EGP_SOURCE_SYSTEM, EGP_EXTERNAL_TYPES[input.subjectType], input.externalCode, input.validFrom, input.validUntil, crosswalkMethodOf(input.method), input.confidence, input.reason, input.importId, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return undefined;
      throw error;
    }
    return { id };
  }

  /**
   * A person proposes a mapping by hand (BID-23). Our code is resolved to the row it names (422 `our_code` when it names none, `our_project_code` when it names two), the mapping is judged by the kernel,
   * and what it would do against the ACTIVE mappings decides: another subject holds the code, or the subject holds another code, is 409 `CROSSWALK_DUPLICATE` (a mapping is replaced by retiring the old one first).
   */
  async propose(tx: TenantTx, request: EgpMappingRequest & { reason: string }, actor: string, now: Date): Promise<{ row: EgpMappingRow }> {
    const lookup = await resolveEgpSubject(tx, request.subjectType, request.ourCode, request.ourProjectCode);
    if ('missing' in lookup) throw new DomainError('VALIDATION_FAILED', 422, lookup.missing === 'AMBIGUOUS' ? 'our_project_code' : 'our_code');
    const validFrom = request.validFrom ?? vietnamDateOf(now);
    const proposal: EgpIdMapping = {
      subjectType: request.subjectType,
      subjectId: lookup.found.id,
      sourceSystem: EGP_SOURCE_SYSTEM,
      externalType: EGP_EXTERNAL_TYPES[request.subjectType],
      externalCode: request.externalCode,
      validFrom,
      validUntil: request.validUntil,
      matchMethod: request.method,
      confidence: request.confidence,
      status: 'ACTIVE',
    };
    const findings = validateEgpMapping(proposal);
    const finding = findings[0];
    // The findings go with the refusal, so the screen can explain each one in its own words (`egp.mapping.error.*`).
    if (finding !== undefined) throw new DomainError('VALIDATION_FAILED', 422, finding.field, { extensions: { findings: findings.map((one) => ({ field: one.field, code: one.code, message: one.message })) } });
    const outcome = egpMappingOutcome(await this.activeAround(tx, request.subjectType, lookup.found.id, proposal.externalType, proposal.externalCode), proposal);
    if (outcome !== 'CREATE') throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: outcome } });
    const inserted = await this.insertProposed(
      tx,
      { subject: lookup.found, subjectType: request.subjectType, externalCode: request.externalCode, validFrom, validUntil: request.validUntil, method: request.method, confidence: request.confidence, reason: request.reason, importId: null },
      actor,
    );
    if (inserted === undefined) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: 'ALREADY_PROPOSED' } });
    return { row: (await this.find(tx, inserted.id)) as EgpMappingRow };
  }

  /**
   * Approves, rejects or retires a mapping (a versioned command). The kernel decides the edge, the maker-checker rule and the reason; an approval is judged once more against the ACTIVE mappings (the world
   * moved since the proposal) and the unique indexes have the last word (409 `CROSSWALK_DUPLICATE`).
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { move: EgpMappingMove; reason: unknown }, actor: string, now: Date): Promise<{ before: EgpMappingRow; row: EgpMappingRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = egpMappingMove({ status: before.status, proposedBy: before.proposedBy }, { move: step.move, actorId: actor, reason: step.reason });
    const today = vietnamDateOf(now);
    try {
      if (step.move === 'RETIRE') {
        // The day it no longer holds is today, but never on or before the day it began (a mapping that began today ends tomorrow: ACTIVE rows only resolve, so it stops at once).
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
          const proposal = egpMappingOf({ ...before, status: 'ACTIVE' });
          const outcome = egpMappingOutcome(await this.activeAround(tx, before.subjectType, before.subjectId, before.externalType, before.externalCode), proposal);
          if (outcome !== 'CREATE') throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: outcome } });
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
    return { before, row: (await this.find(tx, id)) as EgpMappingRow };
  }

  /**
   * What the system proposes for a person to confirm (BID-23, "suggestions awaiting confirmation"): a package of the network that has no mapping and whose price equals the budget of a package of ours to the unit and
   * whose name is alike (Jaccard index, the line `EGP_SUGGESTION_THRESHOLD`, our own number and unverified). It is a hint, never a link: nothing is written until a person proposes the mapping and another approves it.
   */
  async suggestions(tx: TenantTx, limit: number): Promise<{ items: EgpSuggestion[]; threshold: number }> {
    const imported = await tx.query<{ id: string; import_id: string; record: { packageExternalCode: string; packageName: string | null; estimatedPrice: string | null; planCode: string } }>(
      `select r.id, r.import_id, r.record from machvon.egp_record r
        where r.kind = 'KHLCNT' and r.record ->> 'packageName' is not null and r.record ->> 'estimatedPrice' is not null
          and not exists (
            select 1 from machvon.master_crosswalk x
             where x.subject_type = 'PACKAGE' and x.source_system = '${EGP_SOURCE_SYSTEM}' and x.external_type = 'EGP_PACKAGE' and x.external_code = r.record ->> 'packageExternalCode' and x.status in ('PROPOSED', 'ACTIVE')
          )
        order by r.created_at desc, r.id limit $1`,
      [limit],
    );
    if (imported.length === 0) return { items: [], threshold: EGP_SUGGESTION_THRESHOLD };
    const ours = await tx.query<{ id: string; code: string; name: string; budget: string }>(
      `select k.id, k.code, coalesce(k.title, '') as name, k.budget_vnd::text as budget from machvon.procurement_package k
        where k.status <> 'CANCELLED' and not exists (select 1 from machvon.master_crosswalk x where x.subject_type = 'PACKAGE' and x.subject_id = k.id and x.external_type = 'EGP_PACKAGE' and x.status in ('PROPOSED', 'ACTIVE'))
        order by k.code limit 5000`,
    );
    const candidates: EgpPackageCandidate[] = ours.map((row) => ({ id: row.id, code: row.code, name: row.name, budget: row.budget }));
    const items: EgpSuggestion[] = [];
    for (const row of imported) {
      const hits = suggestPackageMatches({ name: row.record.packageName, estimatedPrice: row.record.estimatedPrice }, candidates);
      if (hits.length === 0) continue;
      items.push({
        externalCode: row.record.packageExternalCode,
        importedName: row.record.packageName as string,
        importedPrice: row.record.estimatedPrice as string,
        planCode: row.record.planCode,
        importId: row.import_id,
        candidates: hits.slice(0, 5).map((hit) => {
          const ourRow = ours.find((candidate) => candidate.id === hit.id) as { name: string; budget: string };
          return { id: hit.id, code: hit.code, name: ourRow.name, budget: ourRow.budget, confidence: hit.confidence };
        }),
      });
    }
    return { items, threshold: EGP_SUGGESTION_THRESHOLD };
  }
}
