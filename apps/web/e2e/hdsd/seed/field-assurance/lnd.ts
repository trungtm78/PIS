import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { vnd, vndMillions } from '../context.ts';
import { MAKER, OWNER, activeContracts, asString, paper, projectOf, publishMaster, tolerate } from './shared.ts';

/**
 * LND: land clearance for the road 205 and the primary school. The story: the department cites its decision on land prices, the road is cut into four
 * sections by kilometre, the parcels in the right of way are surveyed and the households that hold them registered; a part of them have their assets
 * counted (and agree, or dispute); a compensation plan for the first section is drafted from what was agreed, posted for the thirty days of opinions and answered;
 * households complain about the price and the area; one household is offered resettlement land; the land fund centre reports its progress on the third section.
 * The plan cannot be approved (thirty days must pass) and so no payment or enforcement exists yet: that is the real state of a plan posted today.
 */

const PRICE_DECISION = 'QD-GIA-DAT-2026';

const SECTIONS = [
  { project: 'DA-DT205', code: 'DT205-KM00-03', name: 'Đoạn Km0 - Km3 (phường Thục Phán)', from: '0', to: '3', area: '21400', target: 60 },
  { project: 'DA-DT205', code: 'DT205-KM03-06', name: 'Đoạn Km3 - Km6', from: '3', to: '6', area: '18700', target: 90 },
  { project: 'DA-DT205', code: 'DT205-KM06-09', name: 'Đoạn Km6 - Km9', from: '6', to: '9', area: '24300', target: 120 },
  { project: 'DA-DT205', code: 'DT205-KM09-12', name: 'Đoạn Km9 - Km12', from: '9', to: '12', area: '19800', target: 150 },
  { project: 'DA-TH012', code: 'TH012-KHUON-VIEN', name: 'Khuôn viên khu trường mới', from: undefined, to: undefined, area: '6200', target: 75 },
];

type Use = 'AGRICULTURAL' | 'NON_AGRICULTURAL_RESIDENTIAL' | 'NON_AGRICULTURAL_OTHER' | 'PUBLIC';

const PARCELS: Array<{ code: string; project: string; section: string; address: string; use: Use; total: string; affected: string; notice?: number }> = [
  { code: 'TD-205-001', project: 'DA-DT205', section: 'DT205-KM00-03', address: 'Xóm Nà Làng, phường Thục Phán', use: 'NON_AGRICULTURAL_RESIDENTIAL', total: '412.5', affected: '86.0', notice: 52 },
  { code: 'TD-205-002', project: 'DA-DT205', section: 'DT205-KM00-03', address: 'Xóm Nà Làng, phường Thục Phán', use: 'AGRICULTURAL', total: '1840.0', affected: '620.4', notice: 52 },
  { code: 'TD-205-003', project: 'DA-DT205', section: 'DT205-KM00-03', address: 'Xóm Bản Ngà, phường Thục Phán', use: 'AGRICULTURAL', total: '960.0', affected: '210.0', notice: 52 },
  { code: 'TD-205-004', project: 'DA-DT205', section: 'DT205-KM00-03', address: 'Tổ 4, phường Thục Phán', use: 'NON_AGRICULTURAL_RESIDENTIAL', total: '268.0', affected: '64.2', notice: 40 },
  { code: 'TD-205-005', project: 'DA-DT205', section: 'DT205-KM03-06', address: 'Xóm Pác Bó, xã Hưng Đạo', use: 'AGRICULTURAL', total: '2210.0', affected: '480.0', notice: 33 },
  { code: 'TD-205-006', project: 'DA-DT205', section: 'DT205-KM03-06', address: 'Xóm Pác Bó, xã Hưng Đạo', use: 'AGRICULTURAL', total: '1320.0', affected: '305.8' },
  { code: 'TD-205-007', project: 'DA-DT205', section: 'DT205-KM03-06', address: 'Xóm Nà Lạn, xã Hưng Đạo', use: 'NON_AGRICULTURAL_OTHER', total: '740.0', affected: '152.0' },
  { code: 'TD-205-008', project: 'DA-DT205', section: 'DT205-KM06-09', address: 'Xóm Khuổi Ky, xã Hoàng Tung', use: 'AGRICULTURAL', total: '3050.0', affected: '890.0' },
  { code: 'TD-205-009', project: 'DA-DT205', section: 'DT205-KM06-09', address: 'Xóm Khuổi Ky, xã Hoàng Tung', use: 'PUBLIC', total: '520.0', affected: '95.0' },
  { code: 'TD-205-010', project: 'DA-DT205', section: 'DT205-KM09-12', address: 'Xóm Bó Mạ, xã Hoàng Tung', use: 'AGRICULTURAL', total: '1675.0', affected: '410.0' },
  { code: 'TD-012-001', project: 'DA-TH012', section: 'TH012-KHUON-VIEN', address: 'Tổ 7, phường Nùng Trí Cao', use: 'NON_AGRICULTURAL_RESIDENTIAL', total: '350.0', affected: '350.0', notice: 20 },
  { code: 'TD-012-002', project: 'DA-TH012', section: 'TH012-KHUON-VIEN', address: 'Tổ 7, phường Nùng Trí Cao', use: 'AGRICULTURAL', total: '1180.0', affected: '1180.0' },
];

