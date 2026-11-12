import { asObj, vnd } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';

/**
 * The rest of the capital chapter (CAP) of the enterprise demo, beyond the plan of the year (enterprise-capital.ts): the medium-term plan 2027-2030 with its approval trail and an
 * adjustment still in draft (CAP-01, CAP-02, CAP-10), the policy of availability control (CAP-17), the earmarks of capital for pending contracts (CAP-18), simulations of a
 * transfer of capital (CAP-09), the proposals to move capital from slow to fast projects (CAP-19, CAP-23), the requests to extend disbursement (CAP-20) and the closing of
 * the previous years (CAP-11). Every step uses the commands of the product, asks what exists first and skips it, and never applies a transfer: the plan of the year
 * (KHV-2026 revision 2, 1.534 billion) and every figure of the dashboards stay as they are.
 */

const BOARD = 'Hội đồng thành viên Tổng công ty';
const PLAN_2026 = 'KHV-2026';
const MID_PLAN = 'KHV-TH-2027-2030';
const MID_FROM = 2027;
const MID_TO = 2030;

/** Ceilings (billions) the board gives to each year of the medium term, by class of capital: equity (EQUITY) and commercial loan (LOAN). */
const CEILINGS: ReadonlyArray<{ year: number; equity: number; loan: number }> = [
  { year: 2027, equity: 760, loan: 790 },
  { year: 2028, equity: 560, loan: 640 },
  { year: 2029, equity: 380, loan: 410 },
  { year: 2030, equity: 210, loan: 230 },
];

/** Lines of the medium-term plan: project, then [equity, loan] in billions for 2027, 2028, 2029, 2030. Totals stay under each ceiling: the rest is kept for the new projects. */
const MID_LINES: ReadonlyArray<{ project: string; years: ReadonlyArray<readonly [number, number]> }> = [
  { project: 'DA-PMDT105', years: [[120, 110], [40, 30]] },
  { project: 'DA-PMDT114', years: [[90, 60], [50, 40]] },
  { project: 'DA-PMDT120', years: [[110, 115], [80, 70], [30, 30]] },
  { project: 'DA-PMDT130', years: [[150, 190], [120, 140], [90, 110], [40, 50]] },
  { project: 'DA-PMDT137', years: [[100, 120], [90, 100], [70, 80], [30, 40]] },
  { project: 'DA-PMTB164', years: [[15, 12]] },
  { project: 'DA-PMTB168', years: [[25, 40], [20, 30]] },
  { project: 'DA-PMTB172', years: [[30, 35], [25, 30], [20, 20]] },
  { project: 'DA-PMTB180', years: [[25, 40], [20, 30]] },
  { project: 'DA-PMTB191', years: [[8, 6], [12, 10], [6, 4]] },
];

/** Runs a part and goes on when it is refused: the other parts do not depend on it, and the refusal is written in the warnings of the run. */
async function part(ctx: SeedContext, module: string, title: string, run: () => Promise<void>): Promise<void> {
  try {
    await ctx.step(module, title, run);
  } catch (error) {
    ctx.warn(`${title}: left out (${error instanceof Error ? error.message.slice(0, 400) : String(error)})`);
  }
}

async function plansOf(ctx: SeedContext): Promise<Obj[]> {
  return ctx.list<Obj>('capApprover', '/resources/plan_version');
}

// ---- medium-term plan -------------------------------------------------------------------------------------------------------------------------------------------------

