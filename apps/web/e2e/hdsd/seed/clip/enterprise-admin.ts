import type { Obj, SeedContext } from '../context.ts';

/**
 * Group `clip-ent-admin`: the administration and office screens (ADM, DOC, AUD, QMS, AST, RPT) the other enterprise groups leave empty.
 *
 * Every step is independent and tolerant: it looks at what exists first, makes what is missing through the real command of the product, and a refusal of the rules of the
 * product is written as a warning (never a crash), so one screen that cannot be filled does not stop the others. Nothing here decides an approval task, publishes a workflow
 * of a business type another group owns, or touches the figures of the dashboards. Everything is made on the real day (a grant is stamped with the real time by the database).
 */

const OWNER = 'owner';
const LEADER = 'capApprover';
const ADMIN = 'unitAdmin';
const OFFICER = 'projectManager';
const HEAD = 'docHead';

const hours = (n: number): string => new Date(Date.now() + n * 3_600_000).toISOString();
const days = (n: number): string => hours(n * 24);

async function attempt(ctx: SeedContext, module: string, title: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await ctx.step(module, title, run);
  } catch (error) {
    ctx.warn(`${title} skipped: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`);
  }
}

async function unitIdByCode(ctx: SeedContext, code: string): Promise<string | undefined> {
  const unit = await ctx.find<Obj>(OWNER, '/resources/organization_unit', (row) => row.code === code);
  return unit === undefined ? undefined : String(unit.id);
}

/** ADM-04: time-boxed delegations (the leader hands the approval right of the planning unit to the head of the committee for a month, an expired-soon one for the week). */
async function delegations(ctx: SeedContext): Promise<void> {
  const unit = await unitIdByCode(ctx, 'DPM-KHDT');
  if (unit === undefined) return;
  const specs = [
    { from: LEADER, to: HEAD, until: 14, reason: 'Ủy quyền xử lý các phiếu phê duyệt của Ban Kế hoạch và Đầu tư trong thời gian lãnh đạo đi công tác nước ngoài' },
    { from: OWNER, to: LEADER, until: 10, reason: 'Ủy quyền duyệt các phiếu thường kỳ của Ban Kế hoạch và Đầu tư trong thời gian Tổng giám đốc dự hội nghị ngành tại Hà Nội' },
  ];
  for (const spec of specs) {
    const given = await ctx.list<Obj>(spec.from, '/resources/delegation_grant', { role: 'given' });
    if (given.some((row) => row.kind !== 'PERMANENT' && ['Active', 'Scheduled'].includes(String(row.status)))) continue;
    await ctx.attempt(spec.from, 'POST', '/delegations', {
      delegate_membership_id: ctx.person(spec.to).membershipId,
      permissions: ['approval.decide'],
      scope_kind: 'UNIT_SUBTREE',
      scope_ref_ids: [unit],
      valid_from: hours(0),
      valid_until: days(spec.until),
      reason: spec.reason,
      legal_basis_ref: 'Quy chế quản lý đầu tư xây dựng của Tổng công ty',
    });
  }
}

/** ADM-25: a permanent delegation (request by the delegator, second approver other than both). */
async function standing(ctx: SeedContext): Promise<void> {
  const unit = await unitIdByCode(ctx, 'DPM-KHDT');
  if (unit === undefined) return;
  const requests = await ctx.list<Obj>(OWNER, '/resources/standing_delegation_request');
  let request = requests.find((row) => ['Pending', 'Approved'].includes(String(row.status)));
  if (request === undefined) {
    const made = await ctx.attempt(LEADER, 'POST', '/standing-delegation-requests', {
      delegate_membership_id: ctx.person(ADMIN).membershipId,
      permissions: ['approval.decide'],
      scope_kind: 'UNIT_ONLY',
      scope_ref_ids: [unit],
      valid_from: hours(0),
      review_due_at: days(180),
      end_condition_kind: 'SOURCE_HOLDS',
      end_condition_text: 'Hiệu lực chừng nào người ủy quyền còn giữ chức vụ lãnh đạo Ban Kế hoạch và Đầu tư',
      reason: 'Ủy quyền thường xuyên việc duyệt phiếu thường kỳ cho người phụ trách đơn vị để không đình trệ công việc',
      legal_basis_ref: 'Quy chế ủy quyền của Tổng công ty',
    });
    if (!made.ok) return;
    request = await ctx.get<Obj>(OWNER, `/resources/standing_delegation_request/${String(made.json.resource_id)}`);
  }
  if (String(request.status) === 'Pending') {
    // The approver is neither the delegator nor the delegate.
    await ctx.attempt(OWNER, 'POST', `/standing-delegation-requests/${String(request.id)}/decision`, { decision: 'approve', reason: 'Đồng ý, phù hợp quy chế ủy quyền' }, { version: Number(request.version) });
  }
}