const HOUSEHOLDS: Array<{ code: string; head: string; phone: string; id: string; address: string; members: number; policy?: boolean; parcels: Array<[string, 'OWNER' | 'USER' | 'LESSEE' | 'OCCUPANT_NO_TITLE', string]> }> = [
  { code: 'HO-205-01', head: 'Hoàng Văn Sính', phone: '0912345601', id: '004075012345', address: 'Xóm Nà Làng, phường Thục Phán', members: 5, parcels: [['TD-205-002', 'OWNER', '100']] },
  { code: 'HO-205-02', head: 'Nông Thị Hoa', phone: '0912345602', id: '004178023456', address: 'Xóm Nà Làng, phường Thục Phán', members: 4, parcels: [['TD-205-001', 'OWNER', '100']] },
  { code: 'HO-205-03', head: 'Lục Văn Thắng', phone: '0912345603', id: '004072034567', address: 'Xóm Bản Ngà, phường Thục Phán', members: 6, policy: true, parcels: [['TD-205-003', 'OWNER', '100']] },
  { code: 'HO-205-04', head: 'Dương Thị Lan', phone: '0912345604', id: '004180045678', address: 'Tổ 4, phường Thục Phán', members: 3, parcels: [['TD-205-004', 'OWNER', '100']] },
  { code: 'HO-205-05', head: 'Vi Văn Hải', phone: '0912345605', id: '004070056789', address: 'Xóm Pác Bó, xã Hưng Đạo', members: 7, parcels: [['TD-205-005', 'OWNER', '60'], ['TD-205-006', 'USER', '100']] },
  { code: 'HO-205-06', head: 'Ma Thị Nhung', phone: '0912345606', id: '004185067890', address: 'Xóm Pác Bó, xã Hưng Đạo', members: 4, parcels: [['TD-205-005', 'USER', '40']] },
  { code: 'HO-205-07', head: 'Bế Văn Toàn', phone: '0912345607', id: '004068078901', address: 'Xóm Nà Lạn, xã Hưng Đạo', members: 5, parcels: [['TD-205-007', 'LESSEE', '100']] },
  { code: 'HO-205-08', head: 'Tô Thị Mai', phone: '0912345608', id: '004183089012', address: 'Xóm Khuổi Ky, xã Hoàng Tung', members: 6, policy: true, parcels: [['TD-205-008', 'OWNER', '100']] },
  { code: 'HO-012-01', head: 'Đàm Văn Tiến', phone: '0912345609', id: '004071090123', address: 'Tổ 7, phường Nùng Trí Cao', members: 5, parcels: [['TD-012-001', 'OWNER', '100'], ['TD-012-002', 'OWNER', '100']] },
];

