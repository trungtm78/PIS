import { randomUUID } from 'node:crypto';
import {
  FEED_CONNECTOR_CODE,
  FEED_FRESHNESS_RULE_CODE,
  FEED_FRESHNESS_RULE_TYPE,
  FEED_KINDS,
  FEED_LAYOUT_VERSION,
  FEED_POLICY_RULE_CODE,
  FEED_POLICY_RULE_TYPE,
  FEED_POSITIONS,
  FEED_SOURCE_SYSTEM,
  assertFeedLayoutKnown,
  canonicalJson,
  feedAcceptance,
  feedConnectionMove,
  feedConnectorHealth,
  feedFreshnessParamsOf,
  feedGeneratorParamsJson,
  feedGeneratorParamsOf,
  feedPolicyOf,
  sha256Hex,
  versionConflict,
} from '@machvon/kernel';
import type {
  FeedAcceptance,
  FeedChannel,
  FeedConnectionState,
  FeedConnectorHealth,
  FeedFreshnessParams,
  FeedGeneratorAction,
  FeedGeneratorDecision,
  FeedGeneratorParams,
  FeedKind,
  FeedPolicy,
  FeedRecord,
  ResolvedGovernanceRule,
  SourcedFeedRecord,
} from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HubRunPort } from './hub-run-port.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const POSITION_CODES: readonly string[] = FEED_KINDS.map((kind) => FEED_POSITIONS[kind]);
const CHUNK = 500;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The connection.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FeedConnectionRow {
  id: string | null;
  connectorCode: string;
  enabled: boolean;
  layoutVersion: string;
  stateReason: string | null;
  stateChangedBy: string | null;
  stateChangedAt: string | null;
  generatorState: 'STOPPED' | 'RUNNING';
  generatorEpoch: number;
  generatorParams: Record<string, unknown> | null;
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
  generator_state: 'STOPPED' | 'RUNNING';
  generator_epoch: number;
  generator_params: Record<string, unknown> | null;
  version: string;
  updated_at: string;
}

const CONNECTION_SELECT = `select id, connector_code, enabled, layout_version, state_reason, state_changed_by, to_char(state_changed_at at time zone 'UTC', ${ISO}) as state_changed_at,
  generator_state, generator_epoch, generator_params, version::text as version, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at from machvon.finance_feed_connection`;

const connectionOf = (row: ConnectionSql): FeedConnectionRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  enabled: row.enabled,
  layoutVersion: row.layout_version,
  stateReason: row.state_reason,
  stateChangedBy: row.state_changed_by,
  stateChangedAt: row.state_changed_at,
  generatorState: row.generator_state,
  generatorEpoch: row.generator_epoch,
  generatorParams: row.generator_params,
  version: Number(row.version),
  updatedAt: row.updated_at,
});

/** What a tenant that never touched the connection sees: on, under the layout of the module, generator stopped, version 1 (what the first command will create). */
const DEFAULT_CONNECTION: FeedConnectionRow = {
  id: null,
  connectorCode: FEED_CONNECTOR_CODE,
  enabled: true,
  layoutVersion: FEED_LAYOUT_VERSION,
  stateReason: null,
  stateChangedBy: null,
  stateChangedAt: null,
  generatorState: 'STOPPED',
  generatorEpoch: 0,
  generatorParams: null,
  version: 1,
  updatedAt: null,
};

/** The connection as the pure rules judge it. */
export const feedStateOf = (row: FeedConnectionRow): FeedConnectionState => ({
  enabled: row.enabled,
  version: row.version,
  generatorState: row.generatorState,
  generatorEpoch: row.generatorEpoch,
  generatorMonth: typeof row.generatorParams?.current_month === 'number' ? row.generatorParams.current_month : null,
});

export interface FeedPositionRow {
  kind: FeedKind;
  connectorCode: string;
  cursorStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastFileSha256: string | null;
}

