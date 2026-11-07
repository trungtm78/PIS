import { vnd } from './context.ts';
import type { Obj , SeedContext} from './context.ts';

/**
 * Group `base`: the API equivalent of clips 02 and 03 of the guide, so that a seed can be developed without filming them.
 * The decision of the provincial people's committee is received, the three wards it announces are proposed, approved and published, and the
 * three projects of clip 03 are registered, with the very same codes and names: a filmed run and a seeded run are interchangeable.
 * Every step asks first and skips what exists, so after the clips (which made all this through the screens) the group does nothing.
 */

export const DECISION = { symbol: '128/QĐ-UBND', title: 'Quyết định về việc công bố danh mục địa bàn hành chính dùng chung', sender: 'Ủy ban nhân dân tỉnh Cao Bằng', issuedOn: '2026-10-12' };

export const AREAS = [
  { key: 'CB-THUC-PHAN', name: 'Phường Thục Phán' },
  { key: 'CB-NUNG-TRI-CAO', name: 'Phường Nùng Trí Cao' },
  { key: 'CB-TAN-GIANG', name: 'Phường Tân Giang' },
];

/** The projects of clip 03 (03-tao-du-an.hdsd.ts): same code, name, ward, sector and amount. */
export const BASE_PROJECTS = [
  { code: 'DA-DT205', name: 'Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12', area: 'CB-THUC-PHAN', sector: 'TRANSPORT', totalBillions: 150 },
  { code: 'DA-TH012', name: 'Xây dựng Trường Tiểu học phường Nùng Trí Cao', area: 'CB-NUNG-TRI-CAO', sector: 'EDUCATION', totalBillions: 45 },
  { code: 'DA-YT007', name: 'Nâng cấp Trạm y tế phường Tân Giang', area: 'CB-TAN-GIANG', sector: 'HEALTH', totalBillions: 12 },
];

/** The master record (version in force) of a type and key, or undefined. */
export async function masterRecord(ctx: SeedContext, type: string, key: string): Promise<Obj | undefined> {
  return ctx.find('projectManager', '/master-records', (record) => record.business_key === key, { master_type: type });
}

/** The document type of the decisions (clip 02, first step). A type that exists makes the command answer a conflict: that is the "skip". */
async function defineDecisionType(ctx: SeedContext): Promise<void> {
  const reply = await ctx.call('projectManager', 'POST', '/document-types', {
    code: 'QD',
    name: 'Quyết định',
    abbreviation: 'QĐ',
    symbol_kind: 'DECISION',
    symbol_pattern: '{number}/{type}-{agency}',
    register_code: 'SO-QD',
    legal_basis: 'Nghị định số 30/2020/NĐ-CP',
    effective_from: '2026-01-01',
  });
  if (!reply.ok && reply.json.code !== 'DOC_TYPE_RANGE_OVERLAP') ctx.expectOk(reply, 'define the document type QD');
  ctx.record({ module: 'DOC', screen: 'DOC-21', kind: 'document-type', id: String(reply.json.resource_id ?? 'QD'), code: 'QD', note: reply.ok ? 'defined' : 'existing' });
}

/** The decision arrives as a PDF letter; the id of its document is what the publication of the wards names. Returns that document id. */
async function receiveDecision(ctx: SeedContext): Promise<string> {
  const existing = await ctx.find('projectManager', '/incoming-documents', (letter) => letter.original_symbol === DECISION.symbol);
  if (existing !== undefined) {
    ctx.record({ module: 'DOC', screen: 'DOC-12', kind: 'incoming-document', id: String(existing.document_id), code: DECISION.symbol, note: 'existing' });
    return String(existing.document_id);
  }
  const pdf = ctx.pdf('UY BAN NHAN DAN TINH CAO BANG', 'Quyet dinh so 128/QD-UBND', 'Ve viec cong bo danh muc dia ban hanh chinh dung chung');
  const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>('projectManager', '/document-files', { filename: 'qd-128-cong-bo-dia-ban.pdf', buffer: pdf }), 'upload the decision file').json;
  const received = await ctx.must<{ resource_id: string; document_id: string }>('projectManager', 'POST', '/incoming-documents', {
    title: DECISION.title,
    doc_type_code: 'QD',
    channel: 'UPLOAD',
    file_object_key: uploaded.file_object_key,
    file_sha256: uploaded.file_sha256,
    original_symbol: DECISION.symbol,
    original_issued_on: DECISION.issuedOn,
    sender_name: DECISION.sender,
  });
  ctx.record({ module: 'DOC', screen: 'DOC-11', kind: 'incoming-document', id: received.document_id, code: DECISION.symbol, note: 'received' });
  return received.document_id;
}