/** The items counted at each household: [household, parcel, kind, description, quantity, unit, unit price (VND), surveyed days ago, how the household answered]. */
const INVENTORY: Array<[string, string, 'LAND' | 'HOUSE' | 'STRUCTURE' | 'CROP' | 'TREE' | 'GRAVE', string, string, string, number, number, 'CONFIRMED' | 'DISPUTED' | 'DRAFT']> = [
  ['HO-205-01', 'TD-205-002', 'LAND', 'Đất trồng lúa nước bị thu hồi', '620.4', 'm2', 85000, 40, 'CONFIRMED'],
  ['HO-205-01', 'TD-205-002', 'CROP', 'Lúa vụ mùa đang trồng', '620.4', 'm2', 9200, 40, 'CONFIRMED'],
  ['HO-205-02', 'TD-205-001', 'LAND', 'Đất ở nông thôn bị thu hồi', '86', 'm2', 1850000, 38, 'CONFIRMED'],
  ['HO-205-02', 'TD-205-001', 'STRUCTURE', 'Tường rào xây gạch và cổng sắt', '24', 'm', 650000, 38, 'CONFIRMED'],
  ['HO-205-03', 'TD-205-003', 'LAND', 'Đất nương rẫy bị thu hồi', '210', 'm2', 62000, 36, 'CONFIRMED'],
  ['HO-205-03', 'TD-205-003', 'TREE', 'Cây hồng không hạt đang cho quả', '18', 'cây', 420000, 36, 'CONFIRMED'],
  ['HO-205-04', 'TD-205-004', 'HOUSE', 'Nhà cấp 4 mái tôn, tường gạch', '41', 'm2', 3200000, 30, 'DISPUTED'],
  ['HO-205-04', 'TD-205-004', 'LAND', 'Đất ở bị thu hồi', '64.2', 'm2', 1850000, 30, 'DISPUTED'],
  ['HO-205-05', 'TD-205-005', 'LAND', 'Đất trồng cây lâu năm bị thu hồi', '288', 'm2', 78000, 21, 'DRAFT'],
  ['HO-205-05', 'TD-205-006', 'TREE', 'Cây quýt đang cho quả', '35', 'cây', 380000, 21, 'DRAFT'],
  ['HO-205-07', 'TD-205-007', 'STRUCTURE', 'Nhà kho tạm lợp tôn', '60', 'm2', 780000, 18, 'DRAFT'],
  ['HO-012-01', 'TD-012-001', 'HOUSE', 'Nhà ở hai tầng mái bằng', '96', 'm2', 4800000, 22, 'CONFIRMED'],
  ['HO-012-01', 'TD-012-001', 'LAND', 'Đất ở bị thu hồi', '350', 'm2', 1650000, 22, 'CONFIRMED'],
];

async function priceDecision(ctx: SeedContext): Promise<void> {
  const decision = await paper(ctx, { symbol: '27/QĐ-UBND', title: 'Quyết định ban hành bảng giá đất giai đoạn 2026 - 2030 trên địa bàn tỉnh Cao Bằng', type: 'QD', issuedOn: '2026-01-05' });
  await publishMaster(
    ctx,
    { type: 'LND_PRICE_DECISION', key: PRICE_DECISION, label: 'Bảng giá đất tỉnh Cao Bằng giai đoạn 2026 - 2030', attributes: { title: 'Quyết định số 27/QĐ-UBND về bảng giá đất giai đoạn 2026 - 2030', issuing_authority: 'Ủy ban nhân dân tỉnh Cao Bằng' }, reason: 'Công bố bảng giá đất làm căn cứ kiểm đếm, bồi thường' },
    decision,
  );
}

const PROJECTS = ['DA-DT205', 'DA-TH012'];

/** The rows of a list that the module asks per project, for the projects of the story. */
async function perProject(ctx: SeedContext, path: string, extra: Record<string, string> = {}): Promise<Obj[]> {
  const rows: Obj[] = [];
  for (const code of PROJECTS) rows.push(...(await ctx.list(MAKER, path, { project_id: (await projectOf(ctx, code)).id, ...extra })));
  return rows;
}

