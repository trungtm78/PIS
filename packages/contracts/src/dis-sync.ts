/**
 * The sync contract of the weekly report for the phone (ST-DIS-017, TK-DIS-017-1 and TK-DIS-017-2). PowerSync reads the write-ahead log, which does not go through row-level security, so the isolation of the
 * tenant on a phone is the work of these rules and of nothing else (design 04, A1). They are data: the sync rules file `infra/powersync/sync-rules.reference.yaml` and the contract pack for the mobile group
 * `docs/dis-mobile-contract.md` are written from them, a test fails when either is out of date, and the same queries are run against PostgreSQL in the tests of the API to prove what they let through.
 *
 * Status: PROPOSED, and a REFERENCE. The queries are the semantics of what a phone may receive, written in SQL so that they can be run and proven on PostgreSQL. The rule dialect of PowerSync takes a data query
 * over one table and bucket parameters only (no join, no subquery), so the file is not deployable as it is: the spike of ST-KERNEL-002 (not run) turns each relationship into a bucket parameter or a
 * replicated projection (`DIS_SYNC_TRANSLATION`), and the proof of this file is the acceptance of that translation.
 */

/** What the deployable rules need that the reference writes with a join or a subquery: each is a projection or a parameter the sync service can filter on, and each is built when the spike concludes. */
export const DIS_SYNC_TRANSLATION: readonly string[] = [
  'The scope of a member as a list of projects: `sync_membership_scope` rows of the kind `project`, one for each project the member reaches (a subtree grant is expanded by the projection job of MOB and ADM), so that the unit subtree is not a subquery of the data query.',
  'The period of a report: the status of the reporting period beside the report in a projection (`OPEN` or `SOFT_CLOSED` as a column), so that the period is not a join.',
  'The last revision handed in: a column of the projection that marks the revision of a project and period that is the latest not draft (`is_last_handed_in`), so that it is not a `NOT EXISTS`.',
  'The time of a scope row: the dialect has no clock in a query, so the projection job adds a row at its `effective_from` and ends it at its `effective_until` (the reference checks both ends with `now()`).',
  'The children of a report (cells, volumes, narrative): the same project and period columns copied to each, or a bucket parameter that lists the report ids, so that they are not joined to the report.',
];

/** The tokens a query may use: the claims of the token the backend issues (TTL up to five minutes) and the parameters of the bucket. Nothing is taken from the client. */
export const SYNC_TOKENS = {
  tenant: "request.jwt() ->> 'tenant_id'",
  membership: "request.jwt() ->> 'membership_id'",
  bucketTenant: 'bucket.tenant_id',
  bucketKind: 'bucket.scope_kind',
  bucketRef: 'bucket.scope_ref_id',
  bucketMembership: 'bucket.membership_id',
} as const;

/** The scope rows of the member, in the tenant of the token and in force now: started (`effective_from`) and not ended (`effective_until`). Revoking a grant ends its row, and the bucket is empty at the next sync. */
const SCOPE_PARAMETERS = `SELECT s.tenant_id, s.membership_id, s.scope_kind, s.scope_ref_id
FROM sync_membership_scope s
WHERE s.tenant_id = ${SYNC_TOKENS.tenant}
  AND s.membership_id = ${SYNC_TOKENS.membership}
  AND s.effective_from <= now() AND (s.effective_until IS NULL OR s.effective_until > now())
  AND s.scope_kind IN ('unit_subtree', 'project')`;

/** A project is in the scope of the bucket: named by a project scope, or owned by a unit under the unit of a subtree scope. Every table of the bucket is reached through it. */
const PROJECT_IN_SCOPE = `p.tenant_id = ${SYNC_TOKENS.bucketTenant}
  AND ((${SYNC_TOKENS.bucketKind} = 'project' AND p.id = ${SYNC_TOKENS.bucketRef})
    OR (${SYNC_TOKENS.bucketKind} = 'unit_subtree' AND p.owner_unit_id IN (
      SELECT u.id FROM organization_unit u JOIN organization_unit r ON r.tenant_id = u.tenant_id
      WHERE r.id = ${SYNC_TOKENS.bucketRef} AND u.tenant_id = ${SYNC_TOKENS.bucketTenant} AND starts_with(u.path, r.path))))`;

