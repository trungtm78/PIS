import { DomainError, canonicalJson, sha256Hex } from '@machvon/kernel';
import type { CrosscheckRow, FigureEntry, FigureSet, FormPeriod, SnapshotRevisionRef } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The store of the comparison of reports before release (ENT-4a, docs/report-engine.md, section "Cross-report comparison"): the figures a draft was filled with (insert-only), the explanations of findings (insert-only, one per fingerprint, the
 * explainer prepared none of the reports involved), the evidence kept with an issued copy, and the candidates the comparison reads: for each form and period the head issued copy, else the newest open draft. The
 * rules are the kernel's (`compareReports`, `gateOf`); the database keeps the people rule and the insert-only rule as well with a trigger and a revoke.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface FigureSetRow {
  draftId: string;
  set: FigureSet;
  sha256: string;
}

/** The hash of a figure set: what is recorded next to it, and what a test compares. */
export const figureSetSha256 = (set: FigureSet): string => sha256Hex(canonicalJson({ figures: set.figures, rows: set.rows }));

export interface CandidateRow {
  kind: 'DRAFT' | 'ISSUE';
  /** The id of the draft (kind DRAFT) or of the issued copy (kind ISSUE). */
  id: string;
  draftId: string;
  layoutCode: string;
  periodCode: string;
  period: FormPeriod;
  revision: number | null;
  state: string;
  dataSource: 'LIVE' | 'ILLUSTRATIVE';
  preparedBy: string;
  snapshotRef: SnapshotRevisionRef | null;
}

interface CandidateSql {
  kind: 'DRAFT' | 'ISSUE';
  id: string;
  draft_id: string;
  layout_code: string;
  period_code: string;
  period: FormPeriod;
  revision: number | null;
  state: string;
  data_source: 'LIVE' | 'ILLUSTRATIVE';
  prepared_by: string;
  snapshot_ref: SnapshotRevisionRef | null;
}

export interface ExplanationRow {
  id: string;
  fingerprint: string;
  ruleId: string;
  figureCode: string;
  periodCode: string;
  severity: 'BLOCKING' | 'WARNING';
  involves: string[];
  reason: string;
  explainedBy: string;
  createdAt: string;
}

interface ExplanationSql {
  id: string;
  fingerprint: string;
  rule_id: string;
  figure_code: string;
  period_code: string;
  severity: 'BLOCKING' | 'WARNING';
  involves: string[];
  reason: string;
  explained_by: string;
  created_at: string;
}

const EXPLANATION_SELECT = `select id, fingerprint, rule_id, figure_code, period_code, severity, involves, reason, explained_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at from machvon.report_crosscheck_explanation`;

const explanationOf = (row: ExplanationSql): ExplanationRow => ({
  id: row.id,
  fingerprint: row.fingerprint.trim(),
  ruleId: row.rule_id,
  figureCode: row.figure_code,
  periodCode: row.period_code,
  severity: row.severity,
  involves: row.involves,
  reason: row.reason,
  explainedBy: row.explained_by,
  createdAt: row.created_at,
});

export interface NewExplanation {
  fingerprint: string;
  ruleId: string;
  figureCode: string;
  periodCode: string;
  severity: 'BLOCKING' | 'WARNING';
  involves: readonly string[];
  reason: string;
  explainedBy: string;
}

export interface NewRelease {
  issueId: string;
  draftId: string;
  periodCode: string;
  resultSha256: string;
  comparisons: number;
  skipped: number;
  warnings: number;
  explainedFingerprints: readonly string[];
  releasedBy: string;
}

export interface ReleaseRow {
  id: string;
  issueId: string;
  draftId: string;
  periodCode: string;
  outcome: 'PASSED' | 'EXPLAINED';
  resultSha256: string;
  comparisons: number;
  skipped: number;
  blockingExplained: number;
  warnings: number;
  explainedFingerprints: string[];
  releasedBy: string;
  createdAt: string;
}

interface ReleaseSql {
  id: string;
  issue_id: string;
  draft_id: string;
  period_code: string;
  outcome: 'PASSED' | 'EXPLAINED';
  result_sha256: string;
  comparisons: number;
  skipped: number;
  blocking_explained: number;
  warnings: number;
  explained_fingerprints: string[];
  released_by: string;
  created_at: string;
}

const RELEASE_SELECT = `select id, issue_id, draft_id, period_code, outcome, result_sha256, comparisons, skipped, blocking_explained, warnings, explained_fingerprints, released_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at from machvon.report_crosscheck_release`;