/** ADM-26: acting on behalf of a person for a few hours (requested by the unit administrator, approved by the owner). */
async function acting(ctx: SeedContext): Promise<void> {
  const known = await ctx.list<Obj>(OWNER, '/resources/acting_grant');
  if (known.length > 0) return;
  const made = await ctx.attempt(OWNER, 'POST', '/acting-requests', {
    subject_membership_id: ctx.person(OFFICER).membershipId,
    permissions: ['doc.outgoing.create', 'doc.outgoing.edit'],
    hours: 4,
    reason: 'Nhập hộ số liệu báo cáo tuần vì cán bộ phụ trách dự án đang đi kiểm tra hiện trường',
  });
  if (!made.ok) return;
  const request = await ctx.get<Obj>(LEADER, `/resources/acting_grant/${String(made.json.resource_id)}`);
  await ctx.attempt(LEADER, 'POST', `/acting-requests/${String(request.id)}/decision`, { decision: 'approve', reason: 'Đồng ý cho nhập hộ trong 4 giờ' }, { version: Number(request.version) });
}

/** ADM-27: a role grant limited to some report periods. */
async function periodScope(ctx: SeedContext): Promise<void> {
  const known = await ctx.list<Obj>(OWNER, '/resources/period_scope', { status: 'Active' });
  if (known.length > 0) return;
  const grantee = ctx.person('nobody').membershipId;
  const grant = (await ctx.list<Obj>(OWNER, '/resources/role_grant')).find((row) => row.membership_id === grantee && String(row.status) === 'Active');
  if (grant === undefined) return;
  const periods = [`${ctx.year}-Q3`, `${ctx.year}-Q4`];
  await ctx.attempt(OWNER, 'POST', '/period-scopes', { role_grant_id: grant.id, period_codes: periods, reason: 'Chỉ nhập số liệu cho các kỳ báo cáo tuần được phân công trong quý' });
}

/** ADM-12: retention policies per record class (the owner drafts, the leader publishes). */
async function retention(ctx: SeedContext): Promise<void> {
  const specs = [
    { record_class: 'project_dossier', retention_years: 20, retention_basis: 'FROM_CLOSED', end_action: 'ARCHIVE_TRANSFER', legal_basis_ref: 'Luật Lưu trữ 2011 và Quy chế lưu trữ hồ sơ dự án của Tổng công ty' },
    { record_class: 'payment_dossier', retention_years: 10, retention_basis: 'FROM_CLOSED', end_action: 'REVIEW_FOR_DESTRUCTION', legal_basis_ref: 'Luật Kế toán 2015, thời hạn lưu trữ chứng từ kế toán' },
    { record_class: 'contract_dossier', retention_years: 15, retention_basis: 'FROM_CONTRACT_END', end_action: 'ARCHIVE_TRANSFER', legal_basis_ref: 'Luật Xây dựng 2014 và Quy chế quản lý hợp đồng của Tổng công ty' },
    { record_class: 'audit_event', retention_basis: 'PERMANENT', end_action: 'ARCHIVE_TRANSFER', legal_basis_ref: 'Quy chế kiểm toán nội bộ của Tổng công ty' },
    { record_class: 'user_session', retention_years: 1, retention_basis: 'FROM_CREATED', end_action: 'AUTO_PURGE_TECHNICAL', legal_basis_ref: 'Chính sách an toàn thông tin của Tổng công ty' },
  ];
  const known = await ctx.list<Obj>(OWNER, '/resources/data_retention_policy');
  for (const spec of specs) {
    if (known.some((row) => row.record_class === spec.record_class)) continue;
    const draft = await ctx.attempt(OWNER, 'POST', '/retention-policies', { ...spec, effective_from: ctx.day(-365) });
    if (!draft.ok) continue;
    await ctx.attempt(LEADER, 'POST', `/retention-policies/${String(draft.json.resource_id)}/publish`, { reason: 'Phê duyệt thời hạn lưu trữ theo quy chế của Tổng công ty' }, { version: Number(draft.json.resource_version) });
  }
}