/**
 * What of the reports goes to the phone: of an open or soft-closed period, not deleted, the drafts the member wrote (never the drafts of others) and the last revision that was handed in (the older ones are
 * history on the server). A period that is locked takes no report and does not sync.
 */
const REPORT_IN_SCOPE = `${PROJECT_IN_SCOPE}
  AND rp.status IN ('OPEN', 'SOFT_CLOSED') AND r.deleted_at IS NULL
  AND ((r.status = 'DRAFT' AND r.created_by = ${SYNC_TOKENS.bucketMembership})
    OR (r.status <> 'DRAFT' AND NOT EXISTS (
      SELECT 1 FROM report_revision n
      WHERE n.tenant_id = r.tenant_id AND n.project_id = r.project_id AND n.period_id = r.period_id AND n.deleted_at IS NULL AND n.status <> 'DRAFT' AND n.revision > r.revision)))`;

const REPORT_FROM = `FROM report_revision r
JOIN project p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
JOIN reporting_period rp ON rp.tenant_id = r.tenant_id AND rp.id = r.period_id`;

export interface SyncColumn {
  name: string;
  /** Money is synced as text to be shown, never to be written back from the phone: the money is written through the commands only, and a conflict is for the user to resolve (no last-write-wins). */
  readOnlyMoney?: true;
}

export interface SyncTable {
  table: string;
  columns: readonly SyncColumn[];
}

const plain = (...names: string[]): SyncColumn[] => names.map((name) => ({ name }));
const money = (...names: string[]): SyncColumn[] => names.map((name) => ({ name, readOnlyMoney: true as const }));

/** The tables and columns that go to the phone: nothing else does (the amounts of the investment, the lines of the snapshots, the personal data of the households). */
export const DIS_SYNC_TABLES: readonly SyncTable[] = [
  { table: 'project', columns: plain('id', 'tenant_id', 'code', 'name', 'status', 'owner_unit_id', 'investor_unit_id', 'version') },
  { table: 'reporting_period', columns: plain('id', 'tenant_id', 'code', 'period_type', 'start_date', 'end_date', 'deadline_at', 'status') },
  {
    table: 'report_revision',
    columns: plain('id', 'tenant_id', 'project_id', 'period_id', 'plan_version_id', 'revision', 'status', 'is_current', 'version', 'report_type', 'measurement_basis', 'is_late', 'submitted_at', 'created_by'),
  },
  { table: 'funding_snapshot_line', columns: [...plain('id', 'tenant_id', 'report_revision_id', 'bucket', 'budget_level'), ...money('disbursed_cumulative_vnd', 'ctmtqg_subset_vnd', 'next_month_registered_vnd', 'next_month_ctmtqg_subset_vnd')] },
  { table: 'progress_snapshot', columns: [...plain('id', 'tenant_id', 'report_revision_id', 'measurement_basis'), ...money('construction_value_vnd', 'acceptance_value_vnd', 'treasury_submitted_value_vnd', 'preparing_dossier_value_vnd')] },
  { table: 'report_narrative', columns: plain('id', 'tenant_id', 'report_revision_id', 'results_text', 'causes_text', 'solutions_text', 'proposals_text') },
];

const columnsOf = (table: string, alias: string): string => (DIS_SYNC_TABLES.find((entry) => entry.table === table) as SyncTable).columns.map((column) => `${alias}.${column.name}`).join(', ');

export interface SyncBucket {
  name: string;
  description: string;
  parameters: string;
  /** One query for each table that goes down in the bucket, in the order of the file. */
  data: readonly { table: string; query: string }[];
}