const releaseOf = (row: ReleaseSql): ReleaseRow => ({
  id: row.id,
  issueId: row.issue_id,
  draftId: row.draft_id,
  periodCode: row.period_code,
  outcome: row.outcome,
  resultSha256: row.result_sha256.trim(),
  comparisons: row.comparisons,
  skipped: row.skipped,
  blockingExplained: row.blocking_explained,
  warnings: row.warnings,
  explainedFingerprints: row.explained_fingerprints,
  releasedBy: row.released_by,
  createdAt: row.created_at,
});

export class ReportCrosscheckStore {
  // -- the figures of a draft -------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Records the figures a draft was filled with; a second record of the same draft changes nothing. */
  async recordFigureSet(tx: TenantTx, draftId: string, set: FigureSet): Promise<string> {
    const sha = figureSetSha256(set);
    await tx.query(
      `insert into machvon.report_figure_set (tenant_id, draft_id, figures, rows, sha256)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::jsonb, $3::jsonb, $4)
       on conflict (tenant_id, draft_id) do nothing`,
      [draftId, JSON.stringify(set.figures), JSON.stringify(set.rows), sha],
    );
    return sha;
  }

  async figureSets(tx: TenantTx, draftIds: readonly string[]): Promise<Map<string, FigureSetRow>> {
    const found = new Map<string, FigureSetRow>();
    if (draftIds.length === 0) return found;
    const rows = await tx.query<{ draft_id: string; figures: FigureEntry[]; rows: CrosscheckRow[]; sha256: string }>('select draft_id, figures, rows, sha256 from machvon.report_figure_set where draft_id = any($1::uuid[])', [[...draftIds]]);
    for (const row of rows) found.set(row.draft_id, { draftId: row.draft_id, set: { figures: row.figures, rows: row.rows }, sha256: row.sha256.trim() });
    return found;
  }

  // -- the reports to compare -------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * For every form and period asked, the report the comparison reads: the head issued copy (the newest revision), else the newest draft that is not issued. `pinned` is the draft about to be released: it stands
   * for its own form and period whatever else exists, because it is the one whose figures are going out.
   */
  async candidates(tx: TenantTx, layoutCodes: readonly string[], periodCodes: readonly string[], pinned?: string): Promise<CandidateRow[]> {
    if (layoutCodes.length === 0 || periodCodes.length === 0) return [];
    const rows = await tx.query<CandidateSql>(
      `select * from (
         select distinct on (layout_code, period_code) 'ISSUE' as kind, id, draft_id, layout_code, period_code, period, revision, 'ISSUED' as state, data_source, prepared_by, snapshot_ref, 0 as rank
           from machvon.report_issue where layout_code = any($1::text[]) and period_code = any($2::text[])
          order by layout_code, period_code, revision desc
       ) heads
       union all
       select * from (
         select distinct on (layout_code, period_code) 'DRAFT' as kind, id, id as draft_id, layout_code, period_code, period, null::integer as revision, state, data_source, prepared_by, snapshot_ref, 1 as rank
           from machvon.report_draft where state <> 'ISSUED' and layout_code = any($1::text[]) and period_code = any($2::text[])
          order by layout_code, period_code, created_at desc, id desc
       ) open_drafts
       union all
       select 'DRAFT' as kind, id, id as draft_id, layout_code, period_code, period, null::integer as revision, state, data_source, prepared_by, snapshot_ref, -1 as rank
         from machvon.report_draft where id = $3::uuid and layout_code = any($1::text[]) and period_code = any($2::text[])`,
      [[...layoutCodes], [...periodCodes], pinned ?? null],
    );
    const best = new Map<string, CandidateSql & { rank: number }>();
    for (const row of rows as Array<CandidateSql & { rank: number }>) {
      const key = `${row.layout_code}|${row.period_code}`;
      const held = best.get(key);
      if (held === undefined || row.rank < held.rank) best.set(key, row);
    }
    return [...best.values()]
      .map((row): CandidateRow => ({ kind: row.kind, id: row.id, draftId: row.draft_id, layoutCode: row.layout_code, periodCode: row.period_code, period: row.period, revision: row.revision, state: row.state, dataSource: row.data_source, preparedBy: row.prepared_by, snapshotRef: row.snapshot_ref }))
      .sort((one, two) => one.layoutCode.localeCompare(two.layoutCode) || one.periodCode.localeCompare(two.periodCode));
  }