async function sections(ctx: SeedContext): Promise<Map<string, Obj>> {
  const contracts = await activeContracts(ctx);
  const rows = await perProject(ctx, '/land-sections');
  const byCode = new Map(rows.map((row) => [asString(row.code), row]));
  for (const section of SECTIONS) {
    if (byCode.has(section.code)) continue;
    const project = await projectOf(ctx, section.project);
    const contract = contracts.find((row) => asString(row.project_id) === project.id);
    const made = await ctx.command(MAKER, '/land-sections', {
      project_id: project.id,
      ...(contract === undefined ? {} : { contract_id: asString(contract.id) }),
      code: section.code,
      name: section.name,
      ...(section.from === undefined ? {} : { from_km: section.from, to_km: section.to }),
      required_area_m2: section.area,
      target_date: ctx.day(section.target),
    });
    byCode.set(section.code, { id: made.resource_id, code: section.code });
    ctx.record({ module: 'LND', screen: 'LND-10', kind: 'land-section', id: made.resource_id, code: section.code, note: 'created' });
  }
  return byCode;
}

async function parcels(ctx: SeedContext, bySection: Map<string, Obj>): Promise<Map<string, Obj>> {
  const rows = await perProject(ctx, '/land-parcels');
  const byCode = new Map(rows.map((row) => [asString(row.parcel_code ?? row.code), row]));
  for (const parcel of PARCELS) {
    if (byCode.has(parcel.code)) continue;
    const project = await projectOf(ctx, parcel.project);
    const made = await ctx.command(MAKER, '/land-parcels', {
      project_id: project.id,
      section_id: asString(bySection.get(parcel.section)?.id),
      owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
      parcel_code: parcel.code,
      address_text: parcel.address,
      land_use_group: parcel.use,
      area_total_m2: parcel.total,
      area_affected_m2: parcel.affected,
    });
    byCode.set(parcel.code, { id: made.resource_id, parcel_code: parcel.code });
    ctx.record({ module: 'LND', screen: 'LND-02', kind: 'land-parcel', id: made.resource_id, code: parcel.code, note: 'surveyed' });
    if (parcel.notice !== undefined) {
      const notice = await paper(ctx, { symbol: `TB-THUHOI-${parcel.code}`, title: `Thông báo thu hồi đất thửa ${parcel.code}`, type: 'TB', sender: 'Ủy ban nhân dân huyện', issuedOn: ctx.day(-(parcel.notice as number)) });
      await tolerate(ctx, `recovery notice ${parcel.code}`, () => ctx.command(MAKER, `/land-parcels/${made.resource_id}/recovery-notice`, { notice_on: ctx.day(-(parcel.notice as number)), notice_document_version_id: notice.versionId }));
    }
  }
  return byCode;
}

async function households(ctx: SeedContext, parcelByCode: Map<string, Obj>): Promise<Map<string, Obj>> {
  const rows = await perProject(ctx, '/affected-households');
  // The code of a household is made by the product (HH-000001): the household of the story is told by the last digits of its identity number the screen shows masked.
  const byCode = new Map<string, Obj>();
  for (const household of HOUSEHOLDS) {
    const found = rows.find((row) => asString(row.national_id_masked).endsWith(household.id.slice(-4)) && (row.parcels as Obj[]).some((parcel) => parcel.parcel_code === household.parcels[0]?.[0]));
    if (found !== undefined) byCode.set(household.code, found);
  }
  for (const household of HOUSEHOLDS) {
    let record = byCode.get(household.code);
    const projectCode = household.code.startsWith('HO-205') ? 'DA-DT205' : 'DA-TH012';
    if (record === undefined) {
      const project = await projectOf(ctx, projectCode);
      const made = await ctx.command(MAKER, '/affected-households', {
        project_id: project.id,
        owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'),
        head_name: household.head,
        national_id: household.id,
        phone: household.phone,
        address_text: household.address,
        member_count: household.members,
        policy_beneficiary: household.policy === true,
        legal_basis: 'PUBLIC_TASK_LAND_LAW',
        legal_basis_ref: 'Luật Đất đai số 31/2024/QH15, Điều 87 và Điều 91',
        retention_until: ctx.day(3650),
      });
      record = { id: made.resource_id, household_code: household.code };
      byCode.set(household.code, record);
      ctx.record({ module: 'LND', screen: 'LND-03', kind: 'affected-household', id: made.resource_id, code: household.code, note: household.head });
      for (const [parcelCode, right, share] of household.parcels) {
        await tolerate(ctx, `link ${household.code} to ${parcelCode}`, () => ctx.command(MAKER, `/affected-households/${made.resource_id}/parcels`, { parcel_id: asString(parcelByCode.get(parcelCode)?.id), right_kind: right, share_pct: share }));
      }
    }
  }
  return byCode;
}