/** The ceilings of 2027-2030: one decision of the board per class of capital, one assignment per year, registered by the planner and published by the approver. */
async function ensureCeilings(ctx: SeedContext): Promise<Map<string, string>> {
  const funds = new Map((await ctx.list<Obj>('projectManager', '/master-records', { master_type: 'FUND_SOURCE' })).map((row) => [String(row.business_key), String(row.version_id)]));
  const classes = [
    { key: 'EQUITY', fund: 'NSDP-DTPT', symbol: '131/QĐ-HĐTV', title: 'Quyết định về việc giao trần vốn chủ sở hữu đầu tư giai đoạn 2027-2030' },
    { key: 'LOAN', fund: 'ODA-ONLEND', symbol: '132/QĐ-HĐTV', title: 'Quyết định về việc giao trần vốn vay thương mại đầu tư giai đoạn 2027-2030' },
  ] as const;
  const existing = await ctx.list<Obj>('projectManager', '/appropriations');
  const ids = new Map<string, string>();
  for (const cls of classes) {
    let letter: { documentId: string } | undefined;
    for (const ceiling of CEILINGS) {
      const key = `${cls.key}|${ceiling.year}`;
      let row = existing.find((item) => Number(item.plan_year) === ceiling.year && asObj(item.fund_source).business_key === cls.fund && item.origin === 'BOARD_APPROVED');
      if (row === undefined) {
        letter ??= await ctx.letter({ symbol: cls.symbol, title: cls.title, issuedOn: ctx.day(-24), sender: BOARD, docType: 'QD' });
        const created = await ctx.command('projectManager', '/appropriations', {
          fund_source_version_id: funds.get(cls.fund),
          plan_year: ceiling.year,
          origin: 'BOARD_APPROVED',
          budget_level: 'ALL',
          decision_kind: 'COMPANY_DECISION',
          amount_vnd: vnd(cls.key === 'EQUITY' ? ceiling.equity : ceiling.loan),
          decision_document_id: letter.documentId,
          issuing_authority: BOARD,
          source_year: ceiling.year,
        });
        row = { id: created.resource_id, status: created.status, version: created.resource_version };
      }
      if (row.status === 'DRAFT') {
        await ctx.command('capApprover', `/appropriations/${String(row.id)}/decision`, { decision: 'approve', reason: `Phê duyệt trần vốn năm ${ceiling.year} theo ${cls.symbol} của Hội đồng thành viên.` }, { version: Number(row.version) });
      }
      ids.set(key, String(row.id));
    }
  }
  return ids;
}

async function projectIds(ctx: SeedContext): Promise<Map<string, string>> {
  return new Map((await ctx.list<Obj>('projectManager', '/resources/project')).map((row) => [String(row.code), String(row.id)]));
}

function midLinesBody(projects: Map<string, string>, ceilings: Map<string, string>): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const spec of MID_LINES) {
    spec.years.forEach((pair, index) => {
      const year = MID_FROM + index;
      const classes: ReadonlyArray<readonly ['EQUITY' | 'LOAN', number]> = [['EQUITY', pair[0]], ['LOAN', pair[1]]];
      for (const [bucket, billions] of classes) {
        lines.push({ project_id: projects.get(spec.project), appropriation_id: ceilings.get(`${bucket}|${year}`), bucket, source_year: year, amount_vnd: vnd(billions) });
      }
    });
  }
  return lines;
}

