import { BidWorkflowReads, GovernancePolicyPort, ReportStore } from '@machvon/db';
import type { ReportDeliveryRow, ReportDraftRow, ReportIssueRow, ReportLayoutRow, TenantTx } from '@machvon/db';
import { PERMISSIONS } from '@machvon/contracts';
import { DEMO_MARK, REPORT_FORM_MODE_RULE_TYPE, demoFormsOn, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, FormPeriod, LayoutStatus, ReportFormBundle } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';

/** What the controllers of the report engine share: the demo-mode switch, the shapes of the answers and the file naming rule. */

const people = new BidWorkflowReads();
const policy = new GovernancePolicyPort();
export const reportStore = new ReportStore();

/**
 * Whether demo forms may be issued now (R18): the environment variable `DEMO_FORMS`, else the rule `REPORT_FORM_MODE` (`demo_forms`) of the tenant, else off. The rule type exists only when the enterprise
 * rule pack is registered, so it is read only when a DEMO form is in question; a public process never asks.
 */
export async function demoModeOf(tx: TenantTx, today: string, layoutStatus: LayoutStatus | 'ANY'): Promise<boolean> {
  const env = process.env;
  const fromEnvironment = env.DEMO_FORMS;
  if (fromEnvironment !== undefined && fromEnvironment.trim() !== '') return demoFormsOn({ env });
  if (layoutStatus !== 'DEMO' && layoutStatus !== 'ANY') return false;
  let params: Record<string, unknown> | undefined;
  try {
    params = (await policy.get(tx, REPORT_FORM_MODE_RULE_TYPE, 'DEFAULT', today))?.params;
  } catch {
    // The rule type is not registered in this process (a public edition): there is no rule to read, demo forms are off.
    return false;
  }
  return demoFormsOn({ env, ruleParams: params });
}

export const officialOf = (status: LayoutStatus, formRef: string | null): Schemas['RptCatalogueEntry']['official'] => (status === 'DEMO' ? 'PENDING_EXTERNAL' : status === 'READY' && formRef !== null ? 'CONFIRMED' : 'NOT_APPLICABLE');

export function periodDto(period: FormPeriod): Schemas['RptPeriod'] {
  return { kind: period.kind, year: period.year, ...(period.index === undefined ? {} : { index: period.index }), ...(period.day === undefined ? {} : { day: period.day }) };
}

/** `receiver` is the one the tenant's report catalogue gives the form (MD.03); absent, the bundle's own. */
export function catalogueEntryDto(bundle: ReportFormBundle, registered: ReportLayoutRow | undefined, demoMode: boolean, receiver: string = bundle.receiver): Schemas['RptCatalogueEntry'] {
  const layout = bundle.layout;
  return {
    code: layout.code,
    name: layout.name,
    version: layout.version,
    edition: bundle.edition,
    status: layout.status,
    official: officialOf(layout.status, layout.formRef),
    form_ref: layout.formRef,
    receiver,
    period_kind: bundle.periodKind,
    has_narrative: bundle.narrative !== null,
    data_source: bundle.dataSource,
    demo_mark: layout.status === 'DEMO' ? DEMO_MARK : null,
    registered: registered !== undefined && registered.version === layout.version,
    issuable: layout.status === 'READY' || (layout.status === 'DEMO' && demoMode),
    whole_tenant: bundle.dataSource === 'LIVE',
  };
}