  // -- the explanations -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The explanations given for these fingerprints (all of them when none is named). */
  async explanations(tx: TenantTx, filter: { fingerprints?: readonly string[]; periodCode?: string; limit?: number } = {}): Promise<ExplanationRow[]> {
    const rows = await tx.query<ExplanationSql>(
      `${EXPLANATION_SELECT} where ($1::text[] is null or fingerprint = any($1::text[])) and ($2::text is null or period_code = $2) order by created_at desc, id desc limit $3`,
      [filter.fingerprints === undefined ? null : [...filter.fingerprints], filter.periodCode ?? null, Math.min(filter.limit ?? 200, 500)],
    );
    return rows.map(explanationOf);
  }

  /**
   * Records an explanation. One explanation holds for one fingerprint: a second call for the same fingerprint, by anyone, returns the first and records nothing (`EXISTING`). The database refuses an explainer who
   * prepared a report named in `involves` (42501), which the caller turns into SELF_APPROVAL_DENIED; the check is made here as well so the answer is the same without relying on the trigger.
   */
  async explain(tx: TenantTx, input: NewExplanation): Promise<{ outcome: 'CREATED' | 'EXISTING'; row: ExplanationRow }> {
    const [held] = await tx.query<ExplanationSql>(`${EXPLANATION_SELECT} where fingerprint = $1`, [input.fingerprint]);
    if (held !== undefined) return { outcome: 'EXISTING', row: explanationOf(held) };
    const [own] = await tx.query<{ n: string }>(
      `select (select count(*) from machvon.report_draft where id = any($1::uuid[]) and prepared_by = $2) + (select count(*) from machvon.report_issue where id = any($1::uuid[]) and prepared_by = $2) as n`,
      [[...input.involves], input.explainedBy],
    );
    if (own !== undefined && Number(own.n) > 0) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'explainer');
    const [made] = await tx.query<ExplanationSql>(
      `insert into machvon.report_crosscheck_explanation (tenant_id, fingerprint, rule_id, figure_code, period_code, severity, involves, reason, explained_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6::uuid[], $7, $8)
       on conflict (tenant_id, fingerprint) do nothing
       returning id, fingerprint, rule_id, figure_code, period_code, severity, involves, reason, explained_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at`,
      [input.fingerprint, input.ruleId, input.figureCode, input.periodCode, input.severity, [...input.involves], input.reason, input.explainedBy],
    );
    if (made !== undefined) return { outcome: 'CREATED', row: explanationOf(made) };
    // A concurrent call recorded it between the read and the insert: that one stands.
    const [raced] = await tx.query<ExplanationSql>(`${EXPLANATION_SELECT} where fingerprint = $1`, [input.fingerprint]);
    return { outcome: 'EXISTING', row: explanationOf(raced as ExplanationSql) };
  }

  // -- the evidence of a release ----------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Keeps what was compared when a copy was released; one per issued copy, a second call returns the first. */
  async recordRelease(tx: TenantTx, input: NewRelease): Promise<ReleaseRow> {
    const outcome = input.explainedFingerprints.length > 0 ? 'EXPLAINED' : 'PASSED';
    const [made] = await tx.query<ReleaseSql>(
      `insert into machvon.report_crosscheck_release (tenant_id, issue_id, draft_id, period_code, outcome, result_sha256, comparisons, skipped, blocking_explained, warnings, explained_fingerprints, released_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11)
       on conflict (tenant_id, issue_id) do nothing
       returning id, issue_id, draft_id, period_code, outcome, result_sha256, comparisons, skipped, blocking_explained, warnings, explained_fingerprints, released_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at`,
      [input.issueId, input.draftId, input.periodCode, outcome, input.resultSha256, input.comparisons, input.skipped, input.explainedFingerprints.length, input.warnings, [...input.explainedFingerprints], input.releasedBy],
    );
    if (made !== undefined) return releaseOf(made);
    const [held] = await tx.query<ReleaseSql>(`${RELEASE_SELECT} where issue_id = $1`, [input.issueId]);
    return releaseOf(held as ReleaseSql);
  }

  async releaseOfIssue(tx: TenantTx, issueId: string): Promise<ReleaseRow | undefined> {
    const [row] = await tx.query<ReleaseSql>(`${RELEASE_SELECT} where issue_id = $1`, [issueId]);
    return row === undefined ? undefined : releaseOf(row);
  }
}
