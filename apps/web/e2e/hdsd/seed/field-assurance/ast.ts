import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { vnd, vndMillions } from '../context.ts';
import { CHECKER, MAKER, OWNER, activeContracts, asString, paper, tolerate } from './shared.ts';

/**
 * AST: what is handed over and what stands behind it. The story: three handovers of works. The health station's refurbishment is handed over and accepted (its
 * punch list cleared, one minor item waived), registered as assets with the commissioning paper and the maintenance plan, covered by a warranty with two
 * claims (one fixed and verified, one acknowledged and waiting for the fix). The first three kilometres of the road are handed over in part: the list of
 * defects is long, a critical one is still open, one fixed item waits for the verifier, so the handover cannot be accepted yet. A third handover is only drafted.
 * The accepted road section follows later when its list is cleared: here one road section is accepted too, with its assets and a warranty about to start.
 */

interface PunchSpec {
  description: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  location: string;
  dueIn: number;
  state: 'OPEN' | 'FIXED' | 'VERIFIED' | 'WAIVED';
}

interface HandoverSpec {
  no: string;
  project: string;
  kind: 'PARTIAL' | 'COMPLETION' | 'ASSET_TRANSFER';
  unit: string;
  plannedIn: number;
  to: 'DRAFT' | 'PUNCH' | 'ACCEPTED';
  punch: PunchSpec[];
  assets?: Array<{ code: string; name: string; billions: number; basis: 'CONTRACT_VALUE' | 'SETTLED_VALUE' | 'APPRAISED_VALUE'; warrantyMonths: number }>;
  warranty?: { scope: string; months: number; retentionMillions: number };
}

const HANDOVERS: HandoverSpec[] = [
  {
    no: 'BBBG-YT007-01',
    project: 'DA-YT007',
    kind: 'PARTIAL',
    unit: 'CB-SKHDT-VP',
    plannedIn: -12,
    to: 'ACCEPTED',
    punch: [
      { description: 'Vết nứt chân tường phòng khám số 2 chưa trát lại', severity: 'MAJOR', location: 'Phòng khám số 2', dueIn: -6, state: 'VERIFIED' },
      { description: 'Cửa sổ phòng xét nghiệm đóng không khít', severity: 'MINOR', location: 'Phòng xét nghiệm', dueIn: -4, state: 'VERIFIED' },
      { description: 'Biển chỉ dẫn lối thoát hiểm chưa lắp đủ', severity: 'MINOR', location: 'Hành lang tầng 1', dueIn: -2, state: 'WAIVED' },
    ],
    assets: [
      { code: 'TS-YT007-01', name: 'Nhà khám bệnh sau cải tạo (178 m2)', billions: 7.8, basis: 'SETTLED_VALUE', warrantyMonths: 24 },
      { code: 'TS-YT007-02', name: 'Hệ thống điện, nước và thoát nước của trạm', billions: 1.4, basis: 'CONTRACT_VALUE', warrantyMonths: 24 },
      { code: 'TS-YT007-03', name: 'Hệ thống phòng cháy chữa cháy của trạm', billions: 0.9, basis: 'CONTRACT_VALUE', warrantyMonths: 12 },
    ],
    warranty: { scope: 'Bảo hành phần xây dựng và hệ thống kỹ thuật của trạm y tế', months: 24, retentionMillions: 390 },
  },
  {
    no: 'BBBG-DT205-01',
    project: 'DA-DT205',
    kind: 'PARTIAL',
    unit: 'CB-STC',
    plannedIn: -8,
    to: 'ACCEPTED',
    punch: [{ description: 'Sơn vạch phân làn đoạn Km2+400 - Km2+800 bị mờ', severity: 'MINOR', location: 'Km2+400 - Km2+800', dueIn: -3, state: 'VERIFIED' }],
    assets: [
      { code: 'TS-DT205-01', name: 'Mặt đường bê tông nhựa Km0 - Km3', billions: 31.2, basis: 'SETTLED_VALUE', warrantyMonths: 24 },
      { code: 'TS-DT205-02', name: 'Hệ thống cống thoát nước Km0 - Km3', billions: 6.4, basis: 'CONTRACT_VALUE', warrantyMonths: 24 },
      { code: 'TS-DT205-03', name: 'Biển báo và hộ lan an toàn giao thông Km0 - Km3', billions: 1.7, basis: 'CONTRACT_VALUE', warrantyMonths: 12 },
    ],
    warranty: { scope: 'Bảo hành mặt đường và hệ thống thoát nước đoạn Km0 - Km3', months: 24, retentionMillions: 1900 },
  },
  {
    no: 'BBBG-DT205-02',
    project: 'DA-DT205',
    kind: 'PARTIAL',
    unit: 'CB-STC',
    plannedIn: 10,
    to: 'PUNCH',
    punch: [
      { description: 'Lún cục bộ mặt đường tại Km4+120, sâu khoảng 3 cm', severity: 'CRITICAL', location: 'Km4+120', dueIn: 5, state: 'OPEN' },
      { description: 'Rãnh dọc bên phải Km4+500 - Km4+700 chưa hoàn thiện mặt rãnh', severity: 'MAJOR', location: 'Km4+500 - Km4+700', dueIn: 9, state: 'FIXED' },
      { description: 'Thiếu cột Km và biển tên cầu tại Km5', severity: 'MINOR', location: 'Km5', dueIn: 12, state: 'OPEN' },
      { description: 'Lề đường chưa lu lèn đủ độ chặt tại Km5+300', severity: 'MAJOR', location: 'Km5+300', dueIn: -2, state: 'OPEN' },
    ],
  },
  { no: 'BBBG-DT205-03', project: 'DA-DT205', kind: 'ASSET_TRANSFER', unit: 'CB-STC', plannedIn: 40, to: 'DRAFT', punch: [] },
];