/** ADM-32: a manual backup request, approved by a second person (the database is backed up by the operator outside the application). */
async function backup(ctx: SeedContext): Promise<void> {
  const known = await ctx.get<{ items: Obj[] }>(OWNER, '/backup-requests');
  if (known.items.length > 0) return;
  const made = await ctx.attempt(OWNER, 'POST', '/backup-requests', { kind: 'full', repository: 1, reason: 'Sao lưu đầy đủ trước kỳ chốt số liệu quý theo kế hoạch của phòng công nghệ thông tin' });
  if (!made.ok) return;
  await ctx.attempt(LEADER, 'POST', `/backup-requests/${String(made.json.resource_id)}/decision`, { decision: 'approve', reason: 'Đồng ý sao lưu trước kỳ chốt số liệu' }, { version: Number(made.json.resource_version) });
}

/** The project documents of the register (ADM-DOC): the project officer uploads a small PDF and registers it. Found by title, so a second run makes nothing. Independent of the groups that run later. */
async function ensureDossierDocuments(ctx: SeedContext): Promise<void> {
  const specs = [
    { project: 'DA-PMDT105', docClass: 'DESIGN', title: 'Hồ sơ thiết kế kỹ thuật hệ thống nước làm mát tuần hoàn (bản P01)', reference: 'HS-TKKT-PMDT105/2026' },
    { project: 'DA-PMDT114', docClass: 'COST_ESTIMATE', title: 'Dự toán điều chỉnh kho chứa sản phẩm đợt 1', reference: 'DT-PMDT114/2026-D1' },
    { project: 'DA-PMTB164', docClass: 'PROCUREMENT', title: 'Hồ sơ yêu cầu gói thầu cung cấp máy nén khí', reference: 'HSYC-PMTB164/2026' },
    { project: 'DA-PMDT120', docClass: 'ACCEPTANCE', title: 'Biên bản nghiệm thu giai đoạn móng hệ thống xử lý khí thải', reference: 'BBNT-PMDT120/2026-G1' },
  ];
  const projects = await ctx.list<Obj>(OFFICER, '/resources/project');
  for (const spec of specs) {
    const project = projects.find((row) => row.code === spec.project);
    if (project === undefined) continue;
    const known = (await ctx.list<Obj>(OFFICER, '/project-documents', { project_id: String(project.id) })).find((row) => row.title === spec.title);
    if (known !== undefined) continue;
    const upload = await ctx.upload<{ file_object_key: string; file_sha256: string }>(OFFICER, '/project-documents/files', { filename: `${spec.reference.replace(/[^A-Za-z0-9]/gu, '_')}.pdf`, buffer: ctx.pdf(spec.title, spec.reference, spec.project) });
    if (!upload.ok) {
      ctx.warn(`upload of ${spec.reference} refused: HTTP ${upload.status}`);
      continue;
    }
    await ctx.attempt(OFFICER, 'POST', '/project-documents', { project_id: project.id, doc_class: spec.docClass, title: spec.title, reference: spec.reference, security_class: 'INTERNAL', file_object_key: upload.json.file_object_key, file_sha256: upload.json.file_sha256, change_note: 'Bản phát hành đầu tiên' });
  }
}

