import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { ensureWorkCalendar, masterRecord, paper, tolerate } from '../field-assurance/shared.ts';

/**
 * Group `clip-public-pwf-review`: the screens of the project workflow (PWF-01 to PWF-16, the section of PRJ-02, the tab of PRJ-03, MOB-78 to MOB-82) have something to judge on every one of them.
 * Before this group the public dataset held one project workflow with two tasks in progress (`clip-public-phone-work`): the deadline board had one colour, the library the three built-in
 * templates and nothing of the tenant, and there was no score at all.
 *
 * Real commands of the product only, the way people do it on the screens (maker is never checker: the owner writes, the leader of the department approves, and the other way round):
 *   - the library: a template the tenant wrote (phases, steps, tasks, checklists, legal grounds, forms with their revision policy) approved by a second person, a second version of it that waits
 *     for approval (so the comparison of versions has two sides), a draft of another template, the rule that maps a kind of project to a template (approved) and the three-colour policy of the tenant;
 *   - eight projects registered with their workflow (PRJ-02: investment, procurement, repair and the template of the tenant, twice each), started on different days in the past so that tasks are green, yellow and red on
 *     the same day; in each workflow tasks are done, wait for the approval of their completion, were sent back, are in progress with a part of their checklist ticked, with evidence (a paper of the
 *     document store, a legal document, a document of a form with its revision), with an exception asked (one decided, one waiting);
 *   - a reschedule proposed and waiting (PWF-06) and one approved;
 *   - the reminders of the person of the phone (PWF-15, MOB-82);
 *   - a scoring period of the tenant computed and locked (PWF-11 to PWF-14, MOB-81), with an adjustment decided by a second person and a response of the person scored.
 *
 * Idempotent: every part reads what exists first (the rules by type and code, the projects by code, the tasks by status, the periods by their dates) and only tops up what is missing. A refusal of the
 * rules of the product is written as a warning and the group goes on; a server error (5xx) stops it.
 */

const OWNER = 'owner';
const MAKER = 'projectManager';
const CHECKER = 'capApprover';
/** The people who hold tasks: the person of the phone, the officer of the project board and the leader who also works on some. */
const WORKERS = [OWNER, MAKER] as const;

const TEMPLATE_TYPE = 'PROJECT_WORKFLOW_TEMPLATE';
const ASSIGNMENT_TYPE = 'PROJECT_WORKFLOW_ASSIGNMENT';
const BAND_TYPE = 'DEADLINE_BAND_POLICY';
const TENANT_TEMPLATE = 'CB_ROAD_REPAIR';
const DRAFT_TEMPLATE = 'CB_SCHOOL_EQUIPMENT';

const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const arr = <T = Obj>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

// ---- the rules (library, mapping, three colours) -----------------------------------------------------------------------------------------

interface RuleRow extends Obj {
  id: string;
  code: string;
  status: string;
  version: number;
}

const rulesOf = async (ctx: SeedContext, type: string, code: string): Promise<RuleRow[]> => (await ctx.list<RuleRow>(OWNER, '/governance-rules', { rule_type: type, code })).filter((row) => row.code === code);
const effectiveParams = async (ctx: SeedContext, type: string, code: string): Promise<Obj> => (await ctx.get<{ params: Obj }>(OWNER, '/governance-rules/effective', { rule_type: type, code })).params;

/** A rule drafted by one person, sent for approval and (when `approve`) approved by another: it goes as far as it is, so a half-made rule of an earlier run is finished. Returns the id of the rule. */
async function rule(ctx: SeedContext, spec: { type: string; code: string; params: Obj; reason: string; upTo: 'DRAFT' | 'SUBMITTED' | 'APPROVED'; maker?: string; checker?: string; ordinal?: number }): Promise<string | undefined> {
  const maker = spec.maker ?? OWNER;
  const checker = spec.checker ?? CHECKER;
  // The list names the version of the rule (1, 2, ...): the rows are the versions of this code, oldest first.
  const rows = (await rulesOf(ctx, spec.type, spec.code)).sort((left, right) => Number(left.version) - Number(right.version));
  const wanted = spec.ordinal ?? 1;
  const listed = rows[wanted - 1];
  // The row version a command must name (If-Match) is the one the record itself says.
  let row: RuleRow | undefined = listed === undefined ? undefined : { ...listed, version: Number((await ctx.get<Obj>(maker, `/governance-rules/${listed.id}`)).row_version ?? 1) };
  if (row === undefined) {
    if (rows.length < wanted - 1) return undefined;
    const created = await ctx.attempt<CommandReply>(maker, 'POST', '/governance-rules', { rule_type: spec.type, code: spec.code, params: spec.params, effective_from: ctx.today, reason: spec.reason });
    if (!created.ok) return undefined;
    row = { id: created.json.resource_id, code: spec.code, status: 'DRAFT', version: created.json.resource_version };
    ctx.record({ module: 'PWF', kind: 'governance-rule', id: row.id, code: `${spec.type}/${spec.code}`, note: `drafted by ${ctx.nameOf(maker)}`, screen: 'PWF-01' });
  }
  if (spec.upTo === 'DRAFT') return row.id;
  if (row.status === 'DRAFT') {
    const sent = await ctx.attempt<CommandReply>(maker, 'POST', `/governance-rules/${row.id}/submit`, { reason: 'Trình duyệt theo phân công của lãnh đạo đơn vị' }, { version: Number(row.version) });
    if (!sent.ok) return row.id;
    row = { ...row, status: 'SUBMITTED', version: sent.json.resource_version };
  }
  if (spec.upTo === 'SUBMITTED') return row.id;
  if (row.status === 'SUBMITTED' || row.status === 'PENDING_APPROVAL') {
    await ctx.attempt<CommandReply>(checker, 'POST', `/governance-rules/${row.id}/approve`, { reason: 'Đã rà soát nội dung, đồng ý ban hành' }, { version: Number(row.version) });
  }
  return row.id;
}

const UNVERIFIED_NOTE = 'Do đơn vị soạn; điều khoản cụ thể chờ phòng pháp chế đối chiếu.';

