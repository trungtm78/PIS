import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';

/**
 * Group `clip-ent-ops`: gaps of the main menus that the other enterprise groups leave empty (directive timelines DIR-03/04, the steering board roster and
 * decisions BAN-*, the early-warning registers of contracts CTR-35/36). Every step asks first what exists, so a second run changes nothing; a step the
 * product refuses is written as a warning and the group goes on. It never touches the snapshot, the capital plans, the contracts' status or the payments.
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const CHECKER = 'owner';
const HEAD = 'docHead';

const asString = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

interface Paper {
  documentId: string;
  versionId: string;
}

/** A letter received through DOC (a small PDF): the evidence a directive or a meeting cites. */
async function evidencePaper(ctx: SeedContext, symbol: string, title: string, sender: string, ago: number): Promise<Paper | undefined> {
  const letters = await ctx.list(MAKER, '/incoming-documents');
  const existing = letters.find((letter) => letter.original_symbol === symbol);
  if (existing !== undefined) {
    const versionId = asString(existing.version_id ?? existing.current_version_id);
    if (versionId !== '') return { documentId: asString(existing.document_id), versionId };
  }
  const bytes = ctx.pdf(sender, symbol, title);
  const sent = await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/document-files', { filename: `${symbol.replace(/[^A-Za-z0-9]+/gu, '-')}.pdf`, buffer: bytes });
  if (!sent.ok) {
    ctx.warn(`upload of ${symbol} refused: HTTP ${sent.status}`);
    return undefined;
  }
  const received = await ctx.attempt<{ resource_id: string; resource_version: number; document_id: string; version_id: string }>(MAKER, 'POST', '/incoming-documents', {
    title,
    doc_type_code: 'BC',
    channel: 'UPLOAD',
    file_object_key: sent.json.file_object_key,
    file_sha256: sent.json.file_sha256,
    original_symbol: symbol,
    original_issued_on: ctx.day(-ago),
    sender_name: sender,
    ...(existing === undefined ? {} : { duplicate_override_reason: 'Nhập lại văn bản để lấy mã tham chiếu' }),
  });
  if (!received.ok) return undefined;
  // Registering the letter in the incoming register puts it in force (best effort: the evidence check may not need it).
  const register = await ctx.find(MAKER, '/document-number-registers', (row) => row.register_code === 'DEN' && Number(row.year) === ctx.year);
  if (register !== undefined) await ctx.attempt(MAKER, 'POST', `/incoming-documents/${received.json.resource_id}/registration`, { register_id: asString(register.id) }, { version: received.json.resource_version });
  return { documentId: received.json.document_id, versionId: received.json.version_id };
}

// ---- DIR-03 / DIR-04: the timelines of the directives of the steering meetings ---------------------------------------------------------------

interface DirectiveStep {
  code: string;
  progress: Array<{ note: string; pct: number; evidence?: boolean }>;
  extension?: { to: number; reason: string; decision?: 'approve' | 'reject'; decisionReason?: string };
  close?: string;
}