/** DOC-28 and DOC-29: project documents kept in containers (WIP, shared, published) and sent to the leaders in transmittals; one is answered. */
async function transmittals(ctx: SeedContext): Promise<void> {
  const containers = await ctx.get<{ items: Obj[] }>(OWNER, '/doc-containers');
  await ensureDossierDocuments(ctx);
  const documents = (await ctx.list<Obj>(OWNER, '/project-documents')).filter((row) => String(row.status) === 'ACTIVE');
  const chosen: Obj[] = [];
  const projects = new Set<string>();
  for (const row of documents) {
    const project = row.project as Obj;
    if (projects.has(String(project.id))) continue;
    projects.add(String(project.id));
    chosen.push(row);
    if (chosen.length >= 6) break;
  }
  const known = new Set(containers.items.map((row) => String(row.document_id)));
  const made: Obj[] = [];
  for (const row of chosen) {
    if (known.has(String(row.id))) continue;
    const project = row.project as Obj;
    const reply = await ctx.attempt(OWNER, 'POST', '/doc-containers', { project_id: project.id, document_id: row.id, document_kind: 'PROJECT_DOCUMENT', revision_label: 'P01' });
    if (reply.ok) made.push({ id: reply.json.resource_id, version: reply.json.resource_version, project: project.id, title: row.title });
  }
  const current = (await ctx.get<{ items: Obj[] }>(OWNER, '/doc-containers')).items;
  const sharable = current.filter((row) => ['WIP', 'SHARED', 'PUBLISHED'].includes(String(row.state)));
  if (sharable.length === 0) return;
  const existing = await ctx.get<{ items: Obj[] }>(OWNER, '/doc-transmittals');
  if (existing.items.length > 0) return;
  const byProject = new Map<string, Obj[]>();
  for (const row of sharable) {
    const key = String(row.project_id ?? (row.project as Obj | undefined)?.id ?? '');
    byProject.set(key, [...(byProject.get(key) ?? []), row]);
  }
  let n = 0;
  for (const [project, rows] of byProject) {
    n += 1;
    const sent = await ctx.attempt(OWNER, 'POST', '/doc-transmittals', {
      project_id: project,
      number: `CV-HS-2026/${String(n).padStart(3, '0')}`,
      purpose: n % 2 === 1 ? 'FOR_REVIEW' : 'FOR_APPROVAL',
      subject: 'Chuyển hồ sơ tài liệu dự án để lãnh đạo xem xét',
      message: 'Kính chuyển các tài liệu kèm theo để lãnh đạo cho ý kiến trước kỳ họp giao ban đầu tư.',
      container_ids: rows.map((row) => row.id),
      recipients: [
        { membership_id: ctx.person(LEADER).membershipId, required: true },
        { membership_id: ctx.person(ADMIN).membershipId, required: false },
      ],
    });
    if (sent.ok && n <= 2) {
      await ctx.attempt(LEADER, 'POST', `/doc-transmittals/${String(sent.json.resource_id)}/answer`, n === 1 ? { answer: 'APPROVED' } : { answer: 'APPROVED_WITH_COMMENTS', comment: 'Đề nghị bổ sung phụ lục thuyết minh trước khi trình ký chính thức' });
    }
  }
  // The first two containers on to PUBLISHED (the register keeps the revision that leaders reviewed).
  for (const container of (await ctx.get<{ items: Obj[] }>(OWNER, '/doc-containers')).items.filter((row) => row.state === 'SHARED').slice(0, 1)) {
    await ctx.attempt(LEADER, 'POST', `/doc-containers/${String(container.id)}/move`, { to: 'PUBLISHED', reason: 'Đã được lãnh đạo xem xét, phát hành làm hồ sơ chính thức' }, { version: Number(container.version) });
  }
}