async function inventory(ctx: SeedContext, householdByCode: Map<string, Obj>, parcelByCode: Map<string, Obj>): Promise<Map<string, string[]>> {
  const existing: Obj[] = [];
  for (const household of householdByCode.values()) existing.push(...(await ctx.list(MAKER, '/land-inventory-records', { household_id: asString(household.id) })));
  const confirmedByHousehold = new Map<string, string[]>();
  const keyOf = (household: string, parcel: string, description: string): string => `${household}|${parcel}|${description}`;
  const seen = new Set(existing.map((row) => keyOf(asString(row.household_id), asString(row.parcel_id), asString(row.description))));
  for (const [code, parcelCode, kind, description, quantity, unit, price, ago, outcome] of INVENTORY) {
    const household = householdByCode.get(code);
    const parcel = parcelByCode.get(parcelCode);
    if (household === undefined || parcel === undefined) continue;
    const prior = existing.find((row) => keyOf(asString(row.household_id), asString(row.parcel_id), asString(row.description)) === keyOf(asString(household.id), asString(parcel.id), description));
    let recordId = asString(prior?.id);
    let status = asString(prior?.status);
    let version = Number(prior?.version ?? 1);
    if (!seen.has(keyOf(asString(household.id), asString(parcel.id), description))) {
      const made = await tolerate(ctx, `inventory ${code}/${description}`, () =>
        ctx.command(MAKER, '/land-inventory-records', {
          household_id: household.id,
          parcel_id: parcel.id,
          item_kind: kind,
          description,
          quantity,
          unit_code: unit,
          unit_price_vnd: String(price),
          price_decision_ref: PRICE_DECISION,
          surveyed_on: ctx.day(-ago),
        }),
      );
      if (made === undefined) continue;
      recordId = made.resource_id;
      version = made.resource_version;
      status = 'DRAFT';
      ctx.record({ module: 'LND', screen: 'LND-04', kind: 'inventory-record', id: recordId, code: `${code}/${kind}`, note: outcome });
    }
    if (status === 'DRAFT' && outcome !== 'DRAFT') {
      await tolerate(ctx, `confirm inventory ${code}/${description}`, () =>
        ctx.command(MAKER, `/land-inventory-records/${recordId}/confirm`, { outcome, household_confirmed_on: ctx.day(-(ago - 4)), note: outcome === 'DISPUTED' ? 'Hộ dân cho rằng diện tích nhà và đơn giá chưa đúng thực tế' : 'Hộ dân đã ký xác nhận biên bản kiểm đếm' }, { version }),
      );
      status = outcome;
    }
    if (status === 'CONFIRMED') confirmedByHousehold.set(code, [...(confirmedByHousehold.get(code) ?? []), recordId]);
  }
  return confirmedByHousehold;
}