const DIRECTIVE_STEPS: DirectiveStep[] = [
  {
    code: 'GB-2026-001/CD-01',
    progress: [{ note: 'Đã hoàn thành thiết kế kỹ thuật phần cơ khí, đang chờ đơn vị tư vấn thẩm tra phần điện và tự động hóa trước khi trình thẩm định.', pct: 60 }],
    extension: { to: 40, reason: 'Đề nghị gia hạn thêm 40 ngày kể từ hôm nay do tư vấn thẩm tra yêu cầu bổ sung bản vẽ đấu nối với hệ thống nước làm mát đang vận hành.' },
  },
  {
    code: 'GB-2026-001/CD-02',
    progress: [
      { note: 'Đã làm việc với hai ngân hàng thương mại, nhận được chào lãi suất sơ bộ cho khoản vay dự án.', pct: 40 },
      { note: 'Hoàn thiện dự thảo báo cáo phương án vay vốn thương mại, đính kèm bảng so sánh lãi suất và lịch trả nợ.', pct: 90, evidence: true },
    ],
    close: 'Báo cáo phương án vay vốn đã được trình Hội đồng thành viên và thống nhất phương án vay của ngân hàng thứ nhất.',
  },
  {
    code: 'GB-2026-002/CD-01',
    progress: [{ note: 'Đã rà soát tiến độ giải ngân vốn chủ sở hữu của các dự án chậm, lập bảng cam kết giải ngân theo tuần cho từng dự án.', pct: 50 }],
    extension: { to: 45, reason: 'Đề nghị gia hạn thêm 20 ngày do một số hồ sơ thanh toán chờ nghiệm thu khối lượng tháng 11.', decision: 'approve', decisionReason: 'Đồng ý gia hạn, yêu cầu báo cáo tiến độ hằng tuần cho Ban Kế hoạch và Đầu tư.' },
  },
  {
    code: 'GB-2026-002/CD-02',
    progress: [{ note: 'Đã lập danh sách hợp đồng mua sắm thiết bị cần rà soát, tổng hợp 4 vướng mắc về giao hàng của nhà sản xuất.', pct: 25 }],
    extension: { to: 50, reason: 'Đề nghị gia hạn đến giữa tháng 12 để chờ phản hồi chính thức của nhà sản xuất về lịch giao lô thiết bị thứ hai.', decision: 'reject', decisionReason: 'Không gia hạn: hạn hiện tại vẫn đủ để báo cáo bằng số liệu đã có, phần chờ phản hồi bổ sung sau.' },
  },
  {
    code: 'GB-2026-002/CD-03',
    progress: [{ note: 'Đã đối chiếu 7 trên 10 dự án với số liệu của hệ thống kế toán, còn 3 dự án lệch số kỳ tháng 8 đang chờ Ban Tài chính Kế toán xác nhận.', pct: 70 }],
  },
  {
    code: 'GB-2026-003/CD-01',
    progress: [{ note: 'Đang tổng hợp số liệu về tiến độ gói thầu thiết bị chính để lập báo cáo gửi Tập đoàn.', pct: 15 }],
  },
];

async function seedDirectiveTimelines(ctx: SeedContext): Promise<void> {
  const directives = await ctx.list(MAKER, '/directives');
  const byCode = new Map(directives.map((row) => [asString(row.code), row]));
  let done = 0;
  for (const step of DIRECTIVE_STEPS) {
    const row = byCode.get(step.code);
    if (row === undefined) {
      ctx.warn(`directive ${step.code} does not exist: skipped`);
      continue;
    }
    const id = asString(row.id);
    const read = async (): Promise<{ directive: Obj; timeline: Obj[] }> => {
      const detail = await ctx.get<Obj>(MAKER, `/directives/${id}`);
      return { directive: asObj(detail.directive), timeline: (Array.isArray(detail.timeline) ? detail.timeline : []) as Obj[] };
    };
    let state = await read();
    const has = (type: string): boolean => state.timeline.some((event) => event.type === type);
    if (!has('PROGRESS')) {
      let n = 0;
      for (const item of step.progress) {
        n += 1;
        let evidence: string[] | undefined;
        if (item.evidence === true) {
          const paper = await evidencePaper(ctx, `BC-TD-${step.code.replace(/[^A-Za-z0-9]+/gu, '')}-${n}`, 'Báo cáo tiến độ thực hiện chỉ đạo', 'Ban Quản lý dự án đầu tư của Tổng công ty', 3);
          if (paper !== undefined) evidence = [paper.versionId];
        }
        const reply = await ctx.attempt(MAKER, 'POST', `/directives/${id}/progress`, { note: item.note, progress_pct: item.pct, ...(evidence === undefined ? {} : { evidence_document_version_ids: evidence }) });
        if (reply.ok) done += 1;
      }
      state = await read();
    }
    if (step.extension !== undefined && !has('EXTENSION_REQUESTED')) {
      const due = asString(state.directive.due_on);
      const base = due < ctx.today ? ctx.today : due;
      const proposed = shift(base, step.extension.to - (due < ctx.today ? 0 : 0));
      const asked = await ctx.attempt<Obj>(MAKER, 'POST', `/directives/${id}/extension-requests`, { proposed_due_on: proposed, reason: step.extension.reason });
      if (asked.ok) {
        done += 1;
        const extensionId = asString(asked.json.extension_id);
        if (step.extension.decision !== undefined && extensionId !== '') {
          const decided = await ctx.attempt(LEADER, 'POST', `/directive-extensions/${extensionId}/decision`, { decision: step.extension.decision, reason: step.extension.decisionReason ?? 'Đã xem xét.' }, { version: 1 });
          if (decided.ok) done += 1;
        }
      }
      state = await read();
    }
    if (step.close !== undefined && !has('CLOSED')) {
      const paper = await evidencePaper(ctx, `BB-HT-${step.code.replace(/[^A-Za-z0-9]+/gu, '')}`, 'Biên bản xác nhận hoàn thành chỉ đạo', 'Ban Kế hoạch và Đầu tư của Tổng công ty', 1);
      const closed = await ctx.attempt(LEADER, 'POST', `/directives/${id}/closure`, { note: step.close, ...(paper === undefined ? {} : { evidence_document_version_ids: [paper.versionId] }) }, { version: Number(state.directive.version) });
      if (closed.ok) done += 1;
    }
  }
  ctx.record({ module: 'DIR', kind: 'directive-timeline', id: 'ops', code: 'GB-2026', note: `${done} timeline commands` });
}