/** A ward: proposed by the project board, approved by the leader of the department, published with the decision as its document. */
export async function publishArea(ctx: SeedContext, area: { key: string; name: string }, decisionDocumentId: string, province: Obj): Promise<void> {
  let record = await masterRecord(ctx, 'AREA', area.key);
  if (record?.status === 'EFFECTIVE') {
    ctx.record({ module: 'MDM', screen: 'MDM-25', kind: 'master-area', id: String(record.id), code: area.key, note: 'existing' });
    return;
  }
  if (record === undefined) {
    await ctx.command('projectManager', '/master-records', {
      namespace: 'TENANT',
      master_type: 'AREA',
      business_key: area.key,
      label: area.name,
      parent_record_id: province.id,
      attributes: {},
      valid_from: '2026-01-01',
      reason: 'Bổ sung địa bàn theo quyết định số 128/QĐ-UBND',
    });
    record = await masterRecord(ctx, 'AREA', area.key);
  }
  if (record === undefined) throw new Error(`the area ${area.key} cannot be found after it was proposed`);
  const changeId = String(record.open_change_request_id);
  if (record.status === 'DRAFT') {
    const change = await ctx.get('projectManager', `/master-change-requests/${changeId}`);
    await ctx.command('projectManager', `/master-change-requests/${changeId}/submit`, {}, { version: change.version });
    record = await masterRecord(ctx, 'AREA', area.key);
  }
  if (record?.status === 'IN_REVIEW') {
    const change = await ctx.get('capApprover', `/master-change-requests/${changeId}`);
    await ctx.command('capApprover', `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason: 'Đúng theo quyết định số 128/QĐ-UBND của Ủy ban nhân dân tỉnh' }, { version: change.version });
    record = await masterRecord(ctx, 'AREA', area.key);
  }
  if (record?.status === 'APPROVED') {
    await ctx.command('capApprover', `/master-records/${String(record.id)}/publish`, { decision_document_id: decisionDocumentId }, { version: Number(record.version) });
    record = await masterRecord(ctx, 'AREA', area.key);
  }
  ctx.record({ module: 'MDM', screen: 'MDM-25', kind: 'master-area', id: String(record?.id), code: area.key, note: String(record?.status) });
}

/** A project in the stage CONCEPT by the project manager of the board, on the ward and sector it concerns. */
async function registerProject(ctx: SeedContext, project: (typeof BASE_PROJECTS)[number]): Promise<void> {
  const existing = await ctx.find('projectManager', '/resources/project', (row) => row.code === project.code);
  if (existing !== undefined) {
    ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id: String(existing.id), code: project.code, note: 'existing' });
    return;
  }
  const area = await masterRecord(ctx, 'AREA', project.area);
  const sector = await masterRecord(ctx, 'SECTOR', project.sector);
  if (area?.version_id === undefined || area.version_id === null || sector?.version_id === undefined) throw new Error(`the ward ${project.area} or the sector ${project.sector} has no version in force`);
  const created = await ctx.command('projectManager', '/projects', {
    code: project.code,
    name: project.name,
    owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
    area_master_version_id: area.version_id,
    sector_master_version_id: sector.version_id,
    total_investment_vnd: vnd(project.totalBillions),
  });
  ctx.record({ module: 'PRJ', screen: 'PRJ-02', kind: 'project', id: created.resource_id, code: project.code, note: created.status });
}

export async function seedBase(ctx: SeedContext): Promise<void> {
  // In the guide run the clips made all of this through the screens: nothing is left to do.
  const clipsDone = await ctx.find('projectManager', '/resources/project', (row) => row.code === BASE_PROJECTS[0]?.code);
  if (clipsDone !== undefined) {
    ctx.log('  [base] the projects of clip 03 exist: base is skipped');
    for (const project of BASE_PROJECTS) {
      const row = await ctx.find('projectManager', '/resources/project', (candidate) => candidate.code === project.code);
      if (row !== undefined) ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project', id: String(row.id), code: project.code, note: 'existing' });
    }
    return;
  }
  await ctx.step('DOC', 'document type of the decisions', () => defineDecisionType(ctx));
  const decisionId = await ctx.step('DOC', 'receive the decision 128/QĐ-UBND', () => receiveDecision(ctx));
  const province = await ctx.step('MDM', 'find the province', async () => {
    const found = await masterRecord(ctx, 'AREA', 'CAO-BANG');
    if (found === undefined) throw new Error('the province Cao Bằng is not in the platform catalogue');
    return found;
  });
  for (const area of AREAS) await ctx.step('MDM', `ward ${area.key}`, () => publishArea(ctx, area, decisionId, province));
  for (const project of BASE_PROJECTS) await ctx.step('PRJ', `project ${project.code}`, () => registerProject(ctx, project));
}