/** The plan of the first section: compensation from the confirmed inventories, supports by decision, then posted for opinions with three answers. */
async function plan(ctx: SeedContext, householdByCode: Map<string, Obj>, parcelByCode: Map<string, Obj>, bySection: Map<string, Obj>): Promise<void> {
  const project = await projectOf(ctx, 'DA-DT205');
  const code = 'PA-BT-DT205-01';
  const plans = await ctx.list(MAKER, '/compensation-plans', { project_id: project.id });
  let existing = plans.find((row) => row.plan_code === code);
  if (existing === undefined) {
    const made = await ctx.command(MAKER, '/compensation-plans', { project_id: project.id, section_id: asString(bySection.get('DT205-KM00-03')?.id), executor_unit_id: ctx.unitId('CB-SKHDT-QLDA'), executor_kind: 'PROJECT_OWNER', plan_code: code });
    existing = { id: made.resource_id, status: 'DRAFT', version: made.resource_version };
    ctx.record({ module: 'LND', screen: 'LND-05', kind: 'compensation-plan', id: made.resource_id, code, note: 'drafted' });
  }
  const planId = asString(existing.id);
  const items = await ctx.list(MAKER, `/compensation-plans/${planId}/items`);
  if (items.length === 0) {
    const records: Obj[] = [];
    for (const [code, household] of householdByCode) if (code.startsWith('HO-205')) records.push(...(await ctx.list(MAKER, '/land-inventory-records', { household_id: asString(household.id) })).filter((row) => row.status === 'CONFIRMED'));
    const lines: Obj[] = records.map((row) => ({
      household_id: row.household_id,
      parcel_id: row.parcel_id,
      item_kind: row.item_kind === 'LAND' ? 'COMPENSATION_LAND' : 'COMPENSATION_ASSET',
      basis_inventory_id: row.id,
      legal_basis: 'Luật Đất đai 2024, Điều 91; Quyết định số 27/QĐ-UBND về bảng giá đất',
    }));
    for (const household of ['HO-205-01', 'HO-205-02', 'HO-205-03']) {
      const row = householdByCode.get(household);
      if (row !== undefined) lines.push({ household_id: row.id, item_kind: 'SUPPORT_LIVELIHOOD', amount_vnd: vndMillions(household === 'HO-205-03' ? 36 : 24), legal_basis: 'Quyết định số 41/2024/QĐ-UBND quy định mức hỗ trợ ổn định đời sống và sản xuất' });
    }
    const lowIncome = householdByCode.get('HO-205-02');
    if (lowIncome !== undefined) lines.push({ household_id: lowIncome.id, item_kind: 'SUPPORT_RELOCATION', amount_vnd: vndMillions(8), legal_basis: 'Quyết định số 41/2024/QĐ-UBND quy định mức hỗ trợ di chuyển chỗ ở' });
    for (const household of ['HO-205-02', 'HO-205-04']) {
      const row = householdByCode.get(household);
      if (row !== undefined) lines.push({ household_id: row.id, item_kind: 'RESETTLEMENT_LAND', amount_vnd: vndMillions(household === 'HO-205-02' ? 320 : 288), legal_basis: 'Luật Đất đai 2024, Điều 111: giao đất ở tại khu tái định cư theo suất tái định cư tối thiểu' });
    }
    if (lines.length > 0) {
      const current = await ctx.get(MAKER, '/compensation-plans', { project_id: project.id }).then((answer) => ((answer.items ?? []) as Obj[]).find((row) => row.id === planId));
      await ctx.command(MAKER, `/compensation-plans/${planId}/items`, { items: lines }, { version: Number(current?.version ?? existing.version) });
    }
  }
  const fresh = ((await ctx.get(MAKER, '/compensation-plans', { project_id: project.id })).items as Obj[]).find((row) => row.id === planId) as Obj;
  if (fresh.status === 'DRAFT') {
    await ctx.command(MAKER, `/compensation-plans/${planId}/post`, { posting_started_on: ctx.today, posting_place_text: 'Trụ sở Ủy ban nhân dân phường Thục Phán và nhà văn hóa các xóm trong khu vực dự án' }, { version: Number(fresh.version) });
  }
  const feedback = await ctx.list(MAKER, `/compensation-plans/${planId}/feedback`);
  if (feedback.length === 0) {
    const answers: Array<[string | undefined, string, 'IN_PERSON' | 'LETTER' | 'PORTAL' | 'MEETING']> = [
      ['HO-205-01', 'Đề nghị tính đơn giá lúa theo giá thị trường tại thời điểm thu hồi', 'IN_PERSON'],
      ['HO-205-04', 'Đề nghị đo lại diện tích nhà ở vì chưa tính phần hiên và mái che', 'LETTER'],
      [undefined, 'Cuộc họp dân thôn Nà Làng: nhất trí phương án, đề nghị chi trả trước Tết', 'MEETING'],
    ];
    for (const [household, summary, channel] of answers) {
      const owner = household === undefined ? undefined : householdByCode.get(household);
      await ctx.command(MAKER, `/compensation-plans/${planId}/feedback`, { ...(owner === undefined ? {} : { household_id: owner.id }), summary, channel });
    }
    const made = await ctx.list(MAKER, `/compensation-plans/${planId}/feedback`);
    const first = made.find((row) => asString(row.summary).startsWith('Đề nghị tính đơn giá lúa'));
    if (first !== undefined) await tolerate(ctx, 'handle the first feedback', () => ctx.command(MAKER, `/compensation-plans/${planId}/feedback/${asString(first.id)}/handle`, { handling_note: 'Đã giải thích đơn giá theo bảng giá đất đã ban hành, ghi nhận ý kiến vào biên bản' }));
  }
  void parcelByCode;
}