/** The template the tenant wrote: repair and maintenance of local roads. Three phases, five steps, eleven tasks; the legal documents and the forms are the ones the tenant holds (unknown ones are left out). */
function tenantTemplate(known: { documents: Set<string>; forms: Set<string> }, second: boolean): Obj {
  const basis = (document: string, article?: string): Obj[] => (known.documents.has(document) ? [{ document, ...(article === undefined ? {} : { article }), note: UNVERIFIED_NOTE, verification: 'UNVERIFIED' }] : []);
  const forms = (...codes: string[]): { form_templates: string[]; form_policies: Obj[] } => {
    const held = codes.filter((code) => known.forms.has(code));
    return { form_templates: held, form_policies: held.map((form) => ({ form, policy: 'LATEST_APPROVED' })) };
  };
  const after = (task: string): Obj[] => [{ task, kind: 'FS', lag_working_days: 0 }];
  const task = (code: string, name: string, phase: string, step: string, days: number, role: string, more: Obj = {}): Obj => ({
    code,
    name,
    phase,
    kind: 'TASK',
    duration_working_days: days,
    required: true,
    responsible_role: role,
    approver_role: null,
    priority: 'NORMAL',
    predecessors: [],
    legal_doc_types: [],
    form_templates: [],
    checklist: [],
    kpi_codes: ['PWF_TASK_DEVIATION_DAYS'],
    when: [],
    step,
    ...more,
  });
  const milestone = (code: string, name: string, phase: string, step: string, previous: string): Obj => ({ ...task(code, name, phase, step, 0, 'PMB_MANAGER', { predecessors: after(previous), kpi_codes: [], priority: 'HIGH' }), kind: 'MILESTONE' });
  return {
    name: 'Sửa chữa, bảo trì đường giao thông địa phương',
    project_type: 'ROAD_REPAIR',
    phases: [
      { code: 'PREPARATION', name: 'Chuẩn bị: khảo sát, lập và phê duyệt hồ sơ sửa chữa', gates: [] },
      { code: 'IMPLEMENTATION', name: 'Thực hiện: lựa chọn nhà thầu và thi công', gates: [] },
      { code: 'ACCEPTANCE', name: 'Kết thúc: nghiệm thu, bàn giao và quyết toán', gates: [] },
    ],
    steps: [
      { code: 'STEP_SURVEY', name: 'Khảo sát hiện trạng và lập hồ sơ sửa chữa', phase: 'PREPARATION', responsible_role: 'SITE_ENGINEER', legal_basis: [...basis('LAW_50_2014_QH13'), ...basis('DECREE_175_2024_ND_CP')] },
      { code: 'STEP_APPROVAL', name: 'Thẩm định và phê duyệt', phase: 'PREPARATION', responsible_role: 'DPI_APPRAISER', legal_basis: [...basis('LAW_58_2024_QH15'), ...basis('DECREE_85_2025_ND_CP')] },
      { code: 'STEP_BIDDING', name: 'Lựa chọn nhà thầu và ký hợp đồng', phase: 'IMPLEMENTATION', responsible_role: 'PROCUREMENT_OFFICER', legal_basis: basis('LAW_58_2024_QH15') },
      { code: 'STEP_WORKS', name: 'Thi công và giám sát', phase: 'IMPLEMENTATION', responsible_role: 'SUPERVISOR', legal_basis: [...basis('LAW_50_2014_QH13'), ...basis('DECREE_175_2024_ND_CP')] },
      { code: 'STEP_CLOSE', name: 'Nghiệm thu, bàn giao và quyết toán', phase: 'ACCEPTANCE', responsible_role: 'INVESTOR_REP', legal_basis: basis('LAW_58_2024_QH15') },
    ],
    tasks: [
      task('RR_SURVEY', 'Khảo sát, đánh giá hiện trạng hư hỏng của tuyến đường', 'PREPARATION', 'STEP_SURVEY', 4, 'SITE_ENGINEER', {
        checklist: [
          { code: 'SITE_RECORD', name: 'Có biên bản và ảnh chụp hiện trạng từng đoạn hư hỏng', required: true, evidence_kinds: ['DOCUMENT'] },
          { code: 'DAMAGE_TABLE', name: 'Đã lập bảng thống kê khối lượng hư hỏng', required: false, evidence_kinds: [] },
        ],
        kpi_codes: ['PWF_TASK_DEVIATION_DAYS', 'PWF_EVIDENCE_COMPLETENESS'],
      }),
      task('RR_ESTIMATE', 'Lập hồ sơ sửa chữa và dự toán', 'PREPARATION', 'STEP_SURVEY', second ? 6 : 4, 'PMB_PLANNER', {
        approver_role: 'INVESTOR_REP',
        predecessors: after('RR_SURVEY'),
        checklist: [
          { code: 'ESTIMATE_CHECKED', name: 'Dự toán đã được kiểm tra khối lượng và đơn giá', required: true, evidence_kinds: [] },
          { code: 'PRICE_SOURCE', name: 'Đã ghi nguồn đơn giá, định mức áp dụng', required: false, evidence_kinds: [] },
          ...(second ? [{ code: 'TRAFFIC_PLAN', name: 'Có phương án bảo đảm giao thông trong thời gian thi công', required: true, evidence_kinds: [] }] : []),
        ],
        ...forms('PWF_TO_TRINH_DU_TOAN'),
        legal_basis: basis('DECREE_175_2024_ND_CP'),
      }),
      task('RR_APPRAISAL', 'Thẩm định hồ sơ sửa chữa và dự toán', 'PREPARATION', 'STEP_APPROVAL', 5, 'DPI_APPRAISER', {
        approver_role: 'DECISION_AUTHORITY',
        predecessors: after('RR_ESTIMATE'),
        legal_doc_types: ['APPRAISAL_REPORT'],
        checklist: [{ code: 'OPINIONS_COLLECTED', name: 'Đã tổng hợp ý kiến của các cơ quan phối hợp', required: false, evidence_kinds: [] }],
        legal_basis: basis('DECREE_85_2025_ND_CP', 'Điều 22'),
      }),
      task('RR_DECISION', 'Quyết định phê duyệt dự án sửa chữa', 'PREPARATION', 'STEP_APPROVAL', 3, 'INVESTOR_REP', {
        approver_role: 'DECISION_AUTHORITY',
        priority: 'HIGH',
        predecessors: after('RR_APPRAISAL'),
        legal_doc_types: ['INVESTMENT_DECISION'],
        checklist: [{ code: 'DECISION_SIGNED', name: 'Quyết định đã được ký và vào sổ văn bản', required: true, evidence_kinds: ['DECISION_DOCUMENT'] }],
        ...forms('PWF_QD_PHE_DUYET_SUA_CHUA'),
        legal_basis: basis('LAW_58_2024_QH15'),
      }),
      milestone('RR_READY', 'Hồ sơ sửa chữa được phê duyệt', 'PREPARATION', 'STEP_APPROVAL', 'RR_DECISION'),
      task('RR_BID_PLAN', 'Phê duyệt kế hoạch lựa chọn nhà thầu', 'IMPLEMENTATION', 'STEP_BIDDING', 5, 'PROCUREMENT_OFFICER', { approver_role: 'INVESTOR_REP', predecessors: after('RR_READY'), ...forms('PWF_QD_KE_HOACH_LCNT') }),
      task('RR_PROCUREMENT', 'Lựa chọn nhà thầu và ký hợp đồng', 'IMPLEMENTATION', 'STEP_BIDDING', second ? 25 : 20, 'PROCUREMENT_OFFICER', {
        approver_role: 'INVESTOR_REP',
        predecessors: after('RR_BID_PLAN'),
        legal_doc_types: ['BID_RESULT_DECISION', 'CONSTRUCTION_CONTRACT'],
        checklist: [
          { code: 'BIDS_EVALUATED', name: 'Đã có báo cáo đánh giá hồ sơ dự thầu', required: false, evidence_kinds: [] },
          { code: 'CONTRACT_SIGNED', name: 'Hợp đồng đã ký và có bảo đảm thực hiện hợp đồng', required: true, evidence_kinds: [] },
        ],
      }),
      task('RR_WORKS', 'Thi công sửa chữa mặt đường, rãnh thoát nước và hệ thống an toàn giao thông', 'IMPLEMENTATION', 'STEP_WORKS', 40, 'SUPERVISOR', {
        predecessors: after('RR_PROCUREMENT'),
        priority: 'HIGH',
        checklist: [
          { code: 'SAFETY_MEASURES', name: 'Có biện pháp bảo đảm an toàn giao thông khi thi công', required: true, evidence_kinds: [] },
          { code: 'SITE_DIARY', name: 'Nhật ký thi công được ghi đủ hằng ngày', required: false, evidence_kinds: [] },
        ],
        kpi_codes: ['PWF_TASK_DEVIATION_DAYS', 'PWF_EVIDENCE_COMPLETENESS'],
      }),
      task('RR_ACCEPTANCE', 'Nghiệm thu hoàn thành và bàn giao đưa vào khai thác', 'ACCEPTANCE', 'STEP_CLOSE', 5, 'INVESTOR_REP', {
        approver_role: 'INVESTOR_REP',
        predecessors: after('RR_WORKS'),
        legal_doc_types: ['ACCEPTANCE_MINUTES'],
        checklist: [{ code: 'DEFECTS_FIXED', name: 'Các tồn tại sau kiểm tra đã được khắc phục', required: true, evidence_kinds: [] }],
      }),
      task('RR_SETTLEMENT', 'Lập và trình phê duyệt quyết toán', 'ACCEPTANCE', 'STEP_CLOSE', 10, 'PMB_ACCOUNTANT', {
        approver_role: 'DECISION_AUTHORITY',
        predecessors: after('RR_ACCEPTANCE'),
        legal_doc_types: ['SETTLEMENT_REPORT'],
        kpi_codes: ['PWF_TASK_DEVIATION_DAYS', 'PWF_AMOUNT_VARIANCE_PCT'],
      }),
      milestone('RR_CLOSED', 'Hoàn thành sửa chữa, đóng hồ sơ', 'ACCEPTANCE', 'STEP_CLOSE', 'RR_SETTLEMENT'),
    ],
  };
}