function shift(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---- BAN: the roster of the steering board and its decisions on the projects that need attention ---------------------------------------------

async function seedSteeringBoard(ctx: SeedContext): Promise<void> {
  const roster = await ctx.get<Obj>(HEAD, '/committee/roster');
  const committees = (Array.isArray(roster.committees) ? roster.committees : []) as Obj[];
  let committee = committees.find((row) => row.code === 'BCD_DPM_2026');
  if (committee === undefined) {
    const made = await ctx.attempt<Obj>(MAKER, 'POST', '/committee/roster', {
      code: 'BCD_DPM_2026',
      name: 'Ban chỉ đạo đầu tư của Tổng công ty Đạm Phú Mỹ',
      legal_basis: 'Quyết định số 120/QĐ-HĐTV của Hội đồng thành viên về việc thành lập Ban chỉ đạo đầu tư và giải ngân vốn năm 2026',
    });
    if (made.ok) committee = { id: made.json.resource_id, members: [] };
  }
  if (committee === undefined) return;
  const existingMembers = new Set(((Array.isArray(committee.members) ? committee.members : []) as Obj[]).map((member) => asString(member.membership_id)));
  const members: Array<{ person: string; role: string; agency: string; code: string }> = [
    { person: HEAD, role: 'HEAD', agency: 'Văn phòng Hội đồng thành viên', code: 'DPM-HQ' },
    { person: LEADER, role: 'DEPUTY', agency: 'Ban Kế hoạch và Đầu tư', code: 'DPM-KHDT' },
    { person: CHECKER, role: 'MEMBER', agency: 'Tổng công ty Đạm Phú Mỹ', code: 'DPM-HQ' },
    { person: 'treasuryMaker', role: 'MEMBER', agency: 'Ban Tài chính Kế toán', code: 'DPM-TCKT' },
    { person: MAKER, role: 'SECRETARIAT', agency: 'Ban Quản lý dự án đầu tư', code: 'DPM-KHDT-QLDA' },
  ];
  // The appointment names the system role the seat needs (head, secretariat, member); the roster says so when the person lacks it, so the roles are granted first.
  const roleOf: Record<string, string> = { HEAD: 'COMMITTEE_HEAD', SECRETARIAT: 'COMMITTEE_SECRETARIAT', DEPUTY: 'COMMITTEE_MEMBER', MEMBER: 'COMMITTEE_MEMBER' };
  const roles = await ctx.list(CHECKER, '/resources/role_definition');
  for (const member of members) {
    const role = roles.find((row) => row.code === roleOf[member.role]);
    if (role === undefined) continue;
    const membershipId = ctx.person(member.person).membershipId;
    const granted = await ctx.find(CHECKER, '/resources/role_grant', (row: Obj) => row.membership_id === membershipId && row.role_id === role.id && String(row.status).toUpperCase() === 'ACTIVE');
    if (granted === undefined) await ctx.attempt(member.person === CHECKER ? LEADER : CHECKER, 'POST', '/role-grants', { membership_id: membershipId, role_id: asString(role.id), scope_kind: 'TENANT', reason: 'Bổ nhiệm vào Ban chỉ đạo đầu tư theo Quyết định số 120/QĐ-HĐTV' });
  }
  for (const member of members) {
    if (existingMembers.has(ctx.person(member.person).membershipId)) continue;
    await ctx.attempt(member.person === MAKER ? CHECKER : MAKER, 'POST', '/committee/roster/members', {
      committee_id: asString(committee.id),
      membership_id: ctx.person(member.person).membershipId,
      committee_role: member.role,
      valid_from: ctx.day(-60),
      agency_code: member.code,
      agency_name: member.agency,
      decision_ref: '120/QĐ-HĐTV',
    });
  }

  // The head decides on the projects of the attention list (BAN-02): acknowledged, directed, deferred.
  const attention = await ctx.attempt<Obj>(HEAD, 'GET', '/committee/attention');
  const items = attention.ok && Array.isArray(attention.json.items) ? (attention.json.items as Obj[]) : [];
  const decided = items.filter((item) => asObj(item.decision).decision !== undefined || item.last_decision !== undefined || item.decision_state !== undefined);
  if (decided.length === 0) {
    const directives = await ctx.list(MAKER, '/directives');
    const picks = items.slice(0, 4);
    let index = 0;
    for (const item of picks) {
      const projectId = asString(item.project_id ?? asObj(item.project).id);
      if (projectId === '') continue;
      const decisions: Array<Obj> = [
        { decision: 'ACKNOWLEDGED', note: 'Ban đã nghe báo cáo, yêu cầu chủ đầu tư nộp báo cáo giải trình trong tuần tới.' },
        { decision: 'DEFERRED', note: 'Theo dõi thêm sau khi có số liệu giải ngân tháng 11.', defer_until: ctx.day(14) },
        { decision: 'ACKNOWLEDGED', note: 'Đã ghi nhận nguyên nhân chậm do chờ nghiệm thu khối lượng.' },
        { decision: 'DIRECTED', note: 'Giao Ban Quản lý dự án đầu tư báo cáo biện pháp tăng tốc trong cuộc giao ban tới.' },
      ];
      const pick = decisions[index % decisions.length] ?? decisions[0] ?? {};
      index += 1;
      const body: Obj = { project_id: projectId, ...pick };
      if (pick.decision === 'DIRECTED') {
        const directive = directives.find((row) => asString(asObj(row.project).id) === projectId);
        if (directive !== undefined) body.directive_id = asString(directive.id);
      }
      await ctx.attempt(HEAD, 'POST', '/committee/attention/decisions', body);
    }
  }
  const evaluated = await ctx.attempt<Obj>(MAKER, 'POST', '/committee/alerts/evaluate', {});
  if (evaluated.ok) {
    const alerts = (Array.isArray(evaluated.json.alerts) ? evaluated.json.alerts : []) as Obj[];
    const open = alerts.find((alert) => alert.status === 'LIVE' || alert.status === 'OPEN');
    if (open !== undefined && alerts.every((alert) => alert.acknowledged_at === undefined || alert.acknowledged_at === null)) {
      await ctx.attempt(HEAD, 'POST', `/committee/alerts/${asString(open.id)}/acknowledgement`, { note: 'Ban chỉ đạo đã nhận cảnh báo, giao Ban Quản lý dự án đầu tư báo cáo nguyên nhân.' }, { version: Number(open.version ?? 1) });
    }
  }
  ctx.record({ module: 'BAN', kind: 'committee', id: asString(committee.id), code: 'BCD_DPM_2026', note: `${members.length} members` });
}

// ---- CTR-35 / CTR-36: the early-warning register of the contracts -------------------------------------------------------------------------------

interface WarningSpec {
  contract: string;
  title: string;
  description: string;
  category: string;
  party: string;
  ago: number;
  likelihood: 'LOW' | 'MEDIUM' | 'HIGH';
  timeDays: number;
  costVnd: string;
  actions: Array<{ text: string; due: number; done?: string }>;
  close?: { outcome: 'RESOLVED' | 'WITHDRAWN'; reason: string };
}

const WARNINGS: WarningSpec[] = [
  {
    contract: 'HD-PMDT105-XL01',
    title: 'Nguy cơ chậm giao thiết bị bơm tuần hoàn từ nhà sản xuất',
    description: 'Nhà sản xuất thông báo lịch sản xuất lô bơm tuần hoàn kéo dài thêm 3 tuần, ảnh hưởng mốc lắp đặt trạm bơm số 2.',
    category: 'TIME',
    party: 'CONTRACTOR',
    ago: 20,
    likelihood: 'HIGH',
    timeDays: 21,
    costVnd: '420000000',
    actions: [
      { text: 'Làm việc với nhà sản xuất để chốt lịch giao hàng theo từng lô nhỏ', due: 1, done: 'Đã thống nhất giao lô đầu tiên sớm hơn 10 ngày.' },
      { text: 'Lập phương án lắp đặt trạm bơm số 2 song song với lô giao sau', due: 10 },
    ],
  },
  {
    contract: 'HD-PMDT105-XL01',
    title: 'Cáp ngầm ngoài khảo sát có thể phát sinh khối lượng móng bể',
    description: 'Đã gặp cáp ngầm ngoài hồ sơ khảo sát tại vị trí móng bể số 3, cần xác nhận phương án xử lý và khối lượng bổ sung.',
    category: 'COST',
    party: 'SUPERVISOR',
    ago: 14,
    likelihood: 'MEDIUM',
    timeDays: 12,
    costVnd: '1850000000',
    actions: [{ text: 'Khảo sát bổ sung vị trí cáp ngầm và lập biên bản hiện trường', due: 1, done: 'Đã lập biên bản với đơn vị quản lý cáp.' }],
  },
  {
    contract: 'HD-PMTB164-TB01',
    title: 'Lô thiết bị đầu tiên giao chậm so với tiến độ hợp đồng',
    description: 'Máy nén khí ly tâm giao chậm 15 ngày so với lịch, nhà thầu đã bị lập hồ sơ yêu cầu phạt vi phạm.',
    category: 'TIME',
    party: 'OWNER',
    ago: 30,
    likelihood: 'HIGH',
    timeDays: 15,
    costVnd: '132300000',
    actions: [{ text: 'Theo dõi lịch vận chuyển và thông quan lô thiết bị thứ hai', due: 7 }],
  },
  {
    contract: 'HD-PMDT114-XL02',
    title: 'Chất lượng vật liệu cách nhiệt chưa đạt yêu cầu mẫu thử',
    description: 'Kết quả thí nghiệm mẫu vật liệu cách nhiệt đợt 1 thấp hơn yêu cầu kỹ thuật, nhà thầu đã thay lô vật liệu và thí nghiệm lại.',
    category: 'QUALITY',
    party: 'SUPERVISOR',
    ago: 25,
    likelihood: 'LOW',
    timeDays: 0,
    costVnd: '0',
    actions: [{ text: 'Thí nghiệm lại mẫu vật liệu thay thế tại phòng thí nghiệm độc lập', due: 1, done: 'Kết quả đạt yêu cầu.' }],
    close: { outcome: 'RESOLVED', reason: 'Mẫu thí nghiệm lại đạt yêu cầu kỹ thuật, nhà thầu đã thay toàn bộ lô vật liệu không đạt.' },
  },
  {
    contract: 'HD-PMTB168-TB01',
    title: 'Nguy cơ thay đổi thông số thiết bị phòng thí nghiệm sau khi nhà sản xuất ngừng model',
    description: 'Nhà sản xuất thông báo ngừng sản xuất một model trong danh mục, cần xác nhận thiết bị thay thế tương đương.',
    category: 'SCOPE',
    party: 'CONTRACTOR',
    ago: 8,
    likelihood: 'MEDIUM',
    timeDays: 10,
    costVnd: '260000000',
    actions: [],
  },
];

async function seedContractEarlyWarnings(ctx: SeedContext): Promise<void> {
  const contracts = new Map((await ctx.list(MAKER, '/resources/contract')).map((row) => [asString(row.code), asString(row.id)]));
  const listed = async (): Promise<Map<string, string>> => {
    const body = (await ctx.attempt<Obj>(MAKER, 'GET', '/contract-early-warnings', undefined, { query: { limit: 200 } })).json;
    return new Map(((Array.isArray(body.items) ? body.items : []) as Obj[]).map((row) => [asString(row.title), asString(row.id)]));
  };
  const known = await listed();
  const ownerId = ctx.person(MAKER).membershipId;
  let created = 0;
  for (const spec of WARNINGS) {
    const contractId = contracts.get(spec.contract);
    if (contractId === undefined) {
      ctx.warn(`contract ${spec.contract} does not exist: warning skipped`);
      continue;
    }
    let id = known.get(spec.title);
    if (id === undefined) {
      const raised = await ctx.attempt<Obj>(MAKER, 'POST', `/contracts/${contractId}/early-warnings`, { title: spec.title, description: spec.description, category: spec.category, raised_by_party: spec.party, raised_on: ctx.day(-spec.ago) });
      if (!raised.ok) continue;
      created += 1;
      id = asString(raised.json.resource_id);
      known.set(spec.title, id);
      await ctx.attempt(MAKER, 'POST', `/contract-early-warnings/${id}/assessment`, { owner_membership_id: ownerId, likelihood: spec.likelihood, expected_time_days: spec.timeDays, expected_cost_vnd: spec.costVnd }, { version: Number(raised.json.resource_version ?? 1) });
    }
    let detail = asObj((await ctx.attempt<Obj>(MAKER, 'GET', `/contract-early-warnings/${id}`)).json);
    if ((!Array.isArray(detail.actions) || detail.actions.length === 0) && !String(detail.status).startsWith('CLOSED')) {
      for (const action of spec.actions) {
        const added = await ctx.attempt<Obj>(MAKER, 'POST', `/contract-early-warnings/${id}/actions`, { description: action.text, owner_membership_id: ownerId, due_on: ctx.day(action.due) });
        if (added.ok && action.done !== undefined) await ctx.attempt(MAKER, 'POST', `/contract-early-warning-actions/${asString(added.json.resource_id)}/completion`, { outcome: 'DONE', note: action.done }, { version: Number(added.json.resource_version ?? 1) });
      }
      detail = asObj((await ctx.attempt<Obj>(MAKER, 'GET', `/contract-early-warnings/${id}`)).json);
    }
    if (spec.close !== undefined && !String(detail.status).startsWith('CLOSED')) {
      await ctx.attempt(LEADER, 'POST', `/contract-early-warnings/${id}/closure`, { outcome: spec.close.outcome, reason: spec.close.reason }, { version: Number(detail.version ?? 1) });
    }
  }
  // The review meeting of the first contract goes through its open warnings, and the register is issued.
  const first = contracts.get('HD-PMDT105-XL01');
  const firstIds = WARNINGS.filter((spec) => spec.contract === 'HD-PMDT105-XL01').map((spec) => known.get(spec.title)).filter((value): value is string => value !== undefined);
  if (first !== undefined && firstIds.length > 0) {
    const probe = asObj((await ctx.attempt<Obj>(MAKER, 'GET', `/contract-early-warnings/${firstIds[0]}`)).json);
    if (!Array.isArray(probe.reviews) || probe.reviews.length === 0) {
      const meeting = await ctx.attempt<Obj>(MAKER, 'POST', `/contracts/${first}/early-warning-meetings`, {
        held_on: ctx.day(-3),
        attendees: 'Ban Quản lý dự án đầu tư, tư vấn giám sát Bảo An, nhà thầu Nam Việt, đại diện Ban Kế hoạch và Đầu tư',
        notes: 'Họp định kỳ rà soát các cảnh báo sớm của hợp đồng xây lắp, thống nhất hành động và người chịu trách nhiệm.',
        reviews: firstIds.map((warning, index) => ({ warning_id: warning, outcome: index === 0 ? 'ACTION_AGREED' : 'UPDATED', note: index === 0 ? 'Thống nhất giao hàng theo từng lô nhỏ.' : 'Cập nhật khối lượng phát sinh dự kiến.' })),
      });
      if (meeting.ok) await ctx.attempt(MAKER, 'POST', `/contracts/${first}/early-warning-issues`, { issued_on: ctx.today, meeting_id: asString(meeting.json.resource_id) });
    }
  }
  ctx.record({ module: 'CTR', kind: 'early-warnings', id: 'ops', code: 'CTR-35', note: `${created} warnings created` });
}


export async function seedClipEnterpriseOps(ctx: SeedContext): Promise<void> {
  await ctx.step('DIR', 'directive timelines', () => seedDirectiveTimelines(ctx));
  await ctx.step('BAN', 'steering board', () => seedSteeringBoard(ctx));
  await ctx.step('CTR', 'contract early warnings', () => seedContractEarlyWarnings(ctx));
}