const CLAIMS: Array<{ project: string; no: string; defect: string; severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; location: string; ago: number; to: 'FILED' | 'ACKNOWLEDGED' | 'FIXED' | 'VERIFIED' }> = [
  { project: 'DA-YT007', no: 'BH-YT007-01', defect: 'Mái khu khám bệnh thấm nước tại góc phòng tiêm chủng khi mưa lớn', severity: 'MAJOR', location: 'Phòng tiêm chủng', ago: 6, to: 'VERIFIED' },
  { project: 'DA-YT007', no: 'BH-YT007-02', defect: 'Vòi nước chậu rửa tay phòng khám số 1 bị rò rỉ', severity: 'MINOR', location: 'Phòng khám số 1', ago: 3, to: 'ACKNOWLEDGED' },
  { project: 'DA-DT205', no: 'BH-DT205-01', defect: 'Nứt dọc mặt đường dài khoảng 14 m tại Km1+250', severity: 'MAJOR', location: 'Km1+250', ago: 2, to: 'FILED' },
];

async function handoverSpec(ctx: SeedContext, spec: HandoverSpec, contractOf: (project: string) => Obj | undefined, projectIdOf: (project: string) => string | undefined): Promise<Obj | undefined> {
  const contract = contractOf(spec.project);
  const projectId = projectIdOf(spec.project);
  if (contract === undefined || projectId === undefined) {
    ctx.warn(`AST: no contract being performed for ${spec.project}: the handover ${spec.no} is not made`);
    return undefined;
  }
  const existing = await ctx.find(MAKER, '/resources/handover', (row) => row.handover_no === spec.no);
  let handoverId = asString(existing?.id);
  if (existing === undefined) {
    const minutes = await paper(ctx, { symbol: `BB-${spec.no}`, title: `Biên bản bàn giao ${spec.no}`, type: 'BB', sender: 'Ban Quản lý dự án', issuedOn: ctx.day(spec.plannedIn < 0 ? spec.plannedIn - 3 : -2) });
    const made = await ctx.command(MAKER, '/handovers', {
      project_id: projectId,
      contract_id: asString(contract.id),
      recipient_unit_id: ctx.unitId(spec.unit),
      handover_kind: spec.kind,
      handover_no: spec.no,
      planned_on: ctx.day(spec.plannedIn),
      document_version_id: minutes.versionId,
    });
    handoverId = made.resource_id;
    ctx.record({ module: 'AST', screen: 'AST-01', kind: 'handover', id: handoverId, code: spec.no, note: spec.to });
  }
  if (spec.to === 'DRAFT') return { id: handoverId, contract, spec };
  const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/handover/${handoverId}`);
  let detail = await read();
  const items = (): Obj[] => ((detail.punch_items ?? detail.items ?? []) as Obj[]);
  if (items().length === 0) {
    for (const item of spec.punch) {
      await ctx.command(MAKER, `/handovers/${handoverId}/punch-items`, { description: item.description, severity: item.severity, location_text: item.location, responsible_contractor_id: asString(contract.contractor_id), due_on: ctx.day(item.dueIn) });
    }
    detail = await read();
  }
  for (const [index, item] of items().entries()) {
    const spec_ = spec.punch[index];
    if (spec_ === undefined) continue;
    const proof = (): Promise<Awaited<ReturnType<typeof paper>>> => paper(ctx, { symbol: `KP-${spec.no}-${index + 1}`, title: `Biên bản khắc phục hạng mục tồn tại ${index + 1} của ${spec.no}`, type: 'BB', sender: 'Nhà thầu thi công', issuedOn: ctx.day(-1) });
    if (asString(item.status) === 'OPEN' && ['FIXED', 'VERIFIED'].includes(spec_.state)) {
      const doc = await proof();
      await tolerate(ctx, `fix punch item ${index + 1} of ${spec.no}`, () => ctx.command(MAKER, `/punch-items/${asString(item.id)}/fixed`, { evidence_document_version_id: doc.versionId, note: 'Nhà thầu đã khắc phục xong, gửi hình ảnh và biên bản kiểm tra' }));
    }
    if (spec_.state === 'VERIFIED') await tolerate(ctx, `verify punch item ${index + 1} of ${spec.no}`, () => ctx.command(CHECKER, `/punch-items/${asString(item.id)}/verify`, { outcome: 'VERIFIED', note: 'Đã kiểm tra thực tế, đạt yêu cầu' }));
    if (spec_.state === 'WAIVED' && asString(item.status) === 'OPEN') await tolerate(ctx, `waive punch item ${index + 1} of ${spec.no}`, () => ctx.command(OWNER, `/punch-items/${asString(item.id)}/waive`, { waiver_reason: 'Hạng mục không ảnh hưởng đến công năng, nhà thầu cam kết lắp bổ sung trong thời gian bảo hành' }));
  }
  detail = await read();
  if (spec.to === 'ACCEPTED' && asString(detail.status) !== 'ACCEPTED') {
    const asBuilt = await paper(ctx, { symbol: `HSHC-${spec.no}`, title: `Hồ sơ hoàn công ${spec.no}`, type: 'BC', sender: 'Nhà thầu thi công', issuedOn: ctx.day(-4) });
    const manual = await paper(ctx, { symbol: `HDVH-${spec.no}`, title: `Hướng dẫn vận hành, bảo trì ${spec.no}`, type: 'BC', sender: 'Nhà thầu thi công', issuedOn: ctx.day(-4) });
    await tolerate(ctx, `accept ${spec.no}`, () =>
      ctx.command(CHECKER, `/handovers/${handoverId}/decision`, { decision: 'approve', reason: 'Đã kiểm tra hiện trường và hồ sơ, các tồn tại đã được khắc phục hoặc chấp thuận', evidence_ids: [], as_built_document_version_id: asBuilt.versionId, om_manual_document_version_id: manual.versionId }, { version: Number(detail.version) }),
    );
    detail = await read();
  }
  return { id: handoverId, contract, spec, status: asString(detail.status) };
}

async function assetsAndWarranty(ctx: SeedContext, handover: Obj): Promise<void> {
  const spec = handover.spec as HandoverSpec;
  if (handover.status !== 'ACCEPTED') return;
  const handoverId = asString(handover.id);
  const contract = handover.contract as Obj;
  const projectId = asString(contract.project_id);
  const known = await ctx.list(MAKER, '/resources/asset_record');
  const made: string[] = [];
  for (const asset of spec.assets ?? []) {
    let row = known.find((candidate) => candidate.asset_code === asset.code);
    if (row === undefined) {
      const created = await tolerate(ctx, `asset ${asset.code}`, () =>
        ctx.command(MAKER, '/asset-records', {
          project_id: projectId,
          handover_id: handoverId,
          asset_code: asset.code,
          name: asset.name,
          source_contract_id: asString(contract.id),
          recipient_unit_id: ctx.unitId(spec.unit),
          value_vnd: vnd(asset.billions),
          value_basis: asset.basis,
          funding_origin: 'Ngân sách địa phương giao hằng năm',
          warranty_until: ctx.day(asset.warrantyMonths * 30),
        }),
      );
      if (created === undefined) continue;
      row = { id: created.resource_id, version: created.resource_version };
      ctx.record({ module: 'AST', screen: 'AST-03', kind: 'asset', id: created.resource_id, code: asset.code, note: asset.name });
    }
    made.push(asString(row.id));
  }
  // The first asset is commissioned and linked to a maintenance plan.
  const first = made[0];
  if (first !== undefined) {
    const detail = await ctx.get(MAKER, `/resources/asset_record/${first}`);
    if (!detail.transferred_on && !detail.commissioning_document_version_id) {
      const commissioning = await paper(ctx, { symbol: `BBDVSD-${spec.no}`, title: `Biên bản đưa vào sử dụng ${spec.no}`, type: 'BB', sender: 'Đơn vị tiếp nhận', issuedOn: ctx.day(-1) });
      await tolerate(ctx, `transfer the asset of ${spec.no}`, () => ctx.command(MAKER, `/asset-records/${first}/transfer`, { transferred_on: ctx.today, commissioning_document_version_id: commissioning.versionId }, { version: Number(detail.version) }));
    }
    const link = await ctx.get(MAKER, `/resources/asset_record/${first}`);
    if (link.om === undefined || link.om === null) {
      const plan = await paper(ctx, { symbol: `KHBT-${spec.no}`, title: `Kế hoạch vận hành, bảo trì tài sản ${spec.no}`, type: 'BC', sender: 'Đơn vị vận hành', issuedOn: ctx.day(-1) });
      await tolerate(ctx, `maintenance plan of ${spec.no}`, () => ctx.command(MAKER, `/asset-records/${first}/om-link`, { operator_unit_id: ctx.unitId(spec.unit), om_plan_document_version_id: plan.versionId, maintenance_cycle_months: 6, next_maintenance_due: ctx.day(120) }));
    }
  }
  if (spec.warranty !== undefined) {
    const existing = await ctx.list(MAKER, '/warranty-obligations');
    if (!existing.some((row) => asString(row.handover_id ?? row.handover?.id) === handoverId)) {
      const obligation = await tolerate(ctx, `warranty of ${spec.no}`, () =>
        ctx.command(MAKER, '/warranty-obligations', {
          contract_id: asString(contract.id),
          handover_id: handoverId,
          ...(first === undefined ? {} : { asset_id: first }),
          scope_description: spec.warranty?.scope,
          starts_on: ctx.today,
          period_months: spec.warranty?.months,
          retention_amount_vnd: vndMillions(spec.warranty?.retentionMillions ?? 0),
          construction_grade: 'III',
        }),
      );
      if (obligation !== undefined) ctx.record({ module: 'AST', screen: 'AST-04', kind: 'warranty-obligation', id: obligation.resource_id, code: spec.no, note: `${spec.warranty.months} months` });
    }
  }
}

async function claims(ctx: SeedContext, contractOf: (project: string) => Obj | undefined): Promise<void> {
  const obligations = await ctx.list(MAKER, '/warranty-obligations');
  const existing = await ctx.list(MAKER, '/warranty-claims');
  for (const claim of CLAIMS) {
    const contract = contractOf(claim.project);
    const obligation = obligations.find((row) => asString(row.contract_id ?? row.contract?.id) === asString(contract?.id) && asString(row.status) !== 'CLOSED');
    if (contract === undefined || obligation === undefined) continue;
    let row = existing.find((candidate) => candidate.claim_no === claim.no);
    if (row === undefined) {
      const proof = await paper(ctx, { symbol: `BBKT-${claim.no}`, title: `Biên bản kiểm tra khuyết tật ${claim.no}`, type: 'BB', sender: 'Đơn vị vận hành', issuedOn: ctx.day(-claim.ago) });
      const filed = await tolerate(ctx, `claim ${claim.no}`, () =>
        ctx.command(MAKER, `/warranty-obligations/${asString(obligation.id)}/claims`, { claim_no: claim.no, reported_on: ctx.day(-claim.ago), defect_description: claim.defect, severity: claim.severity, location_text: claim.location, evidence_document_version_id: proof.versionId, responder_contractor_id: asString(contract.contractor_id) }),
      );
      if (filed === undefined) continue;
      row = { id: filed.resource_id, version: filed.resource_version, status: 'FILED' };
      ctx.record({ module: 'AST', screen: 'AST-05', kind: 'warranty-claim', id: filed.resource_id, code: claim.no, note: claim.to });
    }
    const id = asString(row.id);
    const status = async (): Promise<Obj> => (await ctx.list(MAKER, '/warranty-claims')).find((candidate) => candidate.id === id) ?? row;
    let current = await status();
    if (asString(current.status) === 'FILED' && ['ACKNOWLEDGED', 'FIXED', 'VERIFIED'].includes(claim.to)) {
      await tolerate(ctx, `acknowledge ${claim.no}`, () => ctx.command(MAKER, `/warranty-claims/${id}/acknowledge`, { committed_fix_on: ctx.day(claim.to === 'ACKNOWLEDGED' ? 6 : -1), note: 'Nhà thầu xác nhận và cam kết sửa chữa' }, { version: Number(current.version) }));
      current = await status();
    }
    if (['ACKNOWLEDGED'].includes(asString(current.status)) && ['FIXED', 'VERIFIED'].includes(claim.to)) {
      const proof = await paper(ctx, { symbol: `BBSC-${claim.no}`, title: `Biên bản sửa chữa ${claim.no}`, type: 'BB', sender: 'Nhà thầu thi công', issuedOn: ctx.day(-1) });
      await tolerate(ctx, `fix ${claim.no}`, () => ctx.command(MAKER, `/warranty-claims/${id}/fixed`, { fixed_on: ctx.day(-1), evidence_document_version_id: proof.versionId, note: 'Đã sửa chữa xong và vệ sinh hiện trường' }, { version: Number(current.version) }));
      current = await status();
    }
    if (asString(current.status) === 'FIXED' && claim.to === 'VERIFIED') {
      await tolerate(ctx, `verify ${claim.no}`, () => ctx.command(CHECKER, `/warranty-claims/${id}/verify`, { outcome: 'VERIFIED', cost_borne_by: 'CONTRACTOR', note: 'Đã kiểm tra, khuyết tật được khắc phục, chi phí do nhà thầu chịu' }, { version: Number(current.version) }));
    }
  }
}

async function evaluation(ctx: SeedContext, handovers: Obj[], projectIdOf: (project: string) => string | undefined): Promise<void> {
  const accepted = handovers.find((row) => row.status === 'ACCEPTED' && (row.spec as HandoverSpec).project === 'DA-YT007');
  if (accepted === undefined) return;
  const projectId = projectIdOf('DA-YT007');
  const existing = await ctx.list(MAKER, '/evaluation-triggers');
  if (projectId === undefined || existing.some((row) => asString(row.project_id ?? row.project?.id) === projectId)) return;
  await tolerate(ctx, 'evaluation trigger after the handover', () => ctx.command(MAKER, `/projects/${projectId}/evaluation-triggers`, { trigger_kind: 'POST_HANDOVER_12M', source_handover_id: asString(accepted.id), due_on: ctx.day(365) }));
}

export async function seedAst(ctx: SeedContext): Promise<void> {
  const contracts = await activeContracts(ctx);
  const projectRows = await ctx.list(MAKER, '/resources/project');
  const idByCode = new Map(projectRows.map((row) => [asString(row.code), asString(row.id)]));
  const codeById = new Map(projectRows.map((row) => [asString(row.id), asString(row.code)]));
  const contractOf = (project: string): Obj | undefined => contracts.find((row) => codeById.get(asString(row.project_id)) === project);
  if (contracts.length === 0) {
    ctx.warn('AST: no contract is being performed (the delivery group makes them): handovers, assets and warranties are not made');
    return;
  }
  const done: Obj[] = [];
  for (const spec of HANDOVERS) {
    const result = await ctx.step('AST', `handover ${spec.no} (${spec.to})`, () => handoverSpec(ctx, spec, contractOf, (code) => idByCode.get(code)));
    if (result !== undefined) done.push(result);
  }
  for (const handover of done) await ctx.step('AST', `assets and warranty of ${(handover.spec as HandoverSpec).no}`, () => assetsAndWarranty(ctx, handover));
  await ctx.step('AST', 'warranty claims', () => claims(ctx, contractOf));
  await ctx.step('AST', 'evaluation after handover', () => evaluation(ctx, done, (code) => idByCode.get(code)));
}