type Names = Map<string, string>;
const nameOf = (names: Names, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export interface ViewContext {
  tx: TenantTx;
  access: EffectiveAccess;
  membershipId: string;
  now: Date;
  today: string;
}

const fileDtos = (xlsx: string, docx: string | null, pdf: string | null, sizes: Map<string, number>, names: { xlsx: string | null; docx: string | null; pdf: string | null }): Schemas['RptFileInfo'][] => [
  { format: 'XLSX', sha256: xlsx, name: names.xlsx, size_bytes: sizes.get(xlsx) ?? 0 },
  ...(docx === null ? [] : [{ format: 'DOCX' as const, sha256: docx, name: names.docx, size_bytes: sizes.get(docx) ?? 0 }]),
  ...(pdf === null ? [] : [{ format: 'PDF' as const, sha256: pdf, name: names.pdf, size_bytes: sizes.get(pdf) ?? 0 }]),
];

const snapshotDto = (ref: { snapshotId: string; revision: number; cutoff: string } | null): Schemas['RptSnapshotRef'] | null => (ref === null ? null : { snapshot_id: ref.snapshotId, revision: ref.revision, cutoff: ref.cutoff });

/** Drafts as the screens read them. The single read carries the preview and the cells the data could not fill. */
export async function draftDtos(context: ViewContext, rows: readonly ReportDraftRow[], detail: boolean): Promise<Schemas['RptDraft'][]> {
  const { tx } = context;
  const held = effectivePermissions(context.access, context.now);
  const layouts = await reportStore.layoutsByIds(tx, rows.map((row) => row.layoutId));
  const sizes = await reportStore.outputSizes(tx, rows.flatMap((row) => [row.xlsxSha256, ...(row.docxSha256 === null ? [] : [row.docxSha256]), ...(row.pdfSha256 === null ? [] : [row.pdfSha256])]));
  const names = await people.names(tx, rows.flatMap((row) => [row.preparedBy, row.checkedBy, row.approvedBy]));
  const demoOff = new Map<string, boolean>();
  for (const row of rows) {
    if (row.marks.formStatus === 'DEMO' && !demoOff.has('DEMO')) demoOff.set('DEMO', !(await demoModeOf(tx, context.today, 'DEMO')));
  }
  const result: Schemas['RptDraft'][] = [];
  for (const row of rows) {
    const mine = context.membershipId;
    const demoForbidden = row.marks.formStatus === 'DEMO' && demoOff.get('DEMO') === true;
    result.push({
      id: row.id,
      layout_code: row.layoutCode,
      layout_version: row.layoutVersion,
      layout_name: layouts.get(row.layoutId)?.name ?? row.layoutCode,
      period_code: row.periodCode,
      period: periodDto(row.period),
      state: row.state,
      base_revision: row.baseRevision,
      reason: row.reason,
      package_sha256: row.packageSha256,
      files: fileDtos(row.xlsxSha256, row.docxSha256, row.pdfSha256, sizes, { xlsx: null, docx: null, pdf: null }),
      layout_sha256: row.layoutSha256,
      data_source: row.dataSource,
      form_status: row.marks.formStatus,
      demo_mark: row.marks.demoMark,
      snapshot: snapshotDto(row.snapshotRef),
      issue_count: row.gridIssues.length,
      prepared_by: row.preparedBy,
      prepared_by_name: nameOf(names, row.preparedBy),
      checked_by_name: nameOf(names, row.checkedBy),
      approved_by_name: nameOf(names, row.approvedBy),
      issue_id: row.issueId,
      version: row.version,
      created_at: row.createdAt,
      can_check: row.state === 'DRAFT' && holdsPermission(held, PERMISSIONS.checkReport) && mine !== row.preparedBy,
      can_approve: row.state === 'CHECKED' && holdsPermission(held, PERMISSIONS.approveReport) && mine !== row.preparedBy && mine !== row.checkedBy,
      can_issue: row.state === 'APPROVED' && holdsPermission(held, PERMISSIONS.issueReport) && mine === row.approvedBy && !demoForbidden,
      demo_forms_off: demoForbidden,
      preview: detail ? ((await reportStore.draftPreview(tx, row.id)) as Schemas['RptPreview']) : null,
      issues: detail ? row.gridIssues : [],
    });
  }
  return result;
}

const deliveryDto = (row: ReportDeliveryRow, names: Names): Schemas['RptDelivery'] => ({
  id: row.id,
  issue_id: row.issueId,
  layout_code: row.layoutCode,
  period_code: row.periodCode,
  revision: row.revision,
  sha256: row.sha256,
  receiver: row.receiver,
  channel: row.channel as Schemas['RptDelivery']['channel'],
  event: row.event,
  reference: row.reference,
  note: row.note,
  counts_as_accepted: row.countsAsAccepted,
  recorded_by_name: nameOf(names, row.recordedBy),
  occurred_at: row.occurredAt,
});

export async function deliveryDtos(context: Pick<ViewContext, 'tx'>, rows: readonly ReportDeliveryRow[]): Promise<Schemas['RptDelivery'][]> {
  const names = await people.names(context.tx, rows.map((row) => row.recordedBy));
  return rows.map((row) => deliveryDto(row, names));
}

/** Issued copies as the screens read them. The single read carries the chain of the series, the deliveries and the cells the data could not fill. */
export async function issueDtos(context: ViewContext, rows: readonly ReportIssueRow[], detail: boolean): Promise<Schemas['RptIssue'][]> {
  const { tx } = context;
  const held = effectivePermissions(context.access, context.now);
  const layouts = await reportStore.layoutsByIds(tx, rows.map((row) => row.layoutId));
  const heads = await reportStore.headRevisions(tx, rows);
  const sizes = await reportStore.outputSizes(tx, rows.flatMap((row) => [row.xlsxSha256, ...(row.docxSha256 === null ? [] : [row.docxSha256]), ...(row.pdfSha256 === null ? [] : [row.pdfSha256])]));
  const names = await people.names(tx, rows.flatMap((row) => [row.preparedBy, row.checkedBy, row.approvedBy, row.issuedBy]));
  const result: Schemas['RptIssue'][] = [];
  for (const row of rows) {
    const current = heads.get(`${row.layoutCode}|${row.periodCode}`) ?? row.revision;
    const chain = detail ? await reportStore.series(tx, row.layoutCode, row.periodCode) : [];
    const deliveries = detail ? await reportStore.deliveriesOf(tx, row.id) : [];
    result.push({
      id: row.id,
      layout_code: row.layoutCode,
      layout_version: row.layoutVersion,
      layout_name: layouts.get(row.layoutId)?.name ?? row.layoutCode,
      period_code: row.periodCode,
      period: periodDto(row.period),
      revision: row.revision,
      supersedes_id: row.supersedesId,
      reason: row.reason,
      sha256: row.sha256,
      files: fileDtos(row.xlsxSha256, row.docxSha256, row.pdfSha256, sizes, { xlsx: row.xlsxName, docx: row.docxName, pdf: row.pdfName }),
      layout_sha256: row.layoutSha256,
      data_source: row.dataSource,
      form_status: row.formStatus,
      demo_mark: row.demoMark,
      counts_as_accepted: row.countsAsAccepted,
      snapshot: snapshotDto(row.snapshotRef),
      issue_count: row.gridIssues.length,
      prepared_by_name: nameOf(names, row.preparedBy),
      checked_by_name: nameOf(names, row.checkedBy),
      approved_by_name: nameOf(names, row.approvedBy),
      issued_by_name: nameOf(names, row.issuedBy),
      issued_at: row.issuedAt,
      is_current: row.revision === current,
      current_revision: current,
      chain: chain.map((link) => ({ id: link.id, revision: link.revision, sha256: link.sha256, issued_at: link.issuedAt, reason: link.reason })),
      deliveries: await deliveryDtos(context, deliveries),
      issues: detail ? row.gridIssues : [],
      can_deliver: holdsPermission(held, PERMISSIONS.deliverReport) && row.revision === current,
      can_answer: holdsPermission(held, PERMISSIONS.answerReportDelivery) && row.countsAsAccepted,
    });
  }
  return result;
}