export const DIS_SYNC_BUCKETS: readonly SyncBucket[] = [
  {
    name: 'dis_projects',
    description: 'The projects the member reports on: the rows named by their scope, in their tenant.',
    parameters: SCOPE_PARAMETERS,
    data: [{ table: 'project', query: `SELECT ${columnsOf('project', 'p')}\nFROM project p\nWHERE ${PROJECT_IN_SCOPE}` }],
  },
  {
    name: 'dis_periods',
    description: 'The reporting periods that take a report (open or soft-closed), for a member who has a scope in the tenant.',
    parameters: `SELECT DISTINCT s.tenant_id\nFROM sync_membership_scope s\nWHERE s.tenant_id = ${SYNC_TOKENS.tenant}\n  AND s.membership_id = ${SYNC_TOKENS.membership}\n  AND s.effective_from <= now() AND (s.effective_until IS NULL OR s.effective_until > now())\n  AND s.scope_kind IN ('unit_subtree', 'project')`,
    data: [{ table: 'reporting_period', query: `SELECT ${columnsOf('reporting_period', 'rp')}\nFROM reporting_period rp\nWHERE rp.tenant_id = ${SYNC_TOKENS.bucketTenant} AND rp.status IN ('OPEN', 'SOFT_CLOSED')` }],
  },
  {
    name: 'dis_reports',
    description: 'The reports of the projects in the scope: the member\'s own drafts and the last revision handed in, with their cells, volumes and narrative.',
    parameters: SCOPE_PARAMETERS,
    data: [
      { table: 'report_revision', query: `SELECT ${columnsOf('report_revision', 'r')}\n${REPORT_FROM}\nWHERE ${REPORT_IN_SCOPE}` },
      { table: 'funding_snapshot_line', query: `SELECT ${columnsOf('funding_snapshot_line', 'f')}\nFROM funding_snapshot_line f\nJOIN report_revision r ON r.tenant_id = f.tenant_id AND r.id = f.report_revision_id\nJOIN project p ON p.tenant_id = r.tenant_id AND p.id = r.project_id\nJOIN reporting_period rp ON rp.tenant_id = r.tenant_id AND rp.id = r.period_id\nWHERE ${REPORT_IN_SCOPE}` },
      { table: 'progress_snapshot', query: `SELECT ${columnsOf('progress_snapshot', 'g')}\nFROM progress_snapshot g\nJOIN report_revision r ON r.tenant_id = g.tenant_id AND r.id = g.report_revision_id\nJOIN project p ON p.tenant_id = r.tenant_id AND p.id = r.project_id\nJOIN reporting_period rp ON rp.tenant_id = r.tenant_id AND rp.id = r.period_id\nWHERE ${REPORT_IN_SCOPE}` },
      { table: 'report_narrative', query: `SELECT ${columnsOf('report_narrative', 'n')}\nFROM report_narrative n\nJOIN report_revision r ON r.tenant_id = n.tenant_id AND r.id = n.report_revision_id\nJOIN project p ON p.tenant_id = r.tenant_id AND p.id = r.project_id\nJOIN reporting_period rp ON rp.tenant_id = r.tenant_id AND rp.id = r.period_id\nWHERE ${REPORT_IN_SCOPE}` },
    ],
  },
];

const indent = (text: string, spaces: number): string => text.split('\n').map((line) => `${' '.repeat(spaces)}${line}`).join('\n');

/** The sync rules file for PowerSync, written from the buckets above. */
export function syncRulesYaml(): string {
  const parts = [
    '# GENERATED from packages/contracts/src/dis-sync.ts (ST-DIS-017). Do not edit: change the buckets there.',
    '# Status: PROPOSED REFERENCE, not deployable as it is. The queries use joins and subqueries that the PowerSync rule dialect does not take; the spike ST-KERNEL-002 (not run) translates them (see below).',
    '# The semantics are proven on PostgreSQL by apps/api/test/dis/mobile-sync.test.ts, which is the acceptance of that translation.',
    ...DIS_SYNC_TRANSLATION.map((note, index) => `# Translation ${index + 1}: ${note}`),
    '# Isolation: PowerSync reads the WAL and does not pass row-level security, so every query carries the tenant of the token and the scope of the member.',
    'bucket_definitions:',
  ];
  for (const bucket of DIS_SYNC_BUCKETS) {
    parts.push(`  ${bucket.name}:`, `    # ${bucket.description}`, '    parameters: |', indent(bucket.parameters, 6), '    data:');
    for (const entry of bucket.data) parts.push(`      - |`, indent(entry.query, 10));
  }
  return `${parts.join('\n')}\n`;
}