/** AUD-19: gifts received by officers, declared to the register; two are handled by the leader (who is not the recipient): one returned, one handed to the unit. */
async function gifts(ctx: SeedContext): Promise<void> {
  const specs = [
    { who: OFFICER, giver_name: 'Công ty TNHH Xây lắp Nam Việt', giver_kind: 'CONTRACTOR', description: 'Giỏ quà Tết gồm bánh kẹo và trà', value_vnd: '350000', back: 3, outcome: 'RETURNED', note: 'Đã gửi trả lại nhà thầu kèm thư cảm ơn theo quy chế tiếp nhận quà tặng' },
    { who: LEADER, giver_name: 'Công ty CP Thiết bị Công nghiệp Phương Đông', giver_kind: 'SUPPLIER', description: 'Cuốn lịch để bàn và bút ký in logo công ty', value_vnd: '120000', back: 2, outcome: '', note: '' },
    { who: HEAD, giver_name: 'Đại diện chính quyền địa phương nơi thi công', giver_kind: 'OFFICIAL', description: 'Bức tranh lưu niệm nhân dịp thăm công trình', value_vnd: '2500000', back: 6, outcome: 'HANDED_TO_UNIT', note: 'Bàn giao cho Văn phòng Ban làm hiện vật trưng bày' },
  ];
  let register = (await ctx.get<{ items: Obj[] }>(OWNER, '/gifts')).items;
  if (register.length === 0) {
    for (const spec of specs) {
      await ctx.attempt(OWNER, 'POST', '/gifts', { recipient_id: ctx.person(spec.who).membershipId, giver_name: spec.giver_name, giver_kind: spec.giver_kind, description: spec.description, value_vnd: spec.value_vnd, received_on: ctx.day(-spec.back) });
    }
    register = (await ctx.get<{ items: Obj[] }>(OWNER, '/gifts')).items;
  }
  for (const spec of specs) {
    if (spec.outcome === '') continue;
    const gift = register.find((row) => row.description === spec.description && row.status === 'DECLARED');
    if (gift === undefined) continue;
    const taken = await ctx.attempt(LEADER, 'POST', `/gifts/${String(gift.id)}/take`, {}, { version: Number(gift.version) });
    if (!taken.ok) continue;
    await ctx.attempt(LEADER, 'POST', `/gifts/${String(gift.id)}/close`, { outcome: spec.outcome, note: spec.note }, { version: Number(taken.json.resource_version) });
  }
}

/** ADM-17: guest contractor members, one invitation for each of two contractors with active contracts (the mail goes to a reserved test domain). */
async function guests(ctx: SeedContext): Promise<void> {
  const members = await ctx.list<Obj>(OWNER, '/resources/membership');
  if (members.some((row) => row.membership_type === 'GUEST_CONTRACTOR')) return;
  const role = await ctx.find<Obj>(OWNER, '/resources/role_definition', (row) => row.code === 'GUEST_CONTRACTOR');
  if (role === undefined) return;
  const contracts = (await ctx.list<Obj>(OWNER, '/resources/contract')).filter((row) => ['ACTIVE', 'SIGNED'].includes(String(row.status)));
  const byContractor = new Map<string, Obj[]>();
  for (const row of contracts) {
    const key = String(row.contractor_id ?? '');
    if (key === '') continue;
    byContractor.set(key, [...(byContractor.get(key) ?? []), row]);
  }
  const logins = ['chi.huy.truong', 'ky.su.truong'];
  let index = 0;
  for (const [contractor, rows] of byContractor) {
    if (index >= logins.length) break;
    const active = rows.filter((row) => String(row.status) === 'ACTIVE');
    if (active.length === 0) continue;
    const initials = String(active[0]?.contractor_name ?? contractor).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/giu, 'd').split(/\s+/u).map((word) => word.charAt(0).toLowerCase()).join('').replace(/[^a-z0-9]/gu, '') || 'nhathau';
    const reply = await ctx.attempt(OWNER, 'POST', '/guest-memberships', { email: `${logins[index]}@${initials}.example.test`, contractor_id: contractor, contract_ids: active.map((row) => row.id), role_id: role.id, valid_until: days(120) });
    if (reply.ok) index += 1;
  }
}

/** ADM-16: a proposal to rename the office unit of the planning board (waits for a second person; nothing moves until it is approved). */
async function reorganisation(ctx: SeedContext): Promise<void> {
  const known = await ctx.list<Obj>(OWNER, '/resources/unit_reorganization');
  if (known.length > 0) return;
  const office = await unitIdByCode(ctx, 'DPM-KHDT-VP');
  const parent = await unitIdByCode(ctx, 'DPM-KHDT');
  if (office === undefined || parent === undefined) return;
  await ctx.attempt(OWNER, 'POST', '/unit-reorganizations', {
    kind: 'RENAME',
    effective_from: ctx.day(30),
    legal_basis_ref: 'Quyết định về việc kiện toàn cơ cấu tổ chức Ban Kế hoạch và Đầu tư của Tổng công ty',
    predecessor_unit_ids: [office],
    successors: [{ new_unit: { code: 'DPM-KHDT-HCTH', name: 'Phòng Hành chính - Tổng hợp Ban Kế hoạch và Đầu tư', parent_id: parent, unit_type: 'DEPARTMENT', valid_from: ctx.day(30) } }],
    mapping: {},
  });
}