/**
 * The forms a workflow template may name. A template names a form by a code of capital letters, digits and underscores, and the forms of the document store of the public dataset are all written with
 * hyphens (DOC-QD-PHE-DUYET-DU-AN), so none of them can be named: the tenant keeps its workflow forms as forms of their own, here copied from three forms of the store (drafted by the officer, published
 * by the leader). A second revision of the first is published after the evidence was made, so that an evidence made from revision 1 says a newer revision exists.
 */
const FORMS = [
  { code: 'PWF_QD_PHE_DUYET_SUA_CHUA', title: 'Quyết định phê duyệt dự án sửa chữa', from: 'DOC-QD-PHE-DUYET-DU-AN' },
  { code: 'PWF_TO_TRINH_DU_TOAN', title: 'Tờ trình phê duyệt hồ sơ sửa chữa và dự toán', from: 'DOC-CV-GIAI-TRINH' },
  { code: 'PWF_QD_KE_HOACH_LCNT', title: 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu (sửa chữa)', from: 'DOC-QD-PHE-DUYET-KHLCNT' },
] as const;

async function publishForm(ctx: SeedContext, form: (typeof FORMS)[number], revision: number): Promise<void> {
  const rows = await ctx.list(OWNER, '/document-templates');
  const mine = rows.filter((row) => row.template_code === form.code);
  let row = mine.find((one) => Number(one.revision) === revision);
  if (row === undefined) {
    if (mine.length < revision - 1) return;
    const source = rows.find((one) => one.template_code === form.from && one.status === 'PUBLISHED');
    if (source === undefined) {
      ctx.warn(`the form ${form.from} is not published: the workflow form ${form.code} is not made`);
      return;
    }
    const detail = await ctx.get<Obj>(OWNER, `/document-templates/${str(source.id)}`);
    const created = await ctx.attempt<CommandReply>(MAKER, 'POST', '/document-templates', {
      template_code: form.code,
      group_code: detail.group_code,
      doc_type_code: detail.doc_type_code,
      title: revision === 1 ? form.title : `${form.title} (sửa đổi lần ${revision - 1})`,
      source_module: 'PWF',
      layout_profile_id: detail.layout_profile_id,
      body_blocks: revision === 1 ? detail.body_blocks : { blocks: [...arr((detail.body_blocks as Obj | undefined)?.blocks), { kind: 'paragraph', text: '{{body}}' }] },
      placeholder_schema: detail.placeholder_schema,
      legal_basis: detail.legal_basis,
      effective_from: revision === 1 ? ctx.day(-60) : ctx.today,
      watermark_text: detail.watermark_text,
    });
    if (!created.ok) return;
    row = { id: created.json.resource_id, version: created.json.resource_version, status: 'DRAFT' };
    ctx.record({ module: 'DOC', kind: 'template', id: created.json.resource_id, code: `${form.code}#${revision}`, note: 'a form of the workflow templates', screen: 'DOC-14' });
  }
  if (row.status === 'DRAFT') await ctx.attempt(CHECKER, 'POST', `/document-templates/${str(row.id)}/publish`, {}, { version: Number(row.version) });
}

/** What the tenant holds that a template may refer to: the legal documents the built-in templates cite and the forms of the document store that are published. */
async function knownReferences(ctx: SeedContext): Promise<{ documents: Set<string>; forms: Set<string> }> {
  const documents = new Set<string>();
  for (const code of ['PUBLIC_INVESTMENT', 'PUBLIC_REPAIR']) {
    const params = await tolerate(ctx, `the built-in template ${code}`, () => effectiveParams(ctx, TEMPLATE_TYPE, code));
    for (const holder of [...arr(params?.steps), ...arr(params?.tasks)]) for (const one of arr(holder.legal_basis)) documents.add(str(one.document));
  }
  const forms = new Set((await ctx.list(OWNER, '/document-templates', { status: 'PUBLISHED' })).map((row) => str(row.template_code)));
  return { documents, forms };
}

async function library(ctx: SeedContext): Promise<void> {
  for (const form of FORMS) await publishForm(ctx, form, 1);
  const known = await knownReferences(ctx);
  const first = tenantTemplate(known, false);
  const checked = await ctx.attempt<{ findings?: Array<{ code: string; path: string; severity: string }> }>(OWNER, 'POST', '/project-workflow/templates/validate', first);
  const errors = (checked.json.findings ?? []).filter((one) => one.severity === 'ERROR');
  if (errors.length > 0) ctx.warn(`the template ${TENANT_TEMPLATE} has findings: ${errors.map((one) => `${one.code} ${one.path}`).join('; ')}`);
  // Version 1 is in force (written by the owner, approved by the leader); version 2 changes two durations and adds a checklist item, and waits for approval.
  await rule(ctx, { type: TEMPLATE_TYPE, code: TENANT_TEMPLATE, params: first, reason: 'Ban hành mẫu quy trình sửa chữa, bảo trì đường giao thông địa phương của tỉnh', upTo: 'APPROVED', ordinal: 1 });
  await rule(ctx, { type: TEMPLATE_TYPE, code: TENANT_TEMPLATE, params: tenantTemplate(known, true), reason: 'Kéo dài thời gian lập dự toán và lựa chọn nhà thầu, bổ sung phương án bảo đảm giao thông', upTo: 'SUBMITTED', ordinal: 2 });
  // A draft the officer is still writing, from the built-in procurement template.
  const procurement = await tolerate(ctx, 'the built-in procurement template', () => effectiveParams(ctx, TEMPLATE_TYPE, 'PUBLIC_PROCUREMENT'));
  if (procurement !== undefined) {
    await rule(ctx, { type: TEMPLATE_TYPE, code: DRAFT_TEMPLATE, params: { ...procurement, name: 'Mua sắm thiết bị trường học (bản đang soạn)', project_type: 'SCHOOL_EQUIPMENT' }, reason: 'Soạn mẫu riêng cho các dự án mua sắm thiết bị trường học', upTo: 'DRAFT', maker: OWNER });
  }
}

/** The rule that maps a project to its kind of workflow, of the tenant: the lines of the built-in rule and one line for the template of the tenant, approved by a second person. */
async function mapping(ctx: SeedContext): Promise<void> {
  const base = await effectiveParams(ctx, ASSIGNMENT_TYPE, 'DEFAULT');
  const lines = arr(base.lines).filter((line) => line.code !== 'ROAD_REPAIR');
  const params = { ...base, lines: [{ code: 'ROAD_REPAIR', priority: 5, template_code: TENANT_TEMPLATE, when: [{ field: 'project_type', in: ['ROAD_REPAIR'] }] }, ...lines] };
  await rule(ctx, { type: ASSIGNMENT_TYPE, code: 'DEFAULT', params, reason: 'Dự án sửa chữa đường giao thông dùng mẫu quy trình của tỉnh', upTo: 'APPROVED' });
}

/** The three-colour policy of the tenant for the tasks of a project: the thresholds the built-in policy holds, taken as a version of the tenant (written by the owner, approved by the leader), so that PWF-08 shows a version in force and its history. */
async function bandPolicy(ctx: SeedContext): Promise<void> {
  const base = await tolerate(ctx, 'the three-colour policy in force', () => effectiveParams(ctx, BAND_TYPE, 'PROJECT_TASK'));
  if (base === undefined) return;
  await rule(ctx, { type: BAND_TYPE, code: 'PROJECT_TASK', params: base, reason: 'Xác nhận ngưỡng ba màu áp dụng cho công việc của dự án trong toàn tỉnh', upTo: 'APPROVED' });
}

// ---- the projects and their workflows -----------------------------------------------------------------------------------------------------

interface ProjectSpec {
  code: string;
  name: string;
  template: string;
  /** How many working days ago the workflow started: it decides which task is under way today and how near its deadline is. */
  elapsed: number;
  billions: number;
  /** Why another kind than the one the rule suggests (PRJ-02 asks for it). */
  reason?: string;
  facts: Record<string, string>;
  /** A workflow that only began: its tasks are started and none is finished yet, so its schedule is the one it was started with. */
  fresh?: boolean;
}

/**
 * Two kinds of workflow, because the product computes the schedule again from the progress each time a task is finished (BR-PWF-06): the planned finish of every task that is still open is then
 * forecast from today, and a task that was late is no longer shown as late.
 *   - The first four are well under way and show the STATES. Each workflow started long enough ago for four or five of its tasks to be past their planned finish (some done on time, one waiting for approval, one sent back, one still open and late: red) and
 * for the next one to be under way. The durations are those of the templates: when a template changes, `elapsed` is what to adjust.
 *   - The last four only began and show the COLOURS: nothing is finished in them, so their first task keeps the deadline it was planned with, one or two working days ahead (yellow), three to
 *     five (green) or already past (red).
 */
const PROJECTS: ProjectSpec[] = [
  { code: 'DA-PWF-01', name: 'Xây dựng Trường THPT Nà Giàng (cơ sở mới)', template: 'PUBLIC_INVESTMENT', elapsed: 95, billions: 150, facts: { project_group: 'B', funding_source: 'STATE_BUDGET' } },
  { code: 'DA-PWF-02', name: 'Mua sắm thiết bị dạy học các trường THCS huyện Hòa An', template: 'PUBLIC_PROCUREMENT', elapsed: 68, billions: 28, reason: 'Dự án chỉ mua sắm thiết bị dạy học, không có hạng mục xây dựng', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' } },
  { code: 'DA-PWF-03', name: 'Sửa chữa, cải tạo Bệnh viện đa khoa huyện Trùng Khánh', template: 'PUBLIC_REPAIR', elapsed: 64, billions: 46, reason: 'Dự án sửa chữa, cải tạo công trình hiện có, không xây dựng mới', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' } },
  { code: 'DA-PWF-04', name: 'Sửa chữa đường tỉnh 207, đoạn Km5 - Km18', template: TENANT_TEMPLATE, elapsed: 19, billions: 35, reason: 'Sửa chữa đường giao thông địa phương theo mẫu quy trình của tỉnh', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' } },
  { code: 'DA-PWF-05', name: 'Xây dựng cầu Nà Pài qua sông Bằng', template: 'PUBLIC_INVESTMENT', elapsed: 6, billions: 210, facts: { project_group: 'B', funding_source: 'STATE_BUDGET' }, fresh: true },
  { code: 'DA-PWF-06', name: 'Mua sắm trang thiết bị y tế Trung tâm Y tế huyện Bảo Lạc', template: 'PUBLIC_PROCUREMENT', elapsed: 7, billions: 19, reason: 'Dự án chỉ mua sắm trang thiết bị y tế, không có hạng mục xây dựng', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, fresh: true },
  { code: 'DA-PWF-07', name: 'Cải tạo trụ sở Ủy ban nhân dân xã Quang Trung', template: 'PUBLIC_REPAIR', elapsed: 8, billions: 12, reason: 'Dự án sửa chữa, cải tạo công trình hiện có, không xây dựng mới', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, fresh: true },
  { code: 'DA-PWF-08', name: 'Sửa chữa đường liên xã Đức Long - Thụy Hùng', template: TENANT_TEMPLATE, elapsed: 3, billions: 9, reason: 'Sửa chữa đường giao thông địa phương theo mẫu quy trình của tỉnh', facts: { project_group: 'C', funding_source: 'STATE_BUDGET' }, fresh: true },
];

/** The day a workflow started so that today is its `elapsed`-th working day (Monday to Friday; the public holidays in between move the schedule by their number, which the colours tolerate). */
function startDay(today: string, elapsed: number): string {
  const day = new Date(`${today}T00:00:00Z`);
  const weekday = (): boolean => day.getUTCDay() !== 0 && day.getUTCDay() !== 6;
  while (!weekday()) day.setUTCDate(day.getUTCDate() - 1);
  for (let left = elapsed - 1; left > 0; ) {
    day.setUTCDate(day.getUTCDate() - 1);
    if (weekday()) left -= 1;
  }
  return day.toISOString().slice(0, 10);
}

interface TaskRow extends Obj {
  id: string;
  task_code: string;
  name: string;
  status: string;
  kind: string;
  planned_start: string | null;
  planned_finish: string | null;
  return_count: number;
  version: number;
}

interface TaskDetail extends TaskRow {
  approver_role: string | null;
  checklist: Array<{ item_code: string; required: boolean; done: boolean; evidence_kinds: string[] }>;
  legal_doc_types: Array<{ code: string; satisfied: boolean }>;
  form_templates: Array<{ code: string; satisfied?: boolean }>;
  evidence: Obj[];
  exceptions: Obj[];
}

async function ensureProject(ctx: SeedContext, spec: ProjectSpec): Promise<string | undefined> {
  const existing = await ctx.find(OWNER, '/resources/project', (row) => row.code === spec.code);
  if (existing !== undefined) return str(existing.id);
  const area = await masterRecord(ctx, 'AREA', 'CAO-BANG');
  if (area?.version_id === undefined || area.version_id === null) {
    ctx.warn(`the area CAO-BANG is not in force: the project ${spec.code} is not registered`);
    return undefined;
  }
  const plannedStart = startDay(ctx.today, spec.elapsed);
  // The schedule runs on published calendars to its last day: each year the preview says is missing is published first.
  for (let round = 0; round < 6; round += 1) {
    const suggestion = await ctx.call<{ preview: { findings?: Array<{ code: string; year?: number }> } | null }>(OWNER, 'GET', '/project-workflow/suggestion', undefined, {
      query: { owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'), template_code: spec.template, planned_start_date: plannedStart, ...spec.facts },
    });
    const years = [...new Set((suggestion.json.preview?.findings ?? []).filter((one) => one.code === 'CALENDAR_UNAVAILABLE' && typeof one.year === 'number').map((one) => Number(one.year)))];
    if (!suggestion.ok || years.length === 0) break;
    await ensureWorkCalendar(ctx, years);
  }
  const created = await ctx.attempt<CommandReply>(MAKER, 'POST', '/projects', {
    code: spec.code,
    name: spec.name,
    owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
    area_master_version_id: area.version_id,
    total_investment_vnd: `${spec.billions}000000000`,
    classification: 'INTERNAL',
    workflow: { template_code: spec.template, planned_start_date: plannedStart, facts: spec.facts, ...(spec.reason === undefined ? {} : { selection_reason: spec.reason }) },
  });
  if (!created.ok) return undefined;
  ctx.record({ module: 'PWF', kind: 'project', id: created.json.resource_id, code: spec.code, note: `registered with the workflow ${spec.template}, planned start ${plannedStart}`, screen: 'PRJ-02' });
  return created.json.resource_id;
}

const tasksOf = async (ctx: SeedContext, projectId: string): Promise<TaskRow[]> =>
  (await ctx.list<TaskRow>(OWNER, `/projects/${projectId}/workflow/tasks`, { limit: 100 }))
    .filter((task) => task.kind !== 'MILESTONE' && task.excluded !== true && task.tracked !== false && task.planned_start !== null)
    .sort((left, right) => str(left.planned_start).localeCompare(str(right.planned_start)));
const detailOf = (ctx: SeedContext, person: string, taskId: string): Promise<TaskDetail> => ctx.get<TaskDetail>(person, `/project-tasks/${taskId}`);

/**
 * Gives the task to the person and starts it. `on` is the day the work really began (its planned start: the workflow was started in the past and its first tasks were done then); a task whose
 * predecessors are not done is started early, with the reason the command asks for.
 */
async function begin(ctx: SeedContext, task: TaskRow, person: string, on?: string): Promise<boolean> {
  if (task.status !== 'NOT_STARTED') return task.status === 'IN_PROGRESS';
  const give = (from: string): Promise<{ ok: boolean }> => ctx.call(OWNER, 'POST', `/project-tasks/${task.id}/assignments`, { membership_id: ctx.person(person).membershipId, role: 'RESPONSIBLE', valid_from: from, share_pct: 100, reason: 'Giao việc cho người phụ trách trực tiếp theo phân công của dự án' });
  if (on === undefined || !(await give(on)).ok) await give(ctx.today);
  const EARLY = 'Làm song song với việc đứng trước để kịp tiến độ chung của dự án, đã báo cáo lãnh đạo Ban';
  const bodies: Obj[] = [...(on === undefined ? [] : [{ actual_start: on }, { actual_start: on, early_start_reason: EARLY }]), {}, { early_start_reason: EARLY }];
  for (const [index, body] of bodies.entries()) {
    const now = await detailOf(ctx, person, task.id);
    const last = index === bodies.length - 1;
    const begun = last ? await ctx.attempt(person, 'POST', `/project-tasks/${task.id}/start`, body, { version: Number(now.version) }) : await ctx.call(person, 'POST', `/project-tasks/${task.id}/start`, body, { version: Number(now.version) });
    if (begun.ok) return true;
  }
  return false;
}

/** Evidence for what the task asks: every legal document it needs, every form (the revision in force is kept with it), one paper of the document store, and the checklist ticked (all of it, or only its first item). */
async function work(ctx: SeedContext, taskId: string, person: string, how: 'ALL' | 'PART'): Promise<void> {
  let task = await detailOf(ctx, person, taskId);
  const give = (body: Obj): Promise<unknown> => ctx.attempt(person, 'POST', `/project-tasks/${taskId}/evidence`, body);
  if (task.evidence.length === 0) {
    const sheet = await tolerate(ctx, `the paper of the task ${task.task_code}`, () => paper(ctx, { symbol: `PWF-${task.task_code}-${taskId.slice(0, 6)}/BB-BQLDA`, title: `Biên bản làm việc: ${task.name}`, type: 'BB', issuedOn: ctx.day(-2) }));
    await give({ evidence_kind: 'DOCUMENT', ...(sheet === undefined ? { external_ref: `Biên bản số ${taskId.slice(0, 4)}/BB-BQLDA` } : { document_id: sheet.documentId }), note: 'Biên bản làm việc của tổ thực hiện' });
  }
  // What the task still asks for: every legal document and every form when the task is to be finished, the first form only while it is under way.
  const given = new Set(task.evidence.map((one) => str(one.form_template_code ?? '')));
  for (const doc of how === 'ALL' ? task.legal_doc_types.filter((one) => !one.satisfied) : []) {
    await give({ evidence_kind: 'DECISION_DOCUMENT', legal_doc_type: doc.code, external_ref: `Văn bản số ${task.task_code.length}${taskId.slice(0, 2)}/${doc.code.slice(0, 2)}-UBND ngày ${ctx.day(-1).split('-').reverse().join('/')}`, note: 'Văn bản đã ký, bản gốc lưu tại văn thư' });
  }
  for (const form of (how === 'ALL' ? task.form_templates : task.form_templates.slice(0, 1)).filter((one) => !given.has(one.code))) {
    await give({ evidence_kind: 'DOCUMENT', form_template_code: form.code, external_ref: `Văn bản lập theo biểu mẫu ${form.code}`, note: 'Lập từ biểu mẫu của kho văn bản, phiên bản đang hiệu lực' });
  }
  task = await detailOf(ctx, person, taskId);
  const open = task.checklist.filter((item) => !item.done);
  const toTick = how === 'ALL' ? open : task.checklist.some((item) => item.done) || task.checklist.length < 2 ? [] : open.slice(0, 1);
  for (const item of toTick) {
    // An item that asks for evidence of a kind is ticked with that evidence (the command names it).
    const kind = item.evidence_kinds[0];
    const proof = kind === undefined ? undefined : await ctx.attempt<CommandReply>(person, 'POST', `/project-tasks/${taskId}/evidence`, { evidence_kind: kind, item_code: item.item_code, external_ref: `Hồ sơ kèm mục ${item.item_code}, lưu tại Ban quản lý dự án`, note: 'Bằng chứng của mục danh mục kiểm' });
    const now = await detailOf(ctx, person, taskId);
    await ctx.attempt(person, 'POST', `/project-tasks/${taskId}/checklist/${item.item_code}/complete`, { note: 'Đã kiểm tra, đủ theo yêu cầu', ...(proof?.ok === true ? { evidence_id: proof.json.resource_id } : {}) }, { version: Number(now.version) });
  }
}

/** Finishes the task: everything it asks for is given first. `on` is the day it was really finished (its planned finish, for a task done on time in the past). */
async function complete(ctx: SeedContext, taskId: string, person: string, on?: string): Promise<boolean> {
  await work(ctx, taskId, person, 'ALL');
  const note = { note: 'Đã hoàn thành theo yêu cầu của bước' };
  for (const body of on === undefined ? [note] : [{ ...note, actual_finish: on }, note]) {
    const now = await detailOf(ctx, person, taskId);
    if (now.status !== 'IN_PROGRESS') return now.status === 'AWAITING_APPROVAL' || now.status === 'DONE';
    const done = body === note ? await ctx.attempt(person, 'POST', `/project-tasks/${taskId}/complete`, body, { version: Number(now.version) }) : await ctx.call(person, 'POST', `/project-tasks/${taskId}/complete`, body, { version: Number(now.version) });
    if (done.ok) return true;
  }
  return false;
}

/**
 * The work of one workflow as it stands today, read from its schedule. Of the tasks whose planned finish is past: the last one is still open and late (red), with an exception asked for the delay; the
 * one before was finished and sent back by the leader; the one before that waits for the approval of its completion; the earlier ones were done on their planned day (and approved where the task has an
 * approver). The tasks that are under way today are started on their planned day, a part of their checklist ticked and a first evidence given. Nothing is done twice: a task that is no longer
 * `NOT_STARTED` is left as it is.
 */
async function play(ctx: SeedContext, spec: { code: string; fresh?: boolean }, projectId: string, turn: number): Promise<void> {
  const tasks = (await tasksOf(ctx, projectId)).filter((task) => task.planned_finish !== null);
  if (tasks.some((task) => task.status !== 'NOT_STARTED')) return;
  const past = tasks.filter((task) => str(task.planned_finish) < ctx.today);
  const current = tasks.filter((task) => str(task.planned_start) <= ctx.today && str(task.planned_finish) >= ctx.today);
  let person = turn;
  const next = (): string => WORKERS[(person += 1) % WORKERS.length] as string;
  const note = (task: TaskRow, what: string): void => ctx.record({ module: 'PWF', kind: 'project-task', id: task.id, code: `${spec.code}/${task.task_code}`, note: what, screen: 'PWF-04' });
  const approverOf = async (task: TaskRow): Promise<TaskDetail> => detailOf(ctx, CHECKER, task.id);

  if (spec.fresh === true) {
    // Only begun: the tasks whose planned start is past are started on that day and worked on; none is finished, so the schedule (and each deadline) stays the one the workflow was started with.
    for (const task of [...past, ...current]) {
      const who = next();
      if (!(await begin(ctx, task, who, str(task.planned_start)))) continue;
      await work(ctx, task.id, who, 'PART');
      note(task, `under way since its planned start, held by ${ctx.nameOf(who)}`);
    }
    return;
  }
  for (const [index, task] of past.entries()) {
    const fromEnd = past.length - 1 - index;
    const who = next();
    if (!(await begin(ctx, task, who, str(task.planned_start)))) continue;
    if (fromEnd === 0) {
      // Still open and late: a part of the work is there, and the person asked for the delay to be recognised (decided by the leader in every other workflow, waiting in the others).
      await work(ctx, task.id, who, 'PART');
      const asked = await ctx.attempt<CommandReply>(who, 'POST', `/project-tasks/${task.id}/exceptions`, {
        kind: 'EXTERNAL_DELAY',
        valid_from: ctx.day(-3),
        valid_to: ctx.day(7),
        reason: 'Chờ ý kiến bằng văn bản của Sở Tài chính về nguồn vốn, dự kiến có sau mười ngày',
        evidence_ref: 'Công văn số 512/BQLDA-KH đề nghị cho ý kiến',
      });
      if (asked.ok && turn % 2 === 0) await decideBy(ctx, [CHECKER, OWNER], `/project-task-exceptions/${asked.json.resource_id}/decide`, { decision: 'APPROVE', note: 'Đồng ý ghi nhận chậm do chờ cơ quan ngoài' }, asked.json.resource_version);
      note(task, `late and open, held by ${ctx.nameOf(who)}; external delay ${asked.ok ? (turn % 2 === 0 ? 'approved' : 'waiting') : 'refused'}`);
      continue;
    }
    if (fromEnd === 1) {
      // Finished late and sent back.
      if (!(await complete(ctx, task.id, who))) continue;
      const now = await approverOf(task);
      if (now.status === 'AWAITING_APPROVAL') await ctx.attempt(CHECKER, 'POST', `/project-tasks/${task.id}/return`, { reason: 'Hồ sơ còn thiếu ý kiến của cơ quan phối hợp, đề nghị bổ sung rồi trình lại' }, { version: Number(now.version) });
      note(task, now.status === 'AWAITING_APPROVAL' ? 'sent back by the leader' : 'done (no approver to send it back)');
      continue;
    }
    if (!(await complete(ctx, task.id, who, str(task.planned_finish)))) continue;
    const now = await approverOf(task);
    if (fromEnd === 2 && now.status === 'AWAITING_APPROVAL') {
      note(task, 'waits for the approval of its completion');
      continue;
    }
    if (now.status === 'AWAITING_APPROVAL') await ctx.attempt(CHECKER, 'POST', `/project-tasks/${task.id}/approve-completion`, { decision: 'APPROVE', note: 'Hồ sơ đủ, đồng ý hoàn thành' }, { version: Number(now.version) });
    note(task, `done on its planned day by ${ctx.nameOf(who)}`);
  }
  for (const task of current) {
    const who = next();
    if (!(await begin(ctx, task, who, str(task.planned_start)))) continue;
    await work(ctx, task.id, who, 'PART');
    note(task, `under way, held by ${ctx.nameOf(who)}`);
  }
}

/**
 * The first of the people whose command the product accepts (a second person decides: who that may be is the product's rule, not the seed's). A version conflict names the version in force, and the
 * command is sent once more with it.
 */
async function decideBy(ctx: SeedContext, people: readonly string[], path: string, body: Obj, version: number): Promise<boolean> {
  let last = '';
  for (const person of people) {
    let reply = await ctx.call(person, 'POST', path, body, { version });
    if (reply.status === 409 && typeof reply.json.current_version === 'number') reply = await ctx.call(person, 'POST', path, body, { version: reply.json.current_version });
    if (reply.status >= 500) ctx.expectOk(reply);
    if (reply.ok) return true;
    last = `${person}: HTTP ${reply.status} ${str(reply.json.code)}`;
  }
  ctx.warn(`POST ${path} was refused for everyone asked (${last})`);
  return false;
}

const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A reschedule of the workflow proposed by the officer: waiting for its decision on the first project (PWF-06 opens on it), approved by the leader on the second. */
async function reschedules(ctx: SeedContext, ids: Record<string, string>): Promise<void> {
  const propose = async (code: string, days: number, reason: string, decide: boolean): Promise<void> => {
    const projectId = ids[code];
    if (projectId === undefined) return;
    const workflow = await ctx.get<Obj>(OWNER, `/projects/${projectId}/workflow`);
    const spec = PROJECTS.find((one) => one.code === code);
    const asked = await ctx.call<Obj>(MAKER, 'POST', `/projects/${projectId}/workflow/reschedules`, { planned_start_date: shiftDay(startDay(ctx.today, spec?.elapsed ?? 1), days), reason }, { version: Number(workflow.version) });
    // A proposal that waits is named by the refusal (409 PWF_RESCHEDULE_PENDING_EXISTS): the one of an earlier run.
    const proposalId = str(asked.json.proposal_id);
    if (proposalId === '') {
      ctx.warn(`the reschedule of ${code} was refused: HTTP ${asked.status} ${str(asked.json.code)}`);
      return;
    }
    if (asked.ok) ctx.record({ module: 'PWF', kind: 'reschedule', id: proposalId, code, note: decide ? 'approved' : 'waiting for the decision', screen: 'PWF-06' });
    if (!decide) return;
    const proposal = await ctx.get<Obj>(CHECKER, `/project-reschedules/${proposalId}`);
    if (proposal.status === 'PROPOSED') await decideBy(ctx, [CHECKER, OWNER], `/project-reschedules/${proposalId}/decide`, { decision: 'APPROVE', note: 'Đồng ý dời lịch theo đề nghị' }, Number(proposal.version));
  };
  await propose('DA-PWF-01', 4, 'Dời ngày bắt đầu bốn ngày do chưa bàn giao xong hồ sơ khảo sát địa hình của khu đất', false);
  await propose('DA-PWF-02', 1, 'Dời ngày bắt đầu một ngày theo lịch họp thống nhất danh mục thiết bị với các trường', true);
}

/** The reminders of the person of the phone: thresholds of their own (earlier than the official ones) and the days they are reminded on. */
async function preference(ctx: SeedContext): Promise<void> {
  const now = await ctx.get<Obj>(OWNER, '/me/deadline-preference');
  if (now.green_days !== null && now.green_days !== undefined) return;
  await ctx.attempt(OWNER, 'PUT', '/me/deadline-preference', { green_days: 8, yellow_days: 4, red_days: 1, reminder_days: [5, 3, 1, 0] }, { version: Number(now.version ?? 0) });
}

// ---- the scores ---------------------------------------------------------------------------------------------------------------------------

/** The quarter today falls in, as the scoring policy counts its periods. */
function quarterOf(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const first = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const last = first + 2;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return { from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(new Date(Date.UTC(year, last, 0)).getUTCDate())}` };
}

interface Period extends Obj {
  id: string;
  status: string;
  version: number;
  period_from: string;
}

/** The period of the whole province computed and locked by the owner, with one adjustment decided by a second person and one response of the person scored. */
async function scores(ctx: SeedContext): Promise<void> {
  const unit = ctx.unitId('CB-HQ');
  const window = quarterOf(ctx.today);
  let period = (await ctx.list<Period>(OWNER, '/staff-score-periods', { scope_unit_id: unit })).find((one) => one.period_from === window.from);
  if (period === undefined) {
    const computed = await ctx.attempt<{ period: Period }>(OWNER, 'POST', '/staff-score-periods', { scope_unit_id: unit, period_from: window.from, period_to: window.to, policy_code: 'DEFAULT' });
    if (!computed.ok) return;
    period = computed.json.period;
    ctx.record({ module: 'PWF', kind: 'score-period', id: period.id, code: `${window.from}..${window.to}`, note: 'computed', screen: 'PWF-14' });
  }
  if (period.status === 'DRAFT') {
    const locked = await ctx.attempt<CommandReply>(OWNER, 'POST', `/staff-score-periods/${period.id}/lock`, {}, { version: Number(period.version) });
    if (!locked.ok) return;
  }
  const lines = await ctx.list<Obj>(OWNER, `/staff-score-periods/${period.id}/lines`);
  const lineOf = (person: string): Obj | undefined => lines.find((line) => line.membership_id === ctx.person(person).membershipId);
  // An adjustment of the officer's score, asked by the owner and decided by a second person.
  const officer = lineOf(MAKER);
  if (officer !== undefined) {
    const detail = await ctx.get<Obj>(OWNER, `/staff-score-lines/${str(officer.id)}`);
    if (arr(detail.adjustments).length === 0) {
      const asked = await ctx.attempt<CommandReply>(OWNER, 'POST', `/staff-score-lines/${str(officer.id)}/adjustments`, { points: 3, reason: 'Chủ động xử lý hồ sơ thay đồng nghiệp nghỉ ốm trong hai tuần, bảo đảm tiến độ của dự án', evidence_ref: 'Biên bản họp giao ban tuần 45' });
      if (asked.ok) await decideBy(ctx, [CHECKER, 'unitAdmin', MAKER], `/staff-score-adjustments/${asked.json.resource_id}/decide`, { decision: 'APPROVE', note: 'Đồng ý theo đề nghị, đã xem biên bản giao ban' }, asked.json.resource_version);
    }
  }
  // A response of the officer to their own score, handled by the owner.
  if (officer !== undefined) {
    const detail = await ctx.get<Obj>(MAKER, `/staff-score-lines/${str(officer.id)}`);
    const waiting = arr(detail.responses).find((one) => ['OPEN', 'SUBMITTED', 'PENDING'].includes(str(one.status)));
    if (waiting !== undefined) await decideBy(ctx, [OWNER, CHECKER], `/staff-score-responses/${str(waiting.id)}/handle`, { outcome: 'KEEP', conclusion: 'Ghi nhận giải trình; giữ nguyên điểm, sẽ xét khi đánh giá cuối năm' }, Number(waiting.version ?? 1));
    if (arr(detail.responses).length === 0) {
      const sent = await ctx.attempt<CommandReply>(MAKER, 'POST', `/staff-score-lines/${str(officer.id)}/responses`, { body: 'Việc thẩm định bị trả lại do chờ ý kiến của cơ quan phối hợp, không do chậm trễ của người thực hiện; đề nghị xem xét khi đánh giá' });
      if (sent.ok) await decideBy(ctx, [OWNER, CHECKER], `/staff-score-responses/${sent.json.resource_id}/handle`, { outcome: 'KEEP', conclusion: 'Ghi nhận giải trình; giữ nguyên điểm, sẽ xét khi đánh giá cuối năm' }, sent.json.resource_version);
    }
  }
}

export async function seedClipPwfReview(ctx: SeedContext): Promise<void> {
  await ctx.step('PWF', 'the library: a template of the tenant in force, its second version waiting, a draft', () => library(ctx));
  await ctx.step('PWF', 'the mapping rule of the tenant and its three-colour policy', async () => {
    await mapping(ctx);
    await bandPolicy(ctx);
  });
  const ids: Record<string, string> = {};
  await ctx.step('PWF', `${PROJECTS.length} projects registered with their workflow (PRJ-02)`, async () => {
    for (const spec of PROJECTS) {
      const id = await ensureProject(ctx, spec);
      if (id !== undefined) ids[spec.code] = id;
    }
  });
  for (const [turn, spec] of PROJECTS.entries()) {
    const id = ids[spec.code];
    if (id === undefined) continue;
    await ctx.step('PWF', `tasks done, waiting for approval, sent back, late and under way in the workflow of ${spec.code}`, () => play(ctx, spec, id, turn));
  }
  await ctx.step('PWF', 'a reschedule waiting and one approved (PWF-06)', () => reschedules(ctx, ids));
  // After the evidence was made from revision 1: the form is revised, and the task says a newer revision exists.
  await ctx.step('DOC', `a second revision of the form ${FORMS[0].code}`, () => publishForm(ctx, FORMS[0], 2));
  await ctx.step('PWF', 'the reminders of the person of the phone (PWF-15, MOB-82)', () => preference(ctx));
  await ctx.step('PWF', 'the scoring period of the quarter, locked, with an adjustment and a response (PWF-11 to PWF-14)', () => scores(ctx));
}