/** What a command does when the phone is offline: it waits in the queue and is sent with its local id, or it needs the server. */
export type OfflineMode = 'QUEUED' | 'ONLINE_ONLY';

export interface MobileCommand {
  operationId: string;
  offline: OfflineMode;
  /** Why it is online only, or what the queue must carry. */
  note: string;
}

/** The commands of the weekly report that the phone sends (MOB-13..21), with the rule of the queue for each. */
export const DIS_MOBILE_COMMANDS: readonly MobileCommand[] = [
  { operationId: 'post_reports', offline: 'QUEUED', note: 'Starts the draft. Carries `client_operation_id` (the local id): the same entries sent again are the same report, other entries under it are 409 IDEMPOTENCY_CONFLICT.' },
  { operationId: 'post_reports_id_revisions', offline: 'QUEUED', note: 'Saves a step of the draft under `If-Match` (the version the phone read). A stale version is 409 VERSION_CONFLICT: the phone reads the report again and puts the figures to the user, it never overwrites money.' },
  { operationId: 'uploadReportFile', offline: 'QUEUED', note: 'The file goes up when the phone is online; the draft links it after the scan is clean.' },
  { operationId: 'post_reports_id_submit', offline: 'QUEUED', note: 'Hands the draft in (the version of the last save). Whether the report is late is judged by the server at the time it arrives, not by the clock of the phone.' },
  { operationId: 'deleteDraftReport', offline: 'QUEUED', note: 'Deletes a draft softly, with a reason.' },
  { operationId: 'restoreDraftReport', offline: 'ONLINE_ONLY', note: 'The list of deleted drafts is on the server.' },
  { operationId: 'withdrawReport', offline: 'ONLINE_ONLY', note: 'A report that was handed in is withdrawn only while the server says nobody is reviewing it.' },
  { operationId: 'post_reports_id_corrections', offline: 'ONLINE_ONLY', note: 'A correction starts from the report the server accepted.' },
];

/** The rules of the queue of the phone, in the words of the design (04, A1) and the module (MOB). */
export const DIS_MOBILE_RULES: readonly string[] = [
  'Every queued command carries the id of the tenant it was made under. When the person switches tenant or logs out, a command of the old tenant is never sent under the new one: the switch waits until the queue is sent or the person cancels, and the local database, keys and file cache of the old tenant are removed.',
  'The `Idempotency-Key` of a command is its local id, and a command sent again with the same key and the same body gets the same answer. A key is kept by the server for seven days.',
  'Money is shown from the server and written only through the commands above. There is no last-write-wins for money: a conflict (409 VERSION_CONFLICT, 409 IDEMPOTENCY_CONFLICT) is put to the user with both figures.',
  'The phone judges nothing the server judges: the period, the late mark, the plan version in force and the scope of the person come back with the answer.',
  'A person whose grant is revoked loses the rows at the next sync (the scope row is ended); a command that was queued before is refused with 403 SCOPE_DENIED or 404 when it is sent.',
];

interface OperationFacts {
  method: string;
  path: string;
  permission: string;
  errors: readonly string[];
}

/** The facts of an operation, read from the OpenAPI document; undefined when the document does not have it. */
export function operationFacts(spec: { paths: Record<string, Record<string, Record<string, unknown>>> }, operationId: string): OperationFacts | undefined {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === operationId) {
        return { method: method.toUpperCase(), path, permission: String(operation['x-permission'] ?? ''), errors: Array.isArray(operation['x-error-codes']) ? (operation['x-error-codes'] as string[]) : [] };
      }
    }
  }
  return undefined;
}