/** AUD-13: a separation-of-duties exception (one officer may both draft and approve on one contract for two weeks), requested by the owner, the first of two approvals given by the leader (the second waits). */
async function separation(ctx: SeedContext): Promise<void> {
  const known = await ctx.get<{ items: Obj[] }>(OWNER, '/sod-exceptions');
  if (known.items.length > 0) return;
  const contract = (await ctx.list<Obj>(OWNER, '/resources/contract')).find((row) => row.code === 'HD-PMDT114-XL01') ?? (await ctx.list<Obj>(OWNER, '/resources/contract')).find((row) => row.status === 'ACTIVE');
  if (contract === undefined) return;
  const made = await ctx.attempt(OWNER, 'POST', '/sod-exceptions', {
    action_a: 'contract.draft',
    action_b: 'contract.approve',
    scope: 'SAME_CONTRACT',
    subject_id: contract.id,
    member_id: ctx.person(OFFICER).membershipId,
    reason: 'Ban quản lý dự án thiếu nhân sự trong đợt nghiệm thu cuối năm, cho phép cùng cán bộ soạn thảo và phê duyệt phụ lục hợp đồng trong hai tuần dưới sự giám sát của kiểm toán nội bộ',
    valid_from: ctx.day(0),
    valid_to: ctx.day(13),
  });
  if (!made.ok) return;
  let version = Number(made.json.resource_version);
  for (const approver of [LEADER]) {
    const done = await ctx.attempt(approver, 'POST', `/sod-exceptions/${String(made.json.resource_id)}/approve`, { comment: 'Đồng ý có thời hạn, yêu cầu kiểm toán nội bộ rà soát lại sau 2 tuần' }, { version });
    if (done.ok) version = Number(done.json.resource_version);
  }
}

/** ADM-14: the security policy of the tenant (the owner drafts, the leader publishes). The limits are stored with the version; the list of roles for two-factor is the one the screen offers. */
async function securityPolicy(ctx: SeedContext): Promise<void> {
  const known = await ctx.list<Obj>(OWNER, '/resources/security_policy_version');
  if (known.some((row) => row.status === 'Published')) return;
  const draft = known.find((row) => row.status === 'Draft') === undefined
    ? await ctx.attempt(OWNER, 'POST', '/security-policies', { mfa_required_roles: ['SECURITY_ADMIN', 'TENANT_ADMIN'], session_idle_minutes: 30, session_max_hours: 8, download_ttl_minutes: 15, export_watermark: true })
    : undefined;
  const id = draft === undefined ? String(known.find((row) => row.status === 'Draft')?.id) : String(draft.json.resource_id);
  const version = draft === undefined ? Number(known.find((row) => row.status === 'Draft')?.version) : Number(draft.json.resource_version);
  await ctx.attempt(LEADER, 'POST', `/security-policies/${id}/publish`, { reason: 'Ban hành chính sách an toàn thông tin của Tổng công ty theo quy chế an ninh mạng' }, { version });
}

/** ADM-13: one batch of data conversion of the legacy ledger of the planning office, registered and checked by a dry run (nothing is written; the apply step belongs to a second person, left for the demo). */
async function migrationBatch(ctx: SeedContext): Promise<void> {
  const known = await ctx.get<{ items: Obj[] }>(OWNER, '/migration-batches');
  if (known.items.length > 0) return;
  const rows = ['business_key,amount,note'];
  for (let n = 1; n <= 12; n += 1) rows.push(`TK-1331-${String(n).padStart(3, '0')},${String(1_000_000 * n)},Số dư đầu kỳ tài khoản ${String(n)}`);
  const file = await ctx.upload<{ file_id: string }>(OWNER, '/migration-batches/files', { filename: 'so-du-dau-ky-he-thong-cu.csv', mime: 'text/csv', buffer: Buffer.from(`${rows.join('\n')}\n`, 'utf8') });
  if (!file.ok) {
    ctx.warn(`upload of the conversion file refused: HTTP ${file.status} ${file.text.slice(0, 200)}`);
    return;
  }
  const made = await ctx.attempt(OWNER, 'POST', '/migration-batches', { source_system: 'HE_THONG_KE_TOAN_CU', target_entity: 'LEDGER_ACCOUNT', file_id: file.json.file_id, mapping_version: 'GENERIC-1' });
  if (!made.ok) return;
  await ctx.attempt(OWNER, 'POST', `/migration-batches/${String(made.json.resource_id)}/dry-run`, { reason: 'Chạy thử kiểm tra tệp số dư đầu kỳ trước khi áp dụng chính thức' }, { version: Number(made.json.resource_version) });
}