async function complaints(ctx: SeedContext, householdByCode: Map<string, Obj>): Promise<void> {
  const project = await projectOf(ctx, 'DA-DT205');
  const existing = await ctx.list(MAKER, '/land-complaints', { project_id: project.id });
  if (existing.length > 0) return;
  const spec: Array<[string, 'PRICE' | 'AREA' | 'ELIGIBILITY' | 'PROCEDURE', string, number, 'RESOLVED_ACCEPTED' | 'RESOLVED_REJECTED' | 'ESCALATED' | undefined]> = [
    ['HO-205-04', 'AREA', 'Hộ bà Dương Thị Lan khiếu nại diện tích nhà bị thu hồi chưa tính phần hiên và mái che.', 14, 'ESCALATED'],
    ['HO-205-01', 'PRICE', 'Hộ ông Hoàng Văn Sính khiếu nại đơn giá bồi thường đất trồng lúa thấp hơn giá chuyển nhượng thực tế.', 25, 'RESOLVED_REJECTED'],
    ['HO-205-03', 'ELIGIBILITY', 'Hộ ông Lục Văn Thắng đề nghị xem xét hỗ trợ thêm do thuộc diện hộ chính sách.', 31, 'RESOLVED_ACCEPTED'],
    ['HO-205-02', 'PROCEDURE', 'Hộ bà Nông Thị Hoa phản ánh chưa được mời dự buổi kiểm đếm đầu tiên.', 5, undefined],
  ];
  for (const [code, subject, description, ago, outcome] of spec) {
    const household = householdByCode.get(code);
    if (household === undefined) continue;
    const filed = await tolerate(ctx, `complaint of ${code}`, () =>
      ctx.command(MAKER, '/land-complaints', { project_id: project.id, household_id: household.id, owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'), channel: 'LETTER', subject, description, filed_on: ctx.day(-ago) }),
    );
    if (filed === undefined || outcome === undefined) continue;
    const answer = await paper(ctx, { symbol: `GQKN-${code}`, title: `Quyết định giải quyết khiếu nại của hộ ${code}`, type: 'QD', sender: 'Ủy ban nhân dân huyện', issuedOn: ctx.day(-(ago - 6)) });
    await tolerate(ctx, `resolve the complaint of ${code}`, () =>
      ctx.command(OWNER, `/land-complaints/${filed.resource_id}/resolve`, { outcome, resolved_on: ctx.day(-Math.max(ago - 6, 0)), note: outcome === 'ESCALATED' ? 'Chuyển Chủ tịch Ủy ban nhân dân huyện giải quyết lần hai' : 'Đã đối thoại với hộ dân và ban hành quyết định', ...(outcome === 'ESCALATED' ? {} : { resolution_document_version_id: answer.versionId }) }),
    );
  }
}

async function resettlement(ctx: SeedContext, householdByCode: Map<string, Obj>): Promise<void> {
  const existing = await perProject(ctx, '/resettlement-allocations');
  if (existing.length > 0) return;
  const project = await projectOf(ctx, 'DA-DT205');
  const plans = await ctx.list(MAKER, '/compensation-plans', { project_id: project.id });
  const plan = plans.find((row) => row.plan_code === 'PA-BT-DT205-01');
  const planItems = plan === undefined ? [] : await ctx.list(MAKER, `/compensation-plans/${asString(plan.id)}/items`);
  const rows: Array<[string, string, string, string, number]> = [
    ['HO-205-02', 'TDC-NL-07', 'Khu tái định cư Nà Làng, lô 07', '160', 1],
    ['HO-205-04', 'TDC-NL-12', 'Khu tái định cư Nà Làng, lô 12', '144', 2],
  ];
  for (const [code, unit, site, area, rank] of rows) {
    const household = householdByCode.get(code);
    if (household !== undefined) await tolerate(ctx, `resettlement of ${code}`, () => ctx.command(MAKER, '/resettlement-allocations', { household_id: household.id, ...(planItems.find((item) => item.household_id === household.id && item.item_kind === 'RESETTLEMENT_LAND') === undefined ? {} : { plan_item_id: asString(planItems.find((item) => item.household_id === household.id && item.item_kind === 'RESETTLEMENT_LAND')?.id) }), owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'), unit_kind: 'PLOT', unit_code: unit, site_text: site, area_m2: area, priority_rank: rank }));
  }
}

async function progress(ctx: SeedContext, bySection: Map<string, Obj>): Promise<void> {
  const project = await projectOf(ctx, 'DA-DT205');
  const section = bySection.get('DT205-KM06-09');
  if (section === undefined) return;
  const evidence = await paper(ctx, { symbol: 'BC-TD-GPMB-KM06-09', title: 'Báo cáo tiến độ giải phóng mặt bằng đoạn Km6 - Km9 của Trung tâm phát triển quỹ đất', type: 'BC', sender: 'Trung tâm phát triển quỹ đất', issuedOn: ctx.day(-2) });
  const report: Array<['SURVEY' | 'NOTICE' | 'INVENTORY', number, number, string?]> = [
    ['SURVEY', 41, 41],
    ['NOTICE', 41, 33],
    ['INVENTORY', 41, 12, 'Một số hộ vắng mặt dịp thu hoạch, đã hẹn lại lịch kiểm đếm'],
  ];
  for (const [stage, total, done, blocker] of report) {
    await tolerate(ctx, `progress ${stage}`, () =>
      ctx.command(MAKER, '/land-stage-progress/report', {
        project_id: project.id,
        section_id: asString(section.id),
        stage_code: stage,
        executor_kind: 'LAND_FUND_CENTRE',
        executor_unit_id: ctx.unitId('CB-SKHDT-VP'),
        mode: 'TRACKED_EXTERNAL',
        parcels_total: total,
        parcels_done: done,
        planned_start: ctx.day(-60),
        planned_end: ctx.day(30),
        actual_start: ctx.day(-55),
        evidence_document_version_id: evidence.versionId,
        ...(blocker === undefined ? {} : { blocker_note: blocker }),
      }),
    );
  }
}

async function dataRequest(ctx: SeedContext, householdByCode: Map<string, Obj>): Promise<void> {
  const household = householdByCode.get('HO-205-06');
  if (household === undefined) return;
  await tolerate(ctx, 'data request of HO-205-06', () => ctx.command(MAKER, `/affected-households/${asString(household.id)}/data-requests`, { request_kind: 'ACCESS', requester_verified: true, outcome: 'FULFILLED', reason: 'Đã cung cấp bản sao thông tin của hộ sau khi xác minh người yêu cầu' }));
}

export async function seedLnd(ctx: SeedContext): Promise<void> {
  void vnd;
  await ctx.step('LND', 'decision on land prices (catalogue)', () => priceDecision(ctx));
  const bySection = await ctx.step('LND', 'sections of the road and the school', () => sections(ctx));
  const parcelByCode = await ctx.step('LND', 'parcels in the right of way', () => parcels(ctx, bySection));
  const householdByCode = await ctx.step('LND', 'affected households and their parcels', () => households(ctx, parcelByCode));
  await ctx.step('LND', 'inventory of assets', () => inventory(ctx, householdByCode, parcelByCode));
  await ctx.step('LND', 'compensation plan posted for opinions', () => plan(ctx, householdByCode, parcelByCode, bySection));
  await ctx.step('LND', 'complaints', () => complaints(ctx, householdByCode));
  await ctx.step('LND', 'resettlement', () => resettlement(ctx, householdByCode));
  await ctx.step('LND', 'progress of the land fund centre', () => progress(ctx, bySection));
  await ctx.step('LND', 'data request', () => dataRequest(ctx, householdByCode));
}