/** The contract pack for the mobile group, written from the commands above and the OpenAPI document. */
export function mobileContractMarkdown(spec: { paths: Record<string, Record<string, Record<string, unknown>>> }): string {
  const lines: string[] = [
    '<!-- GENERATED from packages/contracts/src/dis-sync.ts and openapi.json (ST-DIS-017). Do not edit: change the source and run the generator; a test fails when this file is out of date. -->',
    '# Contract pack of the weekly report for the mobile group (MOB-13..21)',
    '',
    'Status: PROPOSED. The offline architecture (PowerSync, the Flutter queue) waits for the spikes of ST-KERNEL-002 and the mobile group; what is fixed here is the server side: the commands, the headers, the errors and the rows that sync.',
    '',
    '## Commands',
    '',
    '| operationId | Method and path | Permission | Offline | Errors | Rule |',
    '|---|---|---|---|---|---|',
  ];
  for (const command of DIS_MOBILE_COMMANDS) {
    const facts = operationFacts(spec, command.operationId);
    if (facts === undefined) throw new Error(`the contract pack names ${command.operationId}, which the OpenAPI document does not have`);
    lines.push(`| \`${command.operationId}\` | \`${facts.method} ${facts.path}\` | \`${facts.permission}\` | ${command.offline === 'QUEUED' ? 'queued' : 'online only'} | ${facts.errors.length === 0 ? '—' : facts.errors.map((code) => `\`${code}\``).join(', ')} | ${command.note} |`);
  }
  lines.push(
    '',
    'Every command is sent with `Idempotency-Key` (at least 16 characters; the local id), and a change of a versioned draft with `If-Match` (the version the phone read, as a strong ETag). The body of a draft is the DTO `ReportDraft` of the OpenAPI document, the same for the web and the phone.',
    '',
    '## Rows that sync',
    '',
    'Only these tables and columns go to the phone. Money columns are read only on the phone. The lines of the snapshots (`period_snapshot_line`), the amounts of the investment of a project and the personal data of households do not sync.',
    '',
  );
  for (const table of DIS_SYNC_TABLES) {
    lines.push(`- \`${table.table}\`: ${table.columns.map((column) => (column.readOnlyMoney === true ? `\`${column.name}\` (read only)` : `\`${column.name}\``)).join(', ')}`);
  }
  lines.push('', '## Buckets', '');
  for (const bucket of DIS_SYNC_BUCKETS) lines.push(`- \`${bucket.name}\`: ${bucket.description}`);
  lines.push('', 'The queries are in `infra/powersync/sync-rules.reference.yaml`: a reference for what may sync, proven on PostgreSQL, not the deployable file (the PowerSync dialect takes no join and no subquery). To be translated when the spike concludes:', '');
  for (const note of DIS_SYNC_TRANSLATION) lines.push(`- ${note}`);
  lines.push('', 'A token carries `sub`, `tenant_id`, `membership_id` and `scope_version`; nothing about permission is taken from a parameter of the client.', '', '## Rules of the queue', '');
  for (const rule of DIS_MOBILE_RULES) lines.push(`- ${rule}`);
  return `${lines.join('\n')}\n`;
}

/** A query with its tokens replaced by values: only for the tests that run the queries on PostgreSQL. Every value is a uuid, checked here. */
export function bindSyncQuery(query: string, values: Partial<Record<keyof typeof SYNC_TOKENS, string>>): string {
  let bound = query;
  for (const [name, value] of Object.entries(values)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^(unit_subtree|project|contract)$/i.test(value)) throw new Error(`the value of ${name} is not a uuid or a scope kind`);
    const token = SYNC_TOKENS[name as keyof typeof SYNC_TOKENS];
    bound = bound.split(token).join(/^[0-9a-f-]{36}$/i.test(value) ? `'${value}'::uuid` : `'${value}'`);
  }
  return bound;
}