/** ADM-29 and ADM-30: full before/after values in the audit log for the contract and the payment record, and the size limits of the technical logs. */
async function logPolicies(ctx: SeedContext): Promise<void> {
  const details = await ctx.get<{ items: Obj[] }>(OWNER, '/audit-detail-policies');
  if (details.items.length === 0) {
    for (const resourceType of ['contract', 'payment_request']) {
      await ctx.attempt(OWNER, 'POST', '/audit-detail-policies', { resource_type: resourceType, enabled: true, max_bytes: 16384, sensitive_keys: ['bank_account', 'tax_code'], reason: 'Lưu đầy đủ giá trị trước và sau để kiểm toán nội bộ truy vết thay đổi hợp đồng và thanh toán', expected_version: 0 });
    }
  }
  const capacity = await ctx.get<{ policies: Obj[] }>(OWNER, '/log-capacity');
  if (capacity.policies.length === 0) {
    for (const [recordClass, maxRows] of [['idempotency_record', 5_000_000], ['outbox_event', 2_000_000], ['user_session', 1_000_000]] as const) {
      await ctx.attempt(OWNER, 'POST', '/log-capacity', { record_class: recordClass, max_rows: maxRows, warn_pct: 80, active: true, reason: 'Đặt giới hạn dung lượng nhật ký kỹ thuật theo kế hoạch hạ tầng của Tổng công ty', expected_version: 0 });
    }
  }
}

/** ADM-28: a planned absence of the owner, far enough ahead that no alert is routed to a deputy during the demo. */
async function absences(ctx: SeedContext): Promise<void> {
  const known = await ctx.get<{ items: Obj[] }>(OWNER, '/home/alert-absences');
  if (known.items.length > 0) return;
  await ctx.attempt(OWNER, 'POST', '/home/alert-absences', { kind: 'LEAVE', valid_from: days(20), valid_until: days(27), reason: 'Nghỉ phép năm theo kế hoạch của Tổng công ty' });
}

export async function seedClipEnterpriseAdmin(ctx: SeedContext): Promise<void> {
  await attempt(ctx, 'ADM', 'time-boxed delegation (ADM-04)', () => delegations(ctx));
  await attempt(ctx, 'ADM', 'permanent delegation (ADM-25)', () => standing(ctx));
  await attempt(ctx, 'ADM', 'acting on behalf (ADM-26)', () => acting(ctx));
  await attempt(ctx, 'ADM', 'period scope (ADM-27)', () => periodScope(ctx));
  await attempt(ctx, 'ADM', 'retention policies (ADM-12)', () => retention(ctx));
  await attempt(ctx, 'ADM', 'backup request (ADM-32)', () => backup(ctx));
  await attempt(ctx, 'DOC', 'document containers and transmittals (DOC-28, DOC-29)', () => transmittals(ctx));
  await attempt(ctx, 'AUD', 'gift register (AUD-19)', () => gifts(ctx));
  await attempt(ctx, 'ADM', 'guest contractor members (ADM-17)', () => guests(ctx));
  await attempt(ctx, 'ADM', 'unit reorganisation proposal (ADM-16)', () => reorganisation(ctx));
  await attempt(ctx, 'AUD', 'separation of duties exception (AUD-13)', () => separation(ctx));
  await attempt(ctx, 'ADM', 'security policy (ADM-14)', () => securityPolicy(ctx));
  await attempt(ctx, 'ADM', 'data conversion batch (ADM-13)', () => migrationBatch(ctx));
  await attempt(ctx, 'ADM', 'audit detail and log capacity policies (ADM-29, ADM-30)', () => logPolicies(ctx));
  await attempt(ctx, 'ADM', 'planned absence (ADM-28)', () => absences(ctx));
}