/** The medium-term plan 2027-2030: drafted, submitted, approved by the approver and published with the decision of the board. */
async function seedMidTermPlan(ctx: SeedContext): Promise<void> {
  const ceilings = await ensureCeilings(ctx);
  const projects = await projectIds(ctx);
  const all = await plansOf(ctx);
  const base = all.find((plan) => plan.plan_code === PLAN_2026 && Number(plan.revision) === 2) ?? all.find((plan) => plan.plan_code === PLAN_2026);
  if (base === undefined) throw new Error(`the plan ${PLAN_2026} does not exist`);
  let plan = all.filter((item) => item.plan_code === MID_PLAN).sort((a, b) => Number(a.revision) - Number(b.revision))[0];
  if (plan === undefined) {
    const created = await ctx.command('projectManager', '/capital-plans', { plan_code: MID_PLAN, plan_kind: 'MEDIUM_TERM', period_from_year: MID_FROM, period_to_year: MID_TO, scope_unit_id: asObj(base.scope_unit).id });
    plan = (await plansOf(ctx)).find((item) => item.id === created.resource_id) ?? { id: created.resource_id, status: 'DRAFT', version: 1 };
  }
  let current = plan;
  if (current.status === 'DRAFT' && Number(asObj(current.totals).line_count ?? 0) === 0) {
    const reply = await ctx.command('projectManager', `/capital-plans/${String(current.id)}/allocations`, { lines: midLinesBody(projects, ceilings), note: 'Phân bổ trần vốn trung hạn 2027-2030 theo tiến độ từng dự án; phần trần còn lại giữ cho các dự án mới.' }, { version: Number(current.version) });
    current = { ...current, version: reply.resource_version };
  }
  if (current.status === 'DRAFT') {
    const submitted = await ctx.command('projectManager', `/capital-plans/${String(current.id)}/submit`, {}, { version: Number(current.version) });
    current = { ...current, status: submitted.status, version: submitted.resource_version };
  }
  if (current.status === 'IN_REVIEW') {
    const decided = await ctx.command('capApprover', `/capital-plans/${String(current.id)}/decision`, { decision: 'approve', reason: 'Kế hoạch trung hạn phù hợp chiến lược đầu tư giai đoạn 2026-2030 và trần vốn đã được Hội đồng thành viên giao.' }, { version: Number(current.version) });
    current = { ...current, status: decided.status, version: decided.resource_version };
  }
  if (current.status === 'APPROVED') {
    const decision = await ctx.letter({ symbol: '133/QĐ-HĐTV', title: 'Quyết định về việc phê duyệt kế hoạch vốn đầu tư trung hạn giai đoạn 2027-2030 của Tổng công ty', issuedOn: ctx.day(-18), sender: BOARD, docType: 'QD' });
    await ctx.command('capApprover', `/plans/${String(current.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(current.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-01', kind: 'capital-plan', id: String(current.id), code: MID_PLAN, note: 'medium-term plan 2027-2030 published' });
}

/** A revision of the medium-term plan left in draft: the planner moves capital between two years of a project; it is what CAP-02 (proposal) and CAP-10 (approval) show. */
async function seedMidTermDraft(ctx: SeedContext): Promise<void> {
  const revisions = (await plansOf(ctx)).filter((item) => item.plan_code === MID_PLAN).sort((a, b) => Number(a.revision) - Number(b.revision));
  const published = revisions.find((item) => item.status === 'PUBLISHED');
  if (published === undefined) {
    ctx.warn(`the plan ${MID_PLAN} is not published: its draft adjustment is left out`);
    return;
  }
  let draft = revisions.find((item) => Number(item.revision) > Number(published.revision));
  if (draft === undefined) {
    const created = await ctx.command('projectManager', `/capital-plans/${String(published.id)}/revisions`, { reason: 'Điều chỉnh kế hoạch trung hạn: dãn tiến độ giải ngân dự án Hệ thống xử lý khí thải sang năm 2029 do chờ nghiệm thu thiết bị nhập khẩu.' }, { version: Number(published.version) });
    draft = { id: created.resource_id, status: created.status, version: created.resource_version, revision: Number(published.revision) + 1 };
  }
  if (draft.status !== 'DRAFT') return;
  // The amounts come from the published revision, so a second run writes the same figures and changes nothing.
  const lines = await ctx.list<Obj>('projectManager', `/capital-plans/${String(published.id)}/lines`);  const find = (project: string, year: number, bucket: string): Obj | undefined => lines.find((line) => asObj(line.project).code === project && Number(line.source_year) === year && line.bucket === bucket);
  const moves: Array<Record<string, unknown>> = [];
  const shifts: ReadonlyArray<{ project: string; bucket: 'EQUITY' | 'LOAN'; from: number; to: number; billions: number }> = [
    { project: 'DA-PMDT120', bucket: 'EQUITY', from: 2028, to: 2029, billions: 20 },
    { project: 'DA-PMDT120', bucket: 'LOAN', from: 2028, to: 2029, billions: 15 },
  ];
  for (const shift of shifts) {
    const source = find(shift.project, shift.from, shift.bucket);
    const target = find(shift.project, shift.to, shift.bucket);
    if (source === undefined || target === undefined) continue;
    const delta = BigInt(vnd(shift.billions));
    const body = (line: Obj, amount: bigint): Record<string, unknown> => ({ project_id: asObj(line.project).id, appropriation_id: asObj(line.appropriation).id, bucket: line.bucket, source_year: line.source_year, amount_vnd: amount.toString() });
    moves.push(body(source, BigInt(String(source.amount_vnd)) - delta), body(target, BigInt(String(target.amount_vnd)) + delta));
  }
  if (moves.length === 0) return;
  await ctx.command('projectManager', `/capital-plans/${String(draft.id)}/allocations`, { lines: moves, note: 'Dãn tiến độ DA-PMDT120 từ 2028 sang 2029 (20 tỷ vốn chủ sở hữu, 15 tỷ vốn vay), chờ Hội đồng thành viên xem xét.' }, { version: Number(draft.version) });
  ctx.record({ module: 'CAP', screen: 'CAP-02', kind: 'capital-plan-draft', id: String(draft.id), code: MID_PLAN, note: 'revision in draft' });
}

// ---- plan of the year: lines, snapshot ------------------------------------------------------------------------------------------------------------------------------

/** The published revision of the plan of the year and its lines by project code and class. */
async function yearLines(ctx: SeedContext): Promise<{ plan: Obj; lines: Map<string, Obj> }> {
  const published = (await plansOf(ctx)).filter((plan) => plan.plan_code === PLAN_2026 && plan.status === 'PUBLISHED').sort((a, b) => Number(a.revision) - Number(b.revision)).pop();
  if (published === undefined) throw new Error(`the plan ${PLAN_2026} is not published`);
  const lines = new Map<string, Obj>();
  for (const line of await ctx.list<Obj>('capApprover', `/capital-plans/${String(published.id)}/lines`)) lines.set(`${String(asObj(line.project).code)}|${String(line.bucket)}`, line);
  return { plan: published, lines };
}

/** The frozen snapshot of disbursement the transfers rest on (the one the candidates of CAP-23 name). */
async function basisSnapshot(ctx: SeedContext): Promise<string> {
  const candidates = await ctx.get<Obj>('capApprover', '/reallocation-candidates');
  return String(candidates.snapshot_id);
}

function lineOf(lines: Map<string, Obj>, project: string, bucket: string): Obj {
  const line = lines.get(`${project}|${bucket}`);
  if (line === undefined) throw new Error(`the plan of the year has no ${bucket} line for ${project}`);
  return line;
}

// ---- availability control (CAP-17) ------------------------------------------------------------------------------------------------------------------------------------

async function seedAvcPolicies(ctx: SeedContext): Promise<void> {
  const have = new Set((await ctx.list<Obj>('owner', '/avc-policies')).map((row) => String(row.policy_code)));
  const policies: Array<Record<string, unknown>> = [
    {
      policy_code: 'AVC-DPM-01',
      scope_kind: 'TENANT',
      control_object: 'ALLOCATION_LINE',
      warn_pct: '85',
      block_pct: '100',
      include_reservations: true,
      legal_basis: 'Quy chế quản lý và kiểm soát vốn đầu tư của Tổng công ty: cảnh báo khi dòng vốn kế hoạch dùng hết 85%, chặn khi vượt 100% kế hoạch được giao.',
      effective_from: `${ctx.year}-01-01`,
    },
    {
      policy_code: 'AVC-DPM-02',
      scope_kind: 'FUND_SOURCE',
      scope_value: 'ODA-ONLEND',
      control_object: 'ALLOCATION_LINE',
      warn_pct: '80',
      block_pct: '95',
      include_reservations: true,
      legal_basis: 'Điều kiện giải ngân của hợp đồng tín dụng vay thương mại: vốn vay phải giữ lại tối thiểu 5% hạn mức mỗi dòng để xử lý phát sinh trước khi tất toán khoản vay.',
      effective_from: `${ctx.year}-01-01`,
    },
  ];
  for (const policy of policies) {
    if (have.has(String(policy.policy_code))) continue;
    const created = await ctx.command('owner', '/avc-policies', policy);
    await ctx.command('capApprover', `/avc-policies/${created.resource_id}/publish`, {}, { version: Number(created.resource_version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-17', kind: 'avc-policy', id: 'AVC-DPM', code: 'AVC-DPM-01/02', note: 'two policies published' });
}

// ---- earmarks (CAP-18) ------------------------------------------------------------------------------------------------------------------------------------------------

interface ReservationSpec {
  project: string;
  bucket: 'EQUITY' | 'LOAN';
  billions: number;
  purpose: 'CONTRACT_PENDING' | 'ADVANCE_PENDING' | 'OTHER';
  daysToExpire: number;
  referenceKind: string;
  /** Package code the earmark is for (the tender package of the same code names the reference). */
  reference: string;
  release?: string;
}

const RESERVATIONS: readonly ReservationSpec[] = [
  // The equity line of DA-PMDT105 is almost used up by its three signed contracts, so the main equipment package draws on the loan line.
  { project: 'DA-PMDT105', bucket: 'LOAN', billions: 66.5, purpose: 'CONTRACT_PENDING', daysToExpire: 45, referenceKind: 'BID_PACKAGE', reference: 'PMDT105-TB01' },
  { project: 'DA-PMDT114', bucket: 'EQUITY', billions: 8, purpose: 'CONTRACT_PENDING', daysToExpire: 45, referenceKind: 'BID_PACKAGE', reference: 'PMDT114-TB01' },
  { project: 'DA-PMDT114', bucket: 'LOAN', billions: 12.5, purpose: 'CONTRACT_PENDING', daysToExpire: 45, referenceKind: 'BID_PACKAGE', reference: 'PMDT114-TB01' },
  { project: 'DA-PMTB164', bucket: 'EQUITY', billions: 2, purpose: 'OTHER', daysToExpire: 30, referenceKind: 'BID_PACKAGE', reference: 'PMTB164-TB02' },
  { project: 'DA-PMDT120', bucket: 'LOAN', billions: 10, purpose: 'CONTRACT_PENDING', daysToExpire: 20, referenceKind: 'BID_PACKAGE', reference: 'PMDT120-TB01' },
  { project: 'DA-PMDT114', bucket: 'LOAN', billions: 5, purpose: 'ADVANCE_PENDING', daysToExpire: 15, referenceKind: 'CONTRACT', reference: 'HD-PMDT114-XL02' },
  { project: 'DA-PMDT105', bucket: 'LOAN', billions: 3, purpose: 'ADVANCE_PENDING', daysToExpire: 12, referenceKind: 'CONTRACT', reference: 'HD-PMDT105-XL01' },
  { project: 'DA-PMDT130', bucket: 'EQUITY', billions: 15, purpose: 'CONTRACT_PENDING', daysToExpire: 25, referenceKind: 'BID_PACKAGE', reference: 'PMDT130-TB01', release: 'Gói thiết bị được điều chỉnh phạm vi và dời sang kế hoạch 2027, trả lại vốn về dòng kế hoạch năm 2026.' },
];

async function seedReservations(ctx: SeedContext): Promise<void> {
  const { lines } = await yearLines(ctx);
  const existing = await ctx.list<Obj>('projectManager', '/fund-reservations');
  const packages = new Map((await ctx.list<Obj>('projectManager', '/resources/procurement_package')).map((row) => [String(row.code), String(row.id)]));
  const contracts = new Map((await ctx.list<Obj>('projectManager', '/resources/contract')).map((row) => [String(row.code), String(row.id)]));
  for (const spec of RESERVATIONS) {
    const line = lineOf(lines, spec.project, spec.bucket);
    const amount = BigInt(Math.round(spec.billions * 1000)) * 1_000_000n;
    const referenceId = (spec.referenceKind === 'CONTRACT' ? contracts : packages).get(spec.reference);
    if (referenceId === undefined) {
      ctx.warn(`the ${spec.referenceKind} ${spec.reference} does not exist: its earmark is left out`);
      continue;
    }
    if (existing.some((row) => String(row.reference_id) === referenceId && String(row.allocation_line_id) === String(line.id) && String(row.amount_vnd) === amount.toString())) continue;
    const made = await ctx.command('projectManager', '/fund-reservations', {
      allocation_line_id: String(line.id),
      amount_vnd: amount.toString(),
      purpose: spec.purpose,
      reference_kind: spec.referenceKind,
      reference_id: referenceId,
      expires_at: new Date(ctx.asOf.getTime() + spec.daysToExpire * 86_400_000).toISOString(),
      avc_acknowledged: true,
    });
    if (spec.release !== undefined) await ctx.command('projectManager', `/fund-reservations/${made.resource_id}/release`, { reason: spec.release }, { version: Number(made.resource_version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-18', kind: 'fund-reservation', id: 'RES', code: 'giữ vốn', note: `${RESERVATIONS.length} earmarks, one released` });
}

// ---- simulations (CAP-09) ---------------------------------------------------------------------------------------------------------------------------------------------

interface ScenarioSpec {
  code: string;
  moves: ReadonlyArray<{ from: string; bucket: 'EQUITY' | 'LOAN'; to: string; billions: number; rationale: string }>;
  constraints: { min_remaining_vnd?: string; max_move_vnd?: string; max_total_vnd?: string };
  run: boolean;
  promote: boolean;
}

const SCENARIOS: readonly ScenarioSpec[] = [
  {
    code: 'KB-2026-01',
    moves: [{ from: 'DA-PMDT130', bucket: 'EQUITY', to: 'DA-PMDT120', billions: 10, rationale: 'Khu đóng bao chờ giấy phép nhập khẩu thiết bị, chuyển vốn sang hệ thống xử lý khí thải đang giải ngân nhanh.' }],
    constraints: { min_remaining_vnd: vnd(100), max_move_vnd: vnd(20), max_total_vnd: vnd(30) },
    run: true,
    promote: false,
  },
  {
    code: 'KB-2026-02',
    moves: [
      { from: 'DA-PMTB180', bucket: 'LOAN', to: 'DA-PMTB168', billions: 5, rationale: 'Mua sắm máy biến áp chờ ký hợp đồng, nhường vốn vay cho gói thiết bị đã vào giai đoạn thanh toán.' },
      { from: 'DA-PMDT137', bucket: 'EQUITY', to: 'DA-PMDT114', billions: 8, rationale: 'Dự án nhà máy phụ trợ chưa khởi công phần chính, nhường vốn chủ sở hữu cho dự án đang thi công.' },
    ],
    constraints: { min_remaining_vnd: vnd(20), max_move_vnd: vnd(10), max_total_vnd: vnd(15) },
    run: true,
    promote: true,
  },
  {
    code: 'KB-2026-03',
    moves: [{ from: 'DA-PMTB172', bucket: 'EQUITY', to: 'DA-PMTB164', billions: 4, rationale: 'Phương án dự phòng nếu gói phụ tùng máy nén khí phải mua gấp trước Tết.' }],
    constraints: { max_move_vnd: vnd(5) },
    run: false,
    promote: false,
  },
];

async function seedScenarios(ctx: SeedContext): Promise<void> {
  const { plan, lines } = await yearLines(ctx);
  const snapshot = await basisSnapshot(ctx);
  const have = new Map((await ctx.list<Obj>('projectManager', '/allocation-scenarios')).map((row) => [String(row.code), row]));
  const projects = await projectIds(ctx);
  for (const spec of SCENARIOS) {
    let row = have.get(spec.code);
    if (row === undefined) {
      const created = await ctx.command('projectManager', '/allocation-scenarios', {
        code: spec.code,
        plan_year: 2026,
        base_capital_plan_id: String(plan.id),
        input_snapshot_id: snapshot,
        constraints: spec.constraints,
        assumptions: { moves: spec.moves.map((move) => ({ from_allocation_line_id: String(lineOf(lines, move.from, move.bucket).id), to_project_id: projects.get(move.to), amount_vnd: vnd(move.billions), rationale: move.rationale })) },
      });
      row = { id: created.resource_id, status: created.status, version: created.resource_version };
    }
    if (spec.run && row.status === 'DRAFT') {
      const run = await ctx.command('projectManager', `/allocation-scenarios/${String(row.id)}/run`, {}, { version: Number(row.version) });
      row = { ...row, status: run.status, version: run.resource_version };
    }
    if (spec.promote && row.status === 'RUN') await ctx.command('projectManager', `/allocation-scenarios/${String(row.id)}/promote`, {}, { version: Number(row.version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-09', kind: 'allocation-scenario', id: 'KB-2026', code: 'KB-2026-01..03', note: 'three scenarios' });
}

// ---- proposals to move capital (CAP-19, CAP-23) -----------------------------------------------------------------------------------------------------------------------

interface ProposalSpec {
  code: string;
  reason: string;
  moves: ScenarioSpec['moves'];
  /** How far the proposal goes: drafted only, submitted, approved (never applied: the plan of the year stays as it is), or rejected. */
  stage: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  decisionReason?: string;
}

const PROPOSALS: readonly ProposalSpec[] = [
  {
    code: 'DC-2026-01',
    reason: 'Điều chuyển vốn giữa các dự án theo tiến độ giải ngân quý IV năm 2026: nhường vốn từ dự án chậm cho dự án đang giải ngân vượt kế hoạch.',
    moves: [{ from: 'DA-PMTB172', bucket: 'LOAN', to: 'DA-PMTB168', billions: 6, rationale: 'Dự án mua sắm chờ nghiệm thu mẫu thử, ước giải ngân cuối năm thấp hơn kế hoạch.' }],
    stage: 'APPROVED',
    decisionReason: 'Đồng ý điều chuyển; đề nghị theo dõi hợp đồng bổ sung của dự án nhận vốn.',
  },
  {
    code: 'DC-2026-02',
    reason: 'Đề xuất điều chuyển vốn chủ sở hữu giữa hai dự án đầu tư xây dựng để không dồn thanh toán vào tháng 12.',
    moves: [{ from: 'DA-PMDT137', bucket: 'EQUITY', to: 'DA-PMDT120', billions: 12, rationale: 'Dự án nhà máy phụ trợ chưa khởi công phần chính, hạng mục xử lý khí thải đang cần vốn thanh toán.' }],
    stage: 'SUBMITTED',
  },
  {
    code: 'DC-2026-03',
    reason: 'Đề xuất rút vốn vay của dự án chưa ký hợp đồng để bổ sung cho dự án thi công.',
    moves: [{ from: 'DA-PMTB180', bucket: 'LOAN', to: 'DA-PMDT114', billions: 10, rationale: 'Dự án mua sắm biến áp chưa chọn được nhà thầu.' }],
    stage: 'REJECTED',
    decisionReason: 'Chưa chấp thuận: dự án nhường vốn còn hợp đồng sắp ký trong quý, giữ nguyên kế hoạch.',
  },
  {
    code: 'DC-2026-04',
    reason: 'Phương án điều chuyển nhỏ giữa hai dự án mua sắm, đang soạn thảo chờ số liệu ước giải ngân tháng 12.',
    moves: [{ from: 'DA-PMTB191', bucket: 'EQUITY', to: 'DA-PMTB180', billions: 2, rationale: 'Dự án nâng cấp hệ thống đo lường chưa đến đợt thanh toán.' }],
    stage: 'DRAFT',
  },
];

async function seedReallocations(ctx: SeedContext): Promise<void> {
  const { plan, lines } = await yearLines(ctx);
  const snapshot = await basisSnapshot(ctx);
  const projects = await projectIds(ctx);
  const have = new Map((await ctx.list<Obj>('projectManager', '/reallocation-proposals')).map((row) => [String(row.code), row]));
  for (const spec of PROPOSALS) {
    let row = have.get(spec.code);
    if (row === undefined) {
      const created = await ctx.command('projectManager', '/reallocation-proposals', {
        code: spec.code,
        plan_year: 2026,
        scope_unit_id: asObj(plan.scope_unit).id,
        basis_snapshot_id: snapshot,
        source_capital_plan_id: String(plan.id),
        reason: spec.reason,
        lines: spec.moves.map((move) => ({ from_allocation_line_id: String(lineOf(lines, move.from, move.bucket).id), to_project_id: projects.get(move.to), amount_vnd: vnd(move.billions), rationale: move.rationale })),
      });
      row = { id: created.resource_id, status: created.status, version: created.resource_version };
    }
    if (spec.stage === 'DRAFT' || row.status !== 'DRAFT') continue;
    const submitted = await ctx.command('projectManager', `/reallocation-proposals/${String(row.id)}/submit`, {}, { version: Number(row.version) });
    if (spec.stage === 'SUBMITTED') continue;
    await ctx.command('capApprover', `/reallocation-proposals/${String(row.id)}/decision`, { decision: spec.stage === 'APPROVED' ? 'approve' : 'reject', reason: spec.decisionReason ?? '' }, { version: Number(submitted.resource_version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-19', kind: 'reallocation-proposal', id: 'DC-2026', code: 'DC-2026-01..04', note: 'four proposals, none applied' });
}

// ---- extension of disbursement (CAP-20) -------------------------------------------------------------------------------------------------------------------------------

async function seedExtensions(ctx: SeedContext): Promise<void> {
  const { lines } = await yearLines(ctx);
  const have = await ctx.list<Obj>('projectManager', '/allocation-extensions');
  const requests: ReadonlyArray<{ project: string; bucket: 'EQUITY' | 'LOAN'; billions: number; to: string; code: 'VUONG_MAC_PHAP_LY' | 'KHAC'; why: string; reject?: string }> = [
    { project: 'DA-PMDT114', bucket: 'LOAN', billions: 10, to: `${ctx.year + 1}-06-30`, code: 'VUONG_MAC_PHAP_LY', why: 'Hồ sơ thẩm duyệt phòng cháy chữa cháy bổ sung của hạng mục lắp đặt thiết bị chưa được cơ quan có thẩm quyền phê duyệt, chưa thể nghiệm thu để thanh toán trong năm.' },
    { project: 'DA-PMDT130', bucket: 'EQUITY', billions: 15, to: `${ctx.year + 1}-03-31`, code: 'KHAC', why: 'Thiết bị nhập khẩu giao chậm so với tiến độ hợp đồng do nhà sản xuất lùi lịch xuất xưởng; dự kiến nghiệm thu quý I năm sau.' },
    { project: 'DA-PMTB180', bucket: 'LOAN', billions: 12, to: `${ctx.year + 1}-03-31`, code: 'KHAC', why: 'Dự án chưa hoàn tất lựa chọn nhà thầu mua sắm máy biến áp.', reject: 'Không chấp thuận: dự án chưa ký hợp đồng nên không đủ điều kiện kéo dài thời gian giải ngân; đề nghị điều chỉnh kế hoạch vốn.' },
  ];
  for (const request of requests) {
    const line = lineOf(lines, request.project, request.bucket);
    if (have.some((row) => String(row.allocation_line_id) === String(line.id) && String(row.amount_vnd) === vnd(request.billions))) continue;
    const made = await ctx.command('projectManager', `/allocation-lines/${String(line.id)}/extensions`, { amount_vnd: vnd(request.billions), extended_to: request.to, reason_code: request.code, justification: request.why });
    if (request.reject !== undefined) await ctx.command('capApprover', `/allocation-extensions/${made.resource_id}/decision`, { decision: 'reject', reason: request.reject }, { version: Number(made.resource_version) });
  }
  ctx.record({ module: 'CAP', screen: 'CAP-20', kind: 'allocation-extension', id: 'GH-2026', code: 'kéo dài giải ngân', note: 'two pending, one rejected' });
}

// ---- closing of the years (CAP-11) ------------------------------------------------------------------------------------------------------------------------------------

async function seedYearClose(ctx: SeedContext): Promise<void> {
  const years = new Map((await ctx.list<Obj>('projectManager', '/fiscal-years')).map((row) => [Number(row.plan_year), row]));
  const close = async (year: number, target: 'SOFT_CLOSED' | 'LOCKED', reason: string): Promise<void> => {
    const row = years.get(year);
    if (row !== undefined && (row.status === target || row.status === 'LOCKED')) return;
    const done = await ctx.command('projectManager', `/fiscal-years/${year}/close`, { target_status: target, reason }, { version: Number(row?.version ?? 1) });
    years.set(year, { plan_year: year, status: done.status, version: done.resource_version });
  };
  await close(ctx.year - 2, 'SOFT_CLOSED', `Đóng sơ bộ năm ${ctx.year - 2}: đã chốt số cam kết và giải ngân, các dự án hoàn thành đã quyết toán.`);
  await close(ctx.year - 2, 'LOCKED', `Khóa sổ năm ${ctx.year - 2}: phần vốn chưa cam kết và chưa chuyển nguồn hết hiệu lực theo Quy chế quản lý vốn đầu tư của Tổng công ty.`);
  await close(ctx.year - 1, 'SOFT_CLOSED', `Đóng sơ bộ năm ${ctx.year - 1}: chờ chuyển nguồn các dự án chuyển tiếp trước khi khóa sổ.`);
  ctx.record({ module: 'CAP', screen: 'CAP-11', kind: 'fiscal-year', id: String(ctx.year - 2), code: `${ctx.year - 2}/${ctx.year - 1}`, note: 'one year locked, one soft-closed' });
}

export async function seedClipEnterpriseCapPlus(ctx: SeedContext): Promise<void> {
  await part(ctx, 'CAP', 'medium-term plan 2027-2030 (CAP-01)', () => seedMidTermPlan(ctx));
  await part(ctx, 'CAP', 'draft adjustment of the medium-term plan (CAP-02, CAP-10)', () => seedMidTermDraft(ctx));
  await part(ctx, 'CAP', 'policies of availability control (CAP-17)', () => seedAvcPolicies(ctx));
  await part(ctx, 'CAP', 'earmarks of capital (CAP-18)', () => seedReservations(ctx));
  await part(ctx, 'CAP', 'simulations of a transfer (CAP-09)', () => seedScenarios(ctx));
  await part(ctx, 'CAP', 'proposals to move capital (CAP-19, CAP-23)', () => seedReallocations(ctx));
  await part(ctx, 'CAP', 'requests to extend disbursement (CAP-20)', () => seedExtensions(ctx));
  await part(ctx, 'CAP', 'closing of the previous years (CAP-11)', () => seedYearClose(ctx));
}