export interface FeedRunRow {
  id: string;
  channel: FeedChannel;
  kind: FeedKind | null;
  action: string;
  layoutVersion: string;
  acceptance: FeedAcceptance;
  fileSha256: string | null;
  fileImportId: string | null;
  seed: number | null;
  epoch: number;
  parameters: Record<string, unknown> | null;
  counts: { total: number; written: number; skipped: number; rejected: number };
  asOfLatest: string | null;
  digest: string | null;
  importedBy: string;
  createdAt: string;
  createdAtKey: string;
}

interface RunSql {
  id: string;
  channel: FeedChannel;
  kind: FeedKind | null;
  action: string;
  layout_version: string;
  file_sha256: string | null;
  file_import_id: string | null;
  seed: string | null;
  epoch: number;
  parameters: Record<string, unknown> | null;
  records_total: number;
  records_written: number;
  records_skipped: number;
  rows_rejected: number;
  as_of_latest: string | null;
  digest: string | null;
  imported_by: string;
  created_at: string;
  created_at_key: string;
}

const RUN_SELECT = `select id, channel, kind, action, layout_version, file_sha256, file_import_id, seed::text as seed, epoch, parameters, records_total, records_written, records_skipped, rows_rejected,
  as_of_latest::text as as_of_latest, digest, imported_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('created_at')} as created_at_key from machvon.finance_feed_run`;

const runOf = (row: RunSql): FeedRunRow => ({
  id: row.id,
  channel: row.channel,
  kind: row.kind,
  action: row.action,
  layoutVersion: row.layout_version,
  acceptance: feedAcceptance(row.layout_version),
  fileSha256: row.file_sha256,
  fileImportId: row.file_import_id,
  seed: row.seed === null ? null : Number(row.seed),
  epoch: row.epoch,
  parameters: row.parameters,
  counts: { total: row.records_total, written: row.records_written, skipped: row.records_skipped, rejected: row.rows_rejected },
  asOfLatest: row.as_of_latest,
  digest: row.digest,
  importedBy: row.imported_by,
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface FeedHealthReading {
  health: FeedConnectorHealth;
  lastRunAt: string | null;
  lastRunChannel: FeedChannel | null;
  /** The rules that decided the thresholds, with where their numbers come from and whether anybody confirmed them (an "i" on the screen). */
  freshness: { source: ResolvedGovernanceRule['source']; version: number; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null; params: FeedFreshnessParams };
  policy: { source: ResolvedGovernanceRule['source']; version: number; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null; params: FeedPolicy };
}

const provenanceOf = (rule: ResolvedGovernanceRule): { source: ResolvedGovernanceRule['source']; version: number; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null } => ({
  source: rule.source,
  version: rule.version,
  unverified: rule.unverified,
  formula: rule.provenance?.formula ?? null,
  sourceText: rule.provenance?.source ?? null,
  asOf: rule.provenance?.asOf ?? null,
  legalStatus: rule.provenance?.legalStatus ?? null,
});

/**
 * The connection `fin.sotaichinh` of a tenant (FEED-01): the entry of the connector registry (ADM), the switch with its reason and history, the four positions of the file import, the state of the data generator
 * and the health (the age of the last applied run against the rule `CONNECTOR_FRESHNESS`, code `FIN_FEED`). Nothing here opens a connection.
 */
export class FeedConnectionStore {
  private readonly policy = new GovernancePolicyPort();

  /** The connection as the tenant has it, or the default a first command will create. A read never writes. */
  async current(tx: TenantTx): Promise<FeedConnectionRow> {
    const rows = await tx.query<ConnectionSql>(`${CONNECTION_SELECT} where connector_code = $1`, [FEED_CONNECTOR_CODE]);
    return rows[0] === undefined ? DEFAULT_CONNECTION : connectionOf(rows[0]);
  }

  /**
   * Gives the tenant the connection: the switch row (on, under the layout of the module, with a CREATED event), the entry of the connector registry (Draft, PROPOSED, mode FILE_IMPORT: only a VERIFIED adapter
   * may be Active, so it stays Draft) and the four positions of the file import. What the tenant already has is left as it is.
   */
  async ensure(tx: TenantTx, actor: string): Promise<{ row: FeedConnectionRow; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.finance_feed_connection (tenant_id, id, connector_code, enabled, layout_version, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, true, $2, 1, $3::uuid, $3::uuid)
       on conflict (tenant_id, connector_code) do nothing returning id`,
      [FEED_CONNECTOR_CODE, FEED_LAYOUT_VERSION, actor],
    );
    if (inserted[0] !== undefined) {
      await tx.query(
        `insert into machvon.finance_feed_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version) values (${TENANT}, gen_random_uuid(), $1::uuid, 'CREATED', null, $2::uuid, 1)`,
        [inserted[0].id, actor],
      );
    }
    await tx.query(
      `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, mapping_version, status, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, 'PROPOSED', 'FILE_IMPORT', $2::jsonb, $3, 'Draft', 1, $4::uuid, $4::uuid)
       on conflict (tenant_id, connector_code) do nothing`,
      [FEED_CONNECTOR_CODE, JSON.stringify({ positions: FEED_POSITIONS, source_system: FEED_SOURCE_SYSTEM, channels: ['FILE', 'API_PUSH', 'GENERATOR'], credentials: 'none' }), FEED_LAYOUT_VERSION, actor],
    );
    for (const code of POSITION_CODES) {
      await tx.query(
        `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, updated_by)
         values (${TENANT}, gen_random_uuid(), $1, 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', $2::uuid)
         on conflict (tenant_id, connector_code, source_scope) do nothing`,
        [code, actor],
      );
    }
    return { row: await this.current(tx), created: inserted[0] !== undefined };
  }

  /** Switches the connection on or off (a versioned command): the person says why, a stale version is 409 VERSION_CONFLICT, a move to the state it is already in is 422. */
  async setState(tx: TenantTx, expectedVersion: number, move: { enabled: unknown; reason: unknown }, actor: string): Promise<{ before: FeedConnectionRow; row: FeedConnectionRow }> {
    await this.ensure(tx, actor);
    const locked = await tx.query<ConnectionSql>(`${CONNECTION_SELECT} where connector_code = $1 for update`, [FEED_CONNECTOR_CODE]);
    const before = connectionOf(locked[0] as ConnectionSql);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = feedConnectionMove(before, move);
    await tx.query(
      `update machvon.finance_feed_connection set enabled = $2, state_reason = $3, state_changed_by = $4::uuid, state_changed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp(), updated_by = $4::uuid
        where id = $1::uuid`,
      [before.id, decided.enabled, decided.reason, actor],
    );
    await this.event(tx, before.id as string, decided.enabled ? 'ENABLED' : 'DISABLED', decided.reason, null, actor, before.version + 1);
    return { before, row: await this.current(tx) };
  }

  /**
   * Applies a decision of the generator's life (start, stop, reseed, tick) to the connection (a versioned command): the state, the epoch and the parameters it runs with (the anchors, when it was started on projects
   * of ours, are kept beside them), and the event with its reason.
   */
  async applyGenerator(
    tx: TenantTx,
    expectedVersion: number,
    step: { action: FeedGeneratorAction; decision: FeedGeneratorDecision; anchors: unknown[] | undefined },
    actor: string,
  ): Promise<{ before: FeedConnectionRow; row: FeedConnectionRow }> {
    const locked = await tx.query<ConnectionSql>(`${CONNECTION_SELECT} where connector_code = $1 for update`, [FEED_CONNECTOR_CODE]);
    const before = connectionOf(locked[0] as ConnectionSql);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const params = step.decision.params === null ? before.generatorParams : { ...feedGeneratorParamsJson(step.decision.params), anchors: step.anchors ?? before.generatorParams?.anchors ?? [] };
    await tx.query(
      `update machvon.finance_feed_connection set generator_state = $2, generator_epoch = $3, generator_params = $4::jsonb, version = version + 1, updated_at = clock_timestamp(), updated_by = $5::uuid where id = $1::uuid`,
      [before.id, step.decision.state, step.decision.epoch, params === null ? null : JSON.stringify(params), actor],
    );
    const action = { START: 'GENERATOR_STARTED', STOP: 'GENERATOR_STOPPED', RESEED: 'GENERATOR_RESEEDED', TICK: 'GENERATOR_TICKED' }[step.action];
    await this.event(tx, before.id as string, action, step.decision.reason, step.decision.params === null ? null : feedGeneratorParamsJson(step.decision.params), actor, before.version + 1);
    return { before, row: await this.current(tx) };
  }

  private async event(tx: TenantTx, connectionId: string, action: string, reason: string, detail: Record<string, unknown> | null, actor: string, version: number): Promise<void> {
    await tx.query(
      `insert into machvon.finance_feed_connection_event (tenant_id, id, connection_id, action, reason, detail, actor_id, connection_version)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5::uuid, $6::bigint)`,
      [connectionId, action, reason, detail === null ? null : JSON.stringify(detail), actor, version],
    );
  }

  /** The newest events of the connection, for the history of the screen. */
  async events(tx: TenantTx, limit: number): Promise<Array<{ id: string; action: string; reason: string | null; detail: Record<string, unknown> | null; actorId: string; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: string; reason: string | null; detail: Record<string, unknown> | null; actor_id: string; connection_version: string; occurred_at: string }>(
      `select e.id, e.action, e.reason, e.detail, e.actor_id, e.connection_version::text as connection_version, to_char(e.occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.finance_feed_connection_event e join machvon.finance_feed_connection c on c.tenant_id = e.tenant_id and c.id = e.connection_id
        where c.connector_code = $1 order by e.connection_version desc, e.occurred_at desc, e.id desc limit $2`,
      [FEED_CONNECTOR_CODE, limit],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason, detail: row.detail, actorId: row.actor_id, version: Number(row.connection_version), occurredAt: row.occurred_at }));
  }

  /** The four positions of the file import with what each last did (a position never used shows nulls, never "fine"). */
  async positions(tx: TenantTx): Promise<FeedPositionRow[]> {
    const rows = await tx.query<{ connector_code: string; status: string; last_success_at: string | null; last_error_code: string | null; last_file_sha256: string | null }>(
      `select connector_code, status, to_char(last_success_at at time zone 'UTC', ${ISO}) as last_success_at, last_error_code, last_file_sha256
         from machvon.integration_cursor where connector_code = any($1::text[]) and source_scope = 'DEFAULT'`,
      [[...POSITION_CODES]],
    );
    return FEED_KINDS.map((kind) => {
      const found = rows.find((row) => row.connector_code === FEED_POSITIONS[kind]);
      return { kind, connectorCode: FEED_POSITIONS[kind], cursorStatus: found?.status ?? null, lastSuccessAt: found?.last_success_at ?? null, lastErrorCode: found?.last_error_code ?? null, lastFileSha256: found?.last_file_sha256 ?? null };
    });
  }

  async lastRuns(tx: TenantTx, limit: number): Promise<FeedRunRow[]> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} order by created_at desc, id desc limit $1`, [limit]);
    return rows.map(runOf);
  }

  async listRuns(tx: TenantTx, request: { channel?: FeedChannel | undefined; kind?: FeedKind | undefined; limit: number; after: { key: string; id: string } | undefined }): Promise<FeedRunRow[]> {
    const rows = await tx.query<RunSql>(
      `${RUN_SELECT}
        where ($1::text is null or channel = $1) and ($2::text is null or kind = $2) and ($3::text is null or (${timestampKey('created_at')}, id) < ($3::text, $4::uuid))
        order by created_at desc, id desc limit $5`,
      [request.channel ?? null, request.kind ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(runOf);
  }

  async findRun(tx: TenantTx, id: string): Promise<FeedRunRow | undefined> {
    const rows = await tx.query<RunSql>(`${RUN_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : runOf(rows[0]);
  }

  /** The time the last run was applied, whichever channel (the source of the age). */
  async lastRun(tx: TenantTx): Promise<{ at: Date; channel: FeedChannel } | undefined> {
    const rows = await tx.query<{ created_at: string; channel: FeedChannel }>('select created_at, channel from machvon.finance_feed_run order by created_at desc, id desc limit 1');
    const row = rows[0];
    return row === undefined ? undefined : { at: new Date(row.created_at), channel: row.channel };
  }

  /** How many records the store holds of each kind, in the current epoch of the generator. */
  async recordCounts(tx: TenantTx, generatorEpoch: number): Promise<Record<FeedKind, number>> {
    const rows = await tx.query<{ kind: FeedKind; n: string }>("select kind, count(*)::text as n from machvon.finance_feed_record where channel <> 'GENERATOR' or epoch = $1 group by kind", [generatorEpoch]);
    const counts = { PROJECT: 0, PLAN: 0, DISBURSEMENT: 0, MILESTONE: 0 } as Record<FeedKind, number>;
    for (const row of rows) counts[row.kind] = Number(row.n);
    return counts;
  }

  /** The freshness rule and the policy in force today (a tenant rule, else the built-in default with its source, its as-of day and `legalStatus` UNVERIFIED). */
  async rules(tx: TenantTx, now: Date): Promise<{ freshness: FeedHealthReading['freshness']; policy: FeedHealthReading['policy'] }> {
    const freshRule = await this.policy.require(tx, FEED_FRESHNESS_RULE_TYPE, FEED_FRESHNESS_RULE_CODE, now);
    const policyRule = await this.policy.require(tx, FEED_POLICY_RULE_TYPE, FEED_POLICY_RULE_CODE, now);
    return {
      freshness: { ...provenanceOf(freshRule), params: feedFreshnessParamsOf(freshRule.params as unknown as Readonly<Record<string, unknown>>) },
      policy: { ...provenanceOf(policyRule), params: feedPolicyOf(policyRule.params as unknown as Readonly<Record<string, unknown>>) },
    };
  }

  /** The health the screen shows and the alert source reads: the age of the last run against the freshness rule, the status, the alert, and whether the figures are blocked. */
  async health(tx: TenantTx, now: Date, connection: FeedConnectionRow): Promise<FeedHealthReading> {
    const { freshness, policy } = await this.rules(tx, now);
    const last = await this.lastRun(tx);
    const health = feedConnectorHealth({ lastRunAt: last?.at ?? null, now, params: freshness.params, layoutVersion: connection.layoutVersion, adapterStatus: 'PROPOSED' });
    return { health, lastRunAt: last === undefined ? null : last.at.toISOString(), lastRunChannel: last?.channel ?? null, freshness, policy };
  }

  /** The layout a request names, judged before the file is opened (422 `FEED_LAYOUT_VERSION_UNKNOWN`); without one, the layout of the connection. */
  layoutOf(requested: string | undefined, connection: FeedConnectionRow): string {
    return assertFeedLayoutKnown(requested ?? connection.layoutVersion);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The columns of a record that the store indexes, read off the typed record. */
export function feedColumnsOf(one: FeedRecord): { code: string; fiscalYear: number | null; month: number | null; fund: string | null } {
  const body = one.record as unknown as Record<string, unknown>;
  return {
    code: String(body.feedProjectCode),
    fiscalYear: typeof body.fiscalYear === 'number' ? body.fiscalYear : null,
    month: typeof body.month === 'number' ? body.month : null,
    fund: typeof body.fundCode === 'string' ? body.fundCode : null,
  };
}

export const feedRowHashOf = (one: FeedRecord): string => sha256Hex(canonicalJson([one.kind, one.businessKey, one.record]));

export interface NewFeedRun {
  channel: FeedChannel;
  kind: FeedKind | null;
  action: 'APPLY' | 'GENERATOR_START' | 'GENERATOR_RESEED' | 'GENERATOR_TICK';
  layoutVersion: string;
  records: readonly FeedRecord[];
  rejected: number;
  epoch: number;
  seed?: number | undefined;
  parameters?: Record<string, unknown> | undefined;
  fileSha256?: string | undefined;
  fileImportId?: string | undefined;
  digest?: string | undefined;
  counts?: { total: number; written: number; skipped: number; rejected: number } | undefined;
}

/** The record store: append-only statements of the Finance Department, whatever the channel; and the runs that brought them. */
export class FeedRecordStore {
  /** Inserts records under one origin (a run, or the import of a file). A business key already held is left alone (the first statement stands). Returns how many were new. */
  async insert(tx: TenantTx, records: readonly FeedRecord[], origin: { channel: FeedChannel; epoch: number; runId: string | null; importId: string | null; layoutVersion: string; actor: string }): Promise<number> {
    let written = 0;
    for (let start = 0; start < records.length; start += CHUNK) {
      const chunk = records.slice(start, start + CHUNK);
      const columns = chunk.map(feedColumnsOf);
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.finance_feed_record (tenant_id, id, channel, epoch, run_id, import_id, kind, entity_key, business_key, as_of, feed_project_code, fiscal_year, month, fund_code, layout_version, row_hash, record, applied_by)
         select ${TENANT}, gen_random_uuid(), $1, $2::int, $3::uuid, $4::uuid, t.kind, t.entity_key, t.business_key, t.as_of::date, t.code, t.fiscal_year::int, t.month::int, t.fund, $5, t.row_hash, t.record::jsonb, $6::uuid
           from unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[])
                as t(kind, entity_key, business_key, as_of, code, fiscal_year, month, fund, row_hash, record)
         on conflict (tenant_id, channel, epoch, kind, business_key) do nothing returning id`,
        [
          origin.channel,
          origin.epoch,
          origin.runId,
          origin.importId,
          origin.layoutVersion,
          origin.actor,
          chunk.map((one) => one.kind),
          chunk.map((one) => one.entityKey),
          chunk.map((one) => one.businessKey),
          chunk.map((one) => one.asOf),
          columns.map((one) => one.code),
          columns.map((one) => (one.fiscalYear === null ? null : String(one.fiscalYear))),
          columns.map((one) => (one.month === null ? null : String(one.month))),
          columns.map((one) => one.fund),
          chunk.map(feedRowHashOf),
          chunk.map((one) => JSON.stringify(one.record)),
        ],
      );
      written += inserted.length;
    }
    return written;
  }

  /** The business keys of a batch that the store already holds under the same channel and epoch, so a run can say how many records were new before it writes the run row. */
  async held(tx: TenantTx, records: readonly FeedRecord[], channel: FeedChannel, epoch: number): Promise<Set<string>> {
    const held = new Set<string>();
    for (let start = 0; start < records.length; start += CHUNK) {
      const chunk = records.slice(start, start + CHUNK);
      const rows = await tx.query<{ kind: string; business_key: string }>(
        `select r.kind, r.business_key from machvon.finance_feed_record r join unnest($1::text[], $2::text[]) as t(kind, business_key) on t.kind = r.kind and t.business_key = r.business_key where r.channel = $3 and r.epoch = $4`,
        [chunk.map((one) => one.kind), chunk.map((one) => one.businessKey), channel, epoch],
      );
      for (const row of rows) held.add(`${row.kind}|${row.business_key}`);
    }
    return held;
  }

  /** Writes a run of a channel that is not a file (a generator move, a push): the run row first, then the records that are new, under its id. The run row says how many were new and how many were already held. */
  async writeRun(tx: TenantTx, run: NewFeedRun, actor: string): Promise<{ runId: string; written: number; skipped: number }> {
    const held = await this.held(tx, run.records, run.channel, run.epoch);
    const fresh = run.records.filter((one) => !held.has(`${one.kind}|${one.businessKey}`));
    const asOfLatest = run.records.reduce<string | null>((latest, one) => (latest === null || one.asOf > latest ? one.asOf : latest), null);
    const runId = randomUUID();
    await tx.query(
      `insert into machvon.finance_feed_run (tenant_id, id, channel, kind, action, layout_version, file_sha256, file_import_id, seed, epoch, parameters, records_total, records_written, records_skipped, rows_rejected, as_of_latest, digest, imported_by)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::bigint, $9::int, $10::jsonb, $11, $12, $13, $14, $15::date, $16, $17::uuid)`,
      [runId, run.channel, run.kind, run.action, run.layoutVersion, run.fileSha256 ?? null, run.fileImportId ?? null, run.seed ?? null, run.epoch, run.parameters === undefined ? null : JSON.stringify(run.parameters), run.records.length, fresh.length, run.records.length - fresh.length, run.rejected, asOfLatest, run.digest ?? null, actor],
    );
    const written = await this.insert(tx, fresh, { channel: run.channel, epoch: run.epoch, runId, importId: null, layoutVersion: run.layoutVersion, actor });
    // The hub learns of every run that does not pass through the file framework (a push, a move of the generator); the feed keeps its own history and its behaviour does not change.
    const at = new Date();
    const known = run.kind !== null && run.layoutVersion === FEED_LAYOUT_VERSION;
    await new HubRunPort().report(
      tx,
      FEED_CONNECTOR_CODE,
      {
        kind: run.channel === 'GENERATOR' ? 'GENERATE' : 'IMPORT',
        outcome: 'SUCCEEDED',
        startedAt: at,
        finishedAt: at,
        ...(known ? { layoutCode: run.kind as string, layoutVersion: run.layoutVersion } : {}),
        rowsTotal: run.records.length + run.rejected,
        rowsApplied: written,
        rowsRejected: run.rejected,
        sourceRef: `feed-run:${runId}`,
      },
      actor,
    );
    return { runId, written, skipped: run.records.length - written };
  }

  /** Writes the run row of a file after the framework applied it (its records already carry the import id). */
  async writeFileRun(tx: TenantTx, input: { kind: FeedKind; layoutVersion: string; fileSha256: string; importId: string; counts: { total: number; written: number; skipped: number; rejected: number }; asOfLatest: string | null }, actor: string): Promise<string> {
    const runId = randomUUID();
    await tx.query(
      `insert into machvon.finance_feed_run (tenant_id, id, channel, kind, action, layout_version, file_sha256, file_import_id, epoch, records_total, records_written, records_skipped, rows_rejected, as_of_latest, imported_by)
       values (${TENANT}, $1::uuid, 'FILE', $2, 'APPLY', $3, $4, $5::uuid, 0, $6, $7, $8, $9, $10::date, $11::uuid)`,
      [runId, input.kind, input.layoutVersion, input.fileSha256, input.importId, input.counts.total, input.counts.written, input.counts.skipped, input.counts.rejected, input.asOfLatest, actor],
    );
    return runId;
  }

  /** The records a reader folds: the current epoch of the generator and every record of the other channels; the kinds asked for; a fiscal year (the project list has none). */
  async load(tx: TenantTx, filter: { generatorEpoch: number; fiscalYear: number; kinds: readonly FeedKind[] }): Promise<SourcedFeedRecord[]> {
    const rows = await tx.query<{ channel: FeedChannel; kind: FeedKind; entity_key: string; business_key: string; as_of: string; record: FeedRecord['record'] }>(
      `select channel, kind, entity_key, business_key, as_of::text as as_of, record from machvon.finance_feed_record
        where kind = any($1::text[]) and (channel <> 'GENERATOR' or epoch = $2) and (fiscal_year = $3 or fiscal_year is null)
        order by as_of, id`,
      [[...filter.kinds], filter.generatorEpoch, filter.fiscalYear],
    );
    return rows.map((row) => ({ channel: row.channel, kind: row.kind, entityKey: row.entity_key, businessKey: row.business_key, asOf: row.as_of, record: row.record }) as SourcedFeedRecord);
  }

  /** The fiscal years the store holds statements for, newest first (what a screen offers to look at). */
  async years(tx: TenantTx, generatorEpoch: number): Promise<number[]> {
    const rows = await tx.query<{ fiscal_year: number }>("select distinct fiscal_year from machvon.finance_feed_record where fiscal_year is not null and (channel <> 'GENERATOR' or epoch = $1) order by fiscal_year desc", [generatorEpoch]);
    return rows.map((row) => row.fiscal_year);
  }

  /** The milestones by kind: how many are stated, how many are done and how many are overdue (planned before `today` with no actual day), from the latest statement of each. */
  async milestoneSummary(tx: TenantTx, generatorEpoch: number, today: string): Promise<Array<{ kind: string; total: number; done: number; overdue: number }>> {
    const rows = await tx.query<{ kind: string; total: string; done: string; overdue: string }>(
      `select m.kind, count(*)::text as total, count(*) filter (where m.actual is not null)::text as done, count(*) filter (where m.actual is null and m.planned is not null and m.planned < $2::date)::text as overdue
         from (select distinct on (r.channel, r.entity_key) r.record ->> 'milestoneKind' as kind, nullif(r.record ->> 'actualOn', '')::date as actual, nullif(r.record ->> 'plannedOn', '')::date as planned
                 from machvon.finance_feed_record r where r.kind = 'MILESTONE' and (r.channel <> 'GENERATOR' or r.epoch = $1) order by r.channel, r.entity_key, r.as_of desc) m
        group by m.kind order by m.kind`,
      [generatorEpoch, today],
    );
    return rows.map((row) => ({ kind: row.kind, total: Number(row.total), done: Number(row.done), overdue: Number(row.overdue) }));
  }

  /** Our own projects that the generator can be anchored on: the plan and the disbursement reported in their latest frozen snapshot of the year. */
  async anchors(tx: TenantTx, fiscalYear: number, limit: number): Promise<Array<{ code: string; name: string; plan: string; disbursed: string | null }>> {
    const rows = await tx.query<{ code: string; name: string; plan: string; disbursed: string | null }>(
      `select p.code, p.name, sum(l.plan_total_vnd)::text as plan, sum(l.disbursed_reported_vnd)::text as disbursed
         from machvon.period_snapshot s join machvon.period_snapshot_line l on l.tenant_id = s.tenant_id and l.snapshot_id = s.id join machvon.project p on p.tenant_id = l.tenant_id and p.id = l.project_id
        where s.status = 'FROZEN' and s.as_of_date between make_date($1::int, 1, 1) and make_date($1::int, 12, 31)
          and s.id = (select s2.id from machvon.period_snapshot s2 where s2.status = 'FROZEN' and s2.snapshot_kind <> 'ENTERPRISE_CLOSE' and s2.as_of_date between make_date($1::int, 1, 1) and make_date($1::int, 12, 31) order by s2.as_of_date desc, s2.id limit 1)
        group by p.code, p.name having sum(l.plan_total_vnd) > 0 order by p.code limit $2`,
      [fiscalYear, limit],
    );
    return rows;
  }
}

/** The parameters the generator runs with, read back from the stored row (the anchors are kept beside the numbers). */
export function storedGeneratorParams(row: FeedConnectionRow, today: string): FeedGeneratorParams | null {
  const stored = row.generatorParams;
  if (stored === null) return null;
  const params = feedGeneratorParamsOf(stored, today);
  const anchors = Array.isArray(stored.anchors) ? (stored.anchors as FeedGeneratorParams['anchors']) : undefined;
  return anchors === undefined || anchors.length === 0 ? params : { ...params, anchors };
}

