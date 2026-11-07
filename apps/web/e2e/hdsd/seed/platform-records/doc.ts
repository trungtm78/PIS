import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { made, once, remembered } from './shared.ts';

/**
 * Module DOC of the group `platform-records`: the office of the Department of Planning and Investment of Cao Bang at work with documents.
 *
 * The story. The office keeps its layout of Decree 30/2020 and the library of templates of the platform pack (drafted by the project board, published by the
 * leader, confirmed by the owner for the confirmed ones), the register of outgoing documents of the year (and the closed one of last year) and the register of
 * incoming letters. Over the weeks it drafts decisions, letters and reports about the three projects and the capital plan: some are still drafts, some wait for
 * review, some wait for the leader's signature, some are signed, numbered or sealed, most are issued and sent to the units, the Treasury and the Ministry; one
 * was recalled, one replaced, one corrected, one cancelled. Letters arrive from the People's Committee, the Ministry, the Treasury, the State Audit and the
 * contractors and wait in every state of the register (received, registered, assigned, processing, resolved, filed, rejected). Finished papers are filed in
 * dossiers, closed under the retention rules and handed over to the archive.
 *
 * People: `projectManager` drafts and keeps the register (the clerk), `capApprover` is the leader who reviews and signs, `owner` assigns the letters, seals and
 * issues (the API refuses the same person twice on a chain: maker is not checker).
 */

const DRAFTER = 'projectManager';
const LEADER = 'capApprover';
const OWNER = 'owner';

const AGENCY = 'SỞ KẾ HOẠCH VÀ ĐẦU TƯ';
const PARENT_AGENCY = 'ỦY BAN NHÂN DÂN TỈNH CAO BẰNG';
const PLACE = 'Cao Bằng';
const OVERRIDE = 'Phát hành khi thể thức văn bản chờ xác nhận pháp lý, theo chỉ đạo của lãnh đạo Sở.';
const GUIDE_LEGAL_REF = 'CXN-DOC-01';

const CHECKLIST = { national_title: true, motto: true, agency_name: true, number_symbol: true, summary: true, body: true, signer_title: true, recipients: true };

/** The layout of Appendix I of Decree 30/2020 (packages/kernel/src/pdf-layout.ts, ND30_A4_STANDARD): every value inside the legal range. */
const style = (sizePt: number, flags: { bold?: boolean; italic?: boolean; uppercase?: boolean } = {}) => ({ sizePt, bold: flags.bold ?? false, italic: flags.italic ?? false, uppercase: flags.uppercase ?? false });
const LAYOUT = {
  profile_code: 'ND30_A4_STANDARD',
  margins_mm: { top: 20, bottom: 20, left: 30, right: 15 },
  font_family: 'Times New Roman',
  font_substitute: 'Tinos',
  element_styles: {
    nationalTitle: style(13, { bold: true, uppercase: true }),
    motto: style(14, { bold: true }),
    agency: style(13, { bold: true, uppercase: true }),
    number: style(13),
    placeDate: style(14, { italic: true }),
    docTypeName: style(14, { bold: true, uppercase: true }),
    summary: style(14, { bold: true }),
    body: style(14),
    signerTitle: style(14, { bold: true, uppercase: true }),
    signerName: style(14, { bold: true }),
    recipientsLabel: style(12, { bold: true, italic: true }),
    recipientsList: style(11),
    pageNumber: style(14),
  },
  signature_layout: { leaderBox: { xMm: 110, yMm: 215, widthMm: 70, heightMm: 40 }, sealBox: { xMm: 95, yMm: 225, widthMm: 40, heightMm: 40 } },
  number_field_layout: { number: { xMm: 30, yMm: 42, widthMm: 40, heightMm: 6 }, symbol: { xMm: 70, yMm: 42, widthMm: 50, heightMm: 6 }, date: { xMm: 125, yMm: 50, widthMm: 60, heightMm: 6 } },
  watermark_policy: { text: 'CHƯA XÁC NHẬN PHÁP LÝ' },
  legal_basis: 'Nghị định số 30/2020/NĐ-CP, Phụ lục I',
  effective_from: '2026-01-01',
};

/** The document types of the office. QD (decision) is declared by the base group (clip 02); a type that exists answers DOC_TYPE_RANGE_OVERLAP and is skipped. */
const DOC_TYPES = [
  { code: 'QD', name: 'Quyết định', abbreviation: 'QĐ', symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-QD' },
  { code: 'CV', name: 'Công văn', abbreviation: 'CV', symbol_kind: 'OFFICIAL_LETTER', symbol_pattern: '{number}/{agency}-VP', register_code: 'SO-CV' },
  { code: 'BC', name: 'Báo cáo', abbreviation: 'BC', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-BC' },
  { code: 'TB', name: 'Thông báo', abbreviation: 'TB', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-TB' },
  { code: 'TTR', name: 'Tờ trình', abbreviation: 'TTr', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-TTR' },
  { code: 'KH', name: 'Kế hoạch', abbreviation: 'KH', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-KH' },
  { code: 'GM', name: 'Giấy mời', abbreviation: 'GM', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-GM' },
  { code: 'BB', name: 'Biên bản', abbreviation: 'BB', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-BB' },
];
const TYPE_CODES = DOC_TYPES.map((type) => type.code);

/** The templates of the platform pack that the tenant confirms legally (the rest stay published and waiting for the confirmation, with their watermark). */
const CONFIRMED_TEMPLATES = new Set([
  'DOC-QD-CHU-TRUONG-DAU-TU',
  'DOC-QD-PHE-DUYET-DU-AN',
  'DOC-QD-GIAO-KE-HOACH-VON',
  'DOC-QD-DIEU-CHINH-KE-HOACH-VON',
  'DOC-CV-DON-DOC-GIAI-NGAN',
  'DOC-CV-DE-NGHI-DIEU-CHUYEN-VON',
  'DOC-CV-GIAI-TRINH',
  'MNE-CV3665-WEEKLY',
]);

interface Pack {
  templates: Array<{ template_code: string; group_code: string; doc_type_code: string; form_code: string | null; title: string; source_module: string | null; body_blocks: unknown; placeholder_schema: unknown; legal_basis: string; watermark_text: string; effective_from: string; effective_until?: string | null }>;
}

function readPack(): Pack {
  // The platform pack is data of the API (template-pack.json); the seed reads the same file the platform would load.
  const file = join(process.cwd(), '..', 'api', 'src', 'modules', 'doc', 'template-pack.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Pack;
}

// ---- the recipients ------------------------------------------------------------------------------------------------------------------

const KBNN = { kind: 'EXTERNAL_AGENCY', name: 'Kho bạc Nhà nước khu vực Cao Bằng', code: 'KBNN-CB' };
const BO_KHDT = { kind: 'EXTERNAL_AGENCY', name: 'Bộ Kế hoạch và Đầu tư', code: 'BKHDT' };
const UBND_TINH = { kind: 'EXTERNAL_AGENCY', name: 'Ủy ban nhân dân tỉnh Cao Bằng', code: 'UBND-CB' };
const STC = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: 'Sở Tài chính', code: 'CB-STC', unit_id: ctx.unitId('CB-STC') });
const QLDA = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: 'Ban Quản lý dự án', code: 'CB-SKHDT-QLDA', unit_id: ctx.unitId('CB-SKHDT-QLDA') });
const VP = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: 'Văn phòng Sở Kế hoạch và Đầu tư', code: 'CB-SKHDT-VP', unit_id: ctx.unitId('CB-SKHDT-VP') });

// ---- the outgoing documents ------------------------------------------------------------------------------------------------------------

/** How far a document goes on its chain; `extra` is what happens to it after the stage (recall, replacement, correction, cancellation, return). */
type Stage = 'draft' | 'review' | 'submitted' | 'signed' | 'numbered' | 'sealed' | 'issued';
type After = 'none' | 'recall' | 'replace' | 'correct' | 'cancel' | 'return' | 'distribute' | 'distribute-ack' | 'distribute-mixed' | 'verify';

interface OutgoingPlan {
  key: string;
  type: string;
  template: string;
  title: string;
  unit: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP' | 'CB-SKHDT';
  urgency?: 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC';
  subject?: { module: string; project: string };
  payload: Record<string, unknown>;
  amountVnd?: string;
  recipients: (ctx: SeedContext) => Obj[];
  upTo: Stage;
  after?: After;
}

const ORDER: Stage[] = ['draft', 'review', 'submitted', 'signed', 'numbered', 'sealed', 'issued'];
const reached = (plan: OutgoingPlan, stage: Stage): boolean => ORDER.indexOf(plan.upTo) >= ORDER.indexOf(stage);

function plans(ctx: SeedContext): OutgoingPlan[] {
  const sign = { signer_title: 'GIÁM ĐỐC', signer_name: ctx.nameOf(LEADER) };
  const face = { agency: AGENCY, parent_agency: PARENT_AGENCY, place: PLACE, ...sign };
  return [
    {
      key: 'QD-PHE-DUYET-DT205', type: 'QD', template: 'DOC-QD-PHE-DUYET-DU-AN', unit: 'CB-SKHDT-QLDA', subject: { module: 'PRJ', project: 'DA-DT205' }, upTo: 'issued', after: 'distribute-ack',
      title: 'Quyết định phê duyệt dự án Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12',
      payload: { ...face, title: 'Quyết định phê duyệt dự án Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12', grounds: 'Căn cứ Luật Đầu tư công số 58/2024/QH15; căn cứ Nghị định số 85/2025/NĐ-CP; xét đề nghị của Ban Quản lý dự án tại Tờ trình số 41/TTr-BQLDA.', body: 'Phê duyệt dự án Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12 với tổng mức đầu tư 150.000 triệu đồng, thực hiện trong giai đoạn 2026 - 2028; chủ đầu tư là Ban Quản lý dự án.' },
      amountVnd: '150000000000',
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: 'QD-PHE-DUYET-TH012', type: 'QD', template: 'DOC-QD-PHE-DUYET-DU-AN', unit: 'CB-SKHDT-QLDA', subject: { module: 'PRJ', project: 'DA-TH012' }, upTo: 'issued', after: 'distribute',
      title: 'Quyết định phê duyệt dự án Xây dựng Trường Tiểu học phường Nùng Trí Cao',
      payload: { ...face, title: 'Quyết định phê duyệt dự án Xây dựng Trường Tiểu học phường Nùng Trí Cao', grounds: 'Căn cứ Luật Đầu tư công số 58/2024/QH15; xét đề nghị của Ban Quản lý dự án tại Tờ trình số 52/TTr-BQLDA.', body: 'Phê duyệt dự án Xây dựng Trường Tiểu học phường Nùng Trí Cao với tổng mức đầu tư 45.000 triệu đồng, quy mô 18 phòng học và các hạng mục phụ trợ.' },
      amountVnd: '45000000000',
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'QD-GIAO-KE-HOACH-VON', type: 'QD', template: 'DOC-QD-GIAO-KE-HOACH-VON', unit: 'CB-SKHDT', upTo: 'issued', after: 'distribute-ack',
      title: 'Quyết định giao kế hoạch đầu tư công vốn ngân sách địa phương năm 2027 (đợt 1)',
      payload: { ...face, title: 'Quyết định giao kế hoạch đầu tư công vốn ngân sách địa phương năm 2027 (đợt 1)', grounds: 'Căn cứ Nghị quyết của Hội đồng nhân dân tỉnh về kế hoạch đầu tư công năm 2027; xét đề nghị của Sở Tài chính.', body: 'Giao kế hoạch vốn đầu tư công năm 2027 đợt 1 cho các chủ đầu tư với tổng số 210.000 triệu đồng, trong đó dự án đường tỉnh 205 là 90.000 triệu đồng.' },
      amountVnd: '210000000000',
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: 'CV-DON-DOC-GIAI-NGAN', type: 'CV', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', urgency: 'KHAN', upTo: 'issued', after: 'distribute-mixed',
      title: 'Công văn đôn đốc đẩy nhanh tiến độ giải ngân vốn đầu tư công quý IV năm 2026',
      payload: { ...face, subject: 'V/v đôn đốc đẩy nhanh tiến độ giải ngân vốn đầu tư công quý IV năm 2026', greeting: 'Kính gửi: Ban Quản lý dự án, Sở Tài chính, Kho bạc Nhà nước khu vực Cao Bằng.', body: 'Đến hết tháng này tỷ lệ giải ngân của tỉnh mới đạt 61,4% kế hoạch. Đề nghị các đơn vị hoàn thiện hồ sơ thanh toán các dự án chuyển tiếp trước ngày 15 tháng tới và báo cáo vướng mắc về Sở trước thứ Sáu hằng tuần.' },
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: 'CV-GIAI-TRINH-BO', type: 'CV', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'issued', after: 'verify',
      title: 'Công văn giải trình về việc điều chỉnh kế hoạch vốn năm 2026 theo đề nghị của Bộ Kế hoạch và Đầu tư',
      payload: { ...face, subject: 'V/v giải trình điều chỉnh kế hoạch vốn năm 2026', greeting: 'Kính gửi: Bộ Kế hoạch và Đầu tư.', body: 'Thực hiện Công văn số 3472/BKHĐT-GSTĐ, Sở báo cáo giải trình: việc điều chỉnh giảm 18.000 triệu đồng của dự án Nâng cấp Trạm y tế phường Tân Giang là do chậm giải phóng mặt bằng; số vốn này được điều chuyển cho dự án có khả năng giải ngân tốt hơn.' },
      recipients: () => [BO_KHDT],
    },
    {
      key: 'CV-DE-NGHI-DIEU-CHUYEN-VON', type: 'CV', template: 'DOC-CV-DE-NGHI-DIEU-CHUYEN-VON', unit: 'CB-SKHDT-VP', upTo: 'sealed',
      title: 'Công văn đề nghị điều chuyển vốn kế hoạch năm 2026 giữa các dự án',
      payload: { ...face, subject: 'V/v đề nghị điều chuyển vốn kế hoạch năm 2026', greeting: 'Kính gửi: Ủy ban nhân dân tỉnh Cao Bằng.', body: 'Đề nghị Ủy ban nhân dân tỉnh cho phép điều chuyển 18.000 triệu đồng từ dự án Nâng cấp Trạm y tế phường Tân Giang sang dự án Cải tạo, nâng cấp đường tỉnh 205.' },
      recipients: () => [UBND_TINH],
    },
    {
      key: 'BC-GIAI-NGAN-THANG', type: 'BC', template: 'MNE-CV3665-WEEKLY', unit: 'CB-SKHDT-VP', upTo: 'numbered',
      title: 'Báo cáo nhanh tuần về tình hình giải ngân vốn đầu tư công',
      payload: { ...face, title: 'Báo cáo nhanh tuần về tình hình giải ngân vốn đầu tư công', period: 'Tuần 44 năm 2026', body: 'Giải ngân lũy kế đạt 61,4% kế hoạch; các dự án giao thông đạt 68%, giáo dục đạt 52%, y tế đạt 47%.' },
      recipients: () => [UBND_TINH, BO_KHDT],
    },
    {
      key: 'TB-GIAO-BAN', type: 'TB', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', upTo: 'signed',
      title: 'Thông báo kết luận cuộc họp giao ban đầu tư công tháng 10 năm 2026',
      payload: { ...face, subject: 'Thông báo kết luận cuộc họp giao ban đầu tư công tháng 10 năm 2026', greeting: 'Kính gửi: Các chủ đầu tư và các phòng, ban thuộc Sở.', body: 'Giám đốc Sở kết luận: các chủ đầu tư hoàn thành thủ tục thanh toán khối lượng hoàn thành trước ngày 20; Ban Quản lý dự án báo cáo tiến độ đường tỉnh 205 hằng tuần.' },
      recipients: (c) => [QLDA(c), VP(c), STC(c)],
    },
    {
      key: 'TTR-DIEU-CHINH-VON', type: 'TTR', template: 'DOC-QD-DIEU-CHINH-KE-HOACH-VON', unit: 'CB-SKHDT-QLDA', upTo: 'submitted', urgency: 'THUONG_KHAN',
      title: 'Tờ trình đề nghị phê duyệt điều chỉnh kế hoạch vốn đầu tư công năm 2026',
      payload: { ...face, title: 'Tờ trình đề nghị phê duyệt điều chỉnh kế hoạch vốn đầu tư công năm 2026', body: 'Kính trình Ủy ban nhân dân tỉnh phê duyệt phương án điều chỉnh kế hoạch vốn đầu tư công năm 2026 gồm 3 dự án, tổng số vốn điều chỉnh 18.000 triệu đồng.' },
      amountVnd: '18000000000',
      recipients: () => [UBND_TINH],
    },
    {
      key: 'KH-KIEM-TRA-TIEN-DO', type: 'KH', template: 'DOC-QD-CHU-TRUONG-DAU-TU', unit: 'CB-SKHDT-VP', upTo: 'review',
      title: 'Kế hoạch kiểm tra tiến độ thực hiện các dự án đầu tư công quý IV năm 2026',
      payload: { ...face, title: 'Kế hoạch kiểm tra tiến độ thực hiện các dự án đầu tư công quý IV năm 2026', body: 'Đoàn kiểm tra làm việc tại 12 dự án trọng điểm từ ngày 20 tháng 11 đến ngày 05 tháng 12; nội dung gồm tiến độ thi công, giải ngân và công tác giải phóng mặt bằng.' },
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'CV-HUONG-DAN-QUYET-TOAN', type: 'CV', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'review',
      title: 'Công văn hướng dẫn hồ sơ quyết toán dự án hoàn thành năm 2026',
      payload: { ...face, subject: 'V/v hướng dẫn hồ sơ quyết toán dự án hoàn thành năm 2026', greeting: 'Kính gửi: Các chủ đầu tư.', body: 'Sở hướng dẫn các chủ đầu tư lập hồ sơ quyết toán theo Thông tư của Bộ Tài chính, nộp về Sở Tài chính trước ngày 31 tháng 12.' },
      recipients: (c) => [QLDA(c)],
    },
    {
      key: 'QD-THANH-LAP-TO-GIUP-VIEC', type: 'QD', template: 'DOC-QD-THANH-LAP-BAN-QLDA', unit: 'CB-SKHDT-VP', upTo: 'draft',
      title: 'Quyết định thành lập Tổ giúp việc triển khai kế hoạch đầu tư công năm 2027',
      payload: { ...face, title: 'Quyết định thành lập Tổ giúp việc triển khai kế hoạch đầu tư công năm 2027', grounds: 'Căn cứ Quyết định số 1523/UBND-KTTH của Ủy ban nhân dân tỉnh.', body: 'Thành lập Tổ giúp việc gồm 7 thành viên do Phó Giám đốc Sở làm Tổ trưởng.' },
      recipients: (c) => [VP(c), QLDA(c)],
    },
    {
      key: 'GM-HOP-CHU-DAU-TU', type: 'GM', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'draft', urgency: 'HOA_TOC',
      title: 'Giấy mời họp triển khai kế hoạch giải ngân tháng cuối năm với các chủ đầu tư',
      payload: { ...face, subject: 'Giấy mời họp triển khai kế hoạch giải ngân tháng cuối năm', greeting: 'Kính mời: Lãnh đạo các chủ đầu tư.', body: 'Sở tổ chức họp vào 08 giờ 00 thứ Hai tuần tới tại phòng họp tầng 2, trụ sở Sở Kế hoạch và Đầu tư.' },
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'BC-TRA-LAI', type: 'BC', template: 'MNE-CV3665-WEEKLY', unit: 'CB-SKHDT-QLDA', upTo: 'draft', after: 'return',
      title: 'Báo cáo tiến độ thực hiện dự án Nâng cấp Trạm y tế phường Tân Giang',
      payload: { ...face, title: 'Báo cáo tiến độ thực hiện dự án Nâng cấp Trạm y tế phường Tân Giang', period: 'Quý III năm 2026', body: 'Khối lượng thi công đạt 35% so với kế hoạch; chậm 12 ngày do chờ bàn giao mặt bằng.' },
      recipients: (c) => [VP(c)],
    },
    {
      key: 'QD-THU-HOI', type: 'QD', template: 'DOC-QD-CHU-TRUONG-DAU-TU', unit: 'CB-SKHDT', upTo: 'issued', after: 'recall',
      title: 'Quyết định chủ trương đầu tư dự án Sửa chữa đường nội thị phường Tân Giang',
      payload: { ...face, title: 'Quyết định chủ trương đầu tư dự án Sửa chữa đường nội thị phường Tân Giang', grounds: 'Căn cứ Luật Đầu tư công số 58/2024/QH15.', body: 'Quyết định chủ trương đầu tư dự án với tổng mức dự kiến 9.500 triệu đồng.' },
      amountVnd: '9500000000',
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'QD-THAY-THE', type: 'QD', template: 'DOC-QD-DIEU-CHINH-KE-HOACH-VON', unit: 'CB-SKHDT', upTo: 'issued', after: 'replace',
      title: 'Quyết định điều chỉnh kế hoạch vốn đầu tư công năm 2026 (đợt 2)',
      payload: { ...face, title: 'Quyết định điều chỉnh kế hoạch vốn đầu tư công năm 2026 (đợt 2)', grounds: 'Căn cứ Nghị quyết của Hội đồng nhân dân tỉnh.', body: 'Điều chỉnh kế hoạch vốn của 3 dự án với tổng số 12.000 triệu đồng.' },
      amountVnd: '12000000000',
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'CV-DINH-CHINH', type: 'CV', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', upTo: 'issued', after: 'correct',
      title: 'Công văn đề nghị báo cáo tình hình giải ngân vốn năm 2026 của các chủ đầu tư',
      payload: { ...face, subject: 'V/v đề nghị báo cáo tình hình giải ngân vốn năm 2026', greeting: 'Kính gửi: Các chủ đầu tư.', body: 'Đề nghị các chủ đầu tư báo cáo tình hình giải ngân vốn năm 2026 trước ngày 25 tháng này.' },
      recipients: (c) => [QLDA(c)],
    },
    {
      key: 'QD-HUY-DU-THAO', type: 'QD', template: 'DOC-QD-PHE-DUYET-KHLCNT', unit: 'CB-SKHDT-QLDA', upTo: 'draft', after: 'cancel',
      title: 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu gói thầu XL02 (dự thảo bị hủy)',
      payload: { ...face, title: 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu gói thầu XL02', grounds: 'Căn cứ Luật Đấu thầu số 22/2023/QH15.', body: 'Phê duyệt kế hoạch lựa chọn nhà thầu gói thầu XL02.' },
      recipients: (c) => [QLDA(c)],
    },
  ];
}

interface State extends Obj {
  id: string;
  version: number;
  documentId: string;
}

/** The ids and the version of a document on its chain, kept after every stage so that a second run goes on from where the first one stopped. */
async function stage(ctx: SeedContext, plan: OutgoingPlan, name: string, previous: State | undefined, run: (state: State | undefined) => Promise<Obj>): Promise<State> {
  return once(ctx, `doc.out.${plan.key}.${name}`, async () => ({ ...(previous ?? {}), ...(await run(previous)) }) as State) as Promise<State>;
}

async function projectId(ctx: SeedContext, code: string): Promise<string | undefined> {
  const project = await ctx.find(DRAFTER, '/projects', (row) => row.code === code || row.project_code === code);
  return project?.id as string | undefined;
}

async function createDraft(ctx: SeedContext, plan: OutgoingPlan): Promise<Obj> {
  const subject = plan.subject === undefined ? undefined : await projectId(ctx, plan.subject.project);
  const reply = await ctx.must<Obj>(DRAFTER, 'POST', '/outgoing-documents', {
    doc_type_code: plan.type,
    template_code: plan.template,
    title: plan.title,
    drafting_unit_id: ctx.unitId(plan.unit),
    urgency: plan.urgency ?? 'NORMAL',
    circulation: 'INTERNAL_CIRCULATION',
    payload: { ...plan.payload, ...(plan.amountVnd === undefined ? {} : { amount_vnd: plan.amountVnd }) },
    recipients: plan.recipients(ctx),
    signer_user_id: ctx.person(LEADER).membershipId,
    signing_mode: 'DIRECT',
    ...(subject === undefined || plan.subject === undefined ? {} : { subject_module: plan.subject.module, subject_id: subject }),
  });
  return { id: reply.resource_id, version: reply.resource_version, documentId: reply.document_id };
}

/** Takes the document of a plan as far as the plan says. */
async function advance(ctx: SeedContext, plan: OutgoingPlan, registerId: string): Promise<State> {
  let state = await stage(ctx, plan, 'draft', undefined, () => createDraft(ctx, plan));
  if (reached(plan, 'review')) {
    state = await stage(ctx, plan, 'review', state, async (s) => {
      const reply = await ctx.command(DRAFTER, `/outgoing-documents/${s!.id}/review-submission`, {}, { version: s!.version });
      return { version: reply.resource_version };
    });
  }
  if (reached(plan, 'submitted')) {
    state = await stage(ctx, plan, 'submitted', state, async (s) => {
      const reply = await ctx.command(LEADER, `/outgoing-documents/${s!.id}/review-decision`, { decision: 'APPROVE', comment: 'Đã rà soát thể thức và nội dung, đủ điều kiện trình ký.', format_checklist: CHECKLIST }, { version: s!.version });
      return { version: reply.resource_version };
    });
  }
  if (reached(plan, 'signed')) {
    state = await stage(ctx, plan, 'signed', state, async (s) => {
      const started = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${s!.id}/leader-signing-sessions`, {}, { version: s!.version });
      const done = await ctx.must<Obj>(LEADER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: started.resource_version });
      return { version: done.document_version };
    });
  }
  if (reached(plan, 'numbered')) {
    state = await stage(ctx, plan, 'numbered', state, async (s) => {
      const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${s!.id}/numbering`, { register_id: registerId, issued_on: ctx.today, clerk_note: 'Cấp số theo sổ văn bản đi của năm.' }, { version: s!.version });
      return { version: reply.resource_version, number: reply.number, symbol: reply.symbol };
    });
  }
  if (reached(plan, 'sealed')) {
    state = await stage(ctx, plan, 'sealed', state, async (s) => {
      const started = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s!.id}/organization-seal-sessions`, {}, { version: s!.version });
      const done = await ctx.must<Obj>(OWNER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: started.resource_version });
      return { version: done.document_version };
    });
  }
  if (reached(plan, 'issued')) {
    state = await stage(ctx, plan, 'issued', state, async (s) => {
      const reply = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s!.id}/issuance`, { unconfirmed_override_reason: OVERRIDE, distribute_now: false }, { version: s!.version });
      return { version: reply.resource_version, number: reply.document_number, symbol: reply.symbol };
    });
  }
  return state;
}

async function currentVersion(ctx: SeedContext, id: string): Promise<number> {
  const document = await ctx.get<Obj>(DRAFTER, `/outgoing-documents/${id}`);
  return Number(document.version ?? document.resource_version);
}

/** What happens to a document after it has gone as far as its plan says. */
async function afterwards(ctx: SeedContext, plan: OutgoingPlan, state: State, registerId: string): Promise<void> {
  const key = (name: string): string => `doc.out.${plan.key}.${name}`;
  switch (plan.after) {
    case 'distribute':
    case 'distribute-ack':
    case 'distribute-mixed': {
      const sent = await once(ctx, key('distributed'), async () => {
        const recipients = plan.recipients(ctx);
        const channelOf = (recipient: Obj): string => (recipient.kind === 'INTERNAL_UNIT' ? 'INTERNAL' : plan.after === 'distribute-mixed' && recipient.code === 'KBNN-CB' ? 'EMAIL' : recipient.code === 'BKHDT' ? 'LGSP' : 'PAPER_HANDOVER');
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/distributions`, { recipients: recipients.map((recipient) => ({ ...recipient, channel: channelOf(recipient), acknowledgement_required: true })) }, { version: await currentVersion(ctx, state.id) });
        return { distributions: (reply.distributions ?? []).map((row: Obj) => ({ id: String(row.distribution_id), status: String(row.status ?? '') })) };
      });
      if (plan.after === 'distribute-ack' || plan.after === 'distribute-mixed') {
        let first = true;
        for (const row of sent.distributions as Array<{ id: string }>) {
          await once(ctx, key(`ack.${row.id}`), async () => {
            // A recipient acknowledges; the others are still waiting (the ledger of distributions shows both).
            if (!first && plan.after === 'distribute-mixed') return { skipped: true, acknowledged: null };
            first = false;
            const found = await ctx.attempt(DRAFTER, 'POST', `/document-distributions/${row.id}/acknowledgement`, { acknowledged_at: new Date().toISOString(), external_ref: 'Đã nhận và vào sổ văn bản đến' }, { version: await distributionVersion(ctx, state.id, row.id) });
            return { skipped: false, acknowledged: found.ok };
          });
        }
      }
      break;
    }
    case 'verify':
      await once(ctx, key('verified'), async () => {
        const timeline = await ctx.get<Obj>(DRAFTER, `/documents/${state.documentId}/timeline`);
        const version = (timeline.versions as Obj[] | undefined)?.slice(-1)[0];
        if (version === undefined) return { skipped: true, overall: null, ok: null };
        const reply = await ctx.attempt(DRAFTER, 'POST', `/document-versions/${version.id}/signature-verifications`, { policy: 'STRICT' });
        return { skipped: false, overall: String(reply.json.overall ?? ''), ok: reply.ok };
      });
      break;
    case 'recall':
      await once(ctx, key('recalled'), async () => {
        const reply = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${state.id}/recall`, { reason: 'Thu hồi do văn bản ban hành khi chưa đủ hồ sơ thẩm định, sẽ ban hành lại sau khi bổ sung.', notify_recipients: true }, { version: await currentVersion(ctx, state.id) });
        return { version: reply.resource_version };
      });
      break;
    case 'correct':
      await once(ctx, key('corrected'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/corrections`, { correction_text: 'Đính chính thời hạn nộp báo cáo từ ngày 25 tháng này thành ngày 30 tháng này.', reason: 'Sai sót thời hạn nộp báo cáo khi soạn thảo văn bản.' }, { version: await currentVersion(ctx, state.id) });
        return { correctionId: reply.resource_id };
      });
      break;
    case 'replace': {
      const replacement = await once(ctx, key('replacement'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/replacements`, { title: 'Quyết định điều chỉnh kế hoạch vốn đầu tư công năm 2026 (đợt 2, thay thế)', reason: 'Thay thế do số liệu phân bổ của dự án Nâng cấp Trạm y tế phường Tân Giang đã được điều chỉnh.' }, { version: await currentVersion(ctx, state.id) });
        return { id: reply.resource_id, version: reply.resource_version, documentId: reply.document_id };
      });
      await advanceExisting(ctx, { ...plan, key: `${plan.key}.REPLACEMENT`, title: 'replacement' }, replacement as State, registerId);
      break;
    }
    case 'cancel':
      await once(ctx, key('cancelled'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/cancellation`, { reason: 'Hủy dự thảo do kế hoạch lựa chọn nhà thầu được gộp vào gói thầu XL01.', reject_code: 'CANCELLED_BY_DRAFTER' }, { version: await currentVersion(ctx, state.id) });
        return { version: reply.resource_version };
      });
      break;
    case 'return':
      await once(ctx, key('returned'), async () => {
        // The draft is sent for review and the leader returns it with the reason; it is a draft again.
        const review = await ctx.command(DRAFTER, `/outgoing-documents/${state.id}/review-submission`, {}, { version: await currentVersion(ctx, state.id) });
        const reply = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${state.id}/review-decision`, { decision: 'RETURN', comment: 'Bổ sung số liệu giải ngân lũy kế và nêu rõ nguyên nhân chậm tiến độ trước khi trình ký.' }, { version: review.resource_version });
        return { version: reply.resource_version };
      });
      break;
    default:
      break;
  }
}

/** The replacement of a document is drafted by the product from the old one; it goes on the chain like any draft, and the old one becomes REPLACED when it is issued. */
async function advanceExisting(ctx: SeedContext, plan: OutgoingPlan, draft: State, registerId: string): Promise<void> {
  let state = draft;
  const step = async (name: string, run: (s: State) => Promise<Obj>): Promise<void> => {
    state = await once(ctx, `doc.out.${plan.key}.${name}`, async () => ({ ...state, ...(await run(state)) }) as State);
  };
  await step('review', async (s) => ({ version: (await ctx.command(DRAFTER, `/outgoing-documents/${s.id}/review-submission`, {}, { version: s.version })).resource_version }));
  await step('submitted', async (s) => ({ version: (await ctx.command(LEADER, `/outgoing-documents/${s.id}/review-decision`, { decision: 'APPROVE', comment: 'Đã rà soát văn bản thay thế.', format_checklist: CHECKLIST }, { version: s.version })).resource_version }));
  await step('signed', async (s) => {
    const started = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${s.id}/leader-signing-sessions`, {}, { version: s.version });
    return { version: (await ctx.must<Obj>(LEADER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: started.resource_version })).document_version };
  });
  await step('numbered', async (s) => ({ version: (await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${s.id}/numbering`, { register_id: registerId, issued_on: ctx.today }, { version: s.version })).resource_version }));
  await step('sealed', async (s) => {
    const started = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s.id}/organization-seal-sessions`, {}, { version: s.version });
    return { version: (await ctx.must<Obj>(OWNER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: started.resource_version })).document_version };
  });
  await step('issued', async (s) => ({ version: (await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s.id}/issuance`, { unconfirmed_override_reason: OVERRIDE }, { version: s.version })).resource_version }));
}

async function distributionVersion(ctx: SeedContext, outgoingId: string, distributionId: string): Promise<number> {
  const document = await ctx.get<Obj>(DRAFTER, `/outgoing-documents/${outgoingId}`);
  const row = ((document.distributions ?? []) as Obj[]).find((candidate) => candidate.id === distributionId);
  return Number(row?.version ?? 1);
}

// ---- the setup: layout, types, registers, templates, retention rules ---------------------------------------------------------------------

async function layoutProfile(ctx: SeedContext): Promise<string> {
  const published = await ctx.find(DRAFTER, '/document-layout-profiles', (row) => row.profile_code === LAYOUT.profile_code && row.status === 'PUBLISHED');
  if (published !== undefined) return String(published.id);
  const draft = await ctx.find(DRAFTER, '/document-layout-profiles', (row) => row.profile_code === LAYOUT.profile_code && row.status === 'DRAFT');
  const created = draft === undefined ? await ctx.command(DRAFTER, '/document-layout-profiles', LAYOUT) : { resource_id: String(draft.id), resource_version: Number(draft.version) };
  // The leader publishes what the clerk drafted (four eyes).
  await ctx.command(LEADER, `/document-layout-profiles/${created.resource_id}/publish`, {}, { version: created.resource_version });
  made(ctx, 'DOC', 'layout-profile', LAYOUT.profile_code, 'published, waiting for legal confirmation', { id: created.resource_id, screen: 'DOC-16' });
  return created.resource_id;
}

async function documentTypes(ctx: SeedContext): Promise<void> {
  for (const type of DOC_TYPES) {
    await once(ctx, `doc.type.${type.code}`, async () => {
      const reply = await ctx.call(DRAFTER, 'POST', '/document-types', { ...type, legal_basis: 'Nghị định số 30/2020/NĐ-CP', effective_from: '2026-01-01' });
      if (!reply.ok && reply.json.code !== 'DOC_TYPE_RANGE_OVERLAP') ctx.expectOk(reply, `define the document type ${type.code}`);
      made(ctx, 'DOC', 'document-type', type.code, reply.ok ? 'defined' : 'existing', { screen: 'DOC-21' });
      return { ok: true };
    });
  }
}

/** The registers of the office: outgoing documents of the year (open), of last year (closed), the register of documents signed elsewhere (mirrored) and the incoming letters. */
async function registers(ctx: SeedContext): Promise<{ outgoing: string; incoming: string }> {
  const open = async (code: string, name: string, direction: 'OUTGOING' | 'INCOMING', year: number, mode: 'MANAGED' | 'MIRRORED', unit: string): Promise<string> => {
    const existing = await ctx.find(DRAFTER, '/document-number-registers', (row) => row.register_code === code && Number(row.year) === year);
    if (existing !== undefined) return String(existing.id);
    const reply = await ctx.command(DRAFTER, '/document-number-registers', { register_code: code, name, direction, organization_unit_id: ctx.unitId(unit), year, mode, scope_doc_types: TYPE_CODES });
    made(ctx, 'DOC', 'register', `${code}/${year}`, `${direction} ${mode}`, { id: reply.resource_id, screen: 'DOC-21' });
    return reply.resource_id;
  };
  const outgoing = await open('SKHDT', `Sổ văn bản đi năm ${ctx.year}`, 'OUTGOING', ctx.year, 'MANAGED', 'CB-SKHDT-VP');
  const incoming = await open('DEN', `Sổ văn bản đến năm ${ctx.year}`, 'INCOMING', ctx.year, 'MANAGED', 'CB-SKHDT-VP');
  await open('ZEXT', `Sổ văn bản ký ở hệ thống khác năm ${ctx.year}`, 'OUTGOING', ctx.year, 'MIRRORED', 'CB-SKHDT-VP');
  const previous = await open('SKHDT', `Sổ văn bản đi năm ${ctx.year - 1}`, 'OUTGOING', ctx.year - 1, 'MANAGED', 'CB-SKHDT-VP');
  await once(ctx, `doc.register.closed.${ctx.year - 1}`, async () => {
    const found = await ctx.get<Obj>(DRAFTER, `/document-number-registers/${previous}/entries`).catch(() => ({}) as Obj);
    void found;
    const register = await ctx.find(DRAFTER, '/document-number-registers', (row) => row.id === previous);
    await ctx.attempt(DRAFTER, 'POST', `/document-number-registers/${previous}/closure`, { reason: 'Khóa sổ văn bản đi của năm đã qua sau khi chốt số liệu cuối năm.' }, { version: Number(register?.version ?? 1) });
    return { ok: true };
  });
  return { outgoing, incoming };
}

/** The 25 templates of the platform pack: drafted by the project board, published by the leader, and the main ones confirmed by the owner with an evidence document. */
async function templates(ctx: SeedContext, layoutId: string, evidenceDocument: string): Promise<void> {
  for (const template of readPack().templates) {
    await once(ctx, `doc.template.${template.template_code}`, async () => {
      const existing = await ctx.find(DRAFTER, '/document-templates', (row) => row.template_code === template.template_code);
      let id: string;
      let version: number;
      let status: string;
      if (existing === undefined) {
        const created = await ctx.command(DRAFTER, '/document-templates', {
          template_code: template.template_code,
          group_code: template.group_code,
          doc_type_code: template.doc_type_code,
          ...(template.form_code === null ? {} : { form_code: template.form_code }),
          title: template.title,
          ...(template.source_module === null ? {} : { source_module: template.source_module }),
          layout_profile_id: layoutId,
          body_blocks: { blocks: template.body_blocks },
          placeholder_schema: template.placeholder_schema,
          legal_basis: template.legal_basis,
          effective_from: template.effective_from,
          watermark_text: template.watermark_text,
        });
        id = created.resource_id;
        version = created.resource_version;
        status = 'DRAFT';
      } else {
        id = String(existing.id);
        version = Number(existing.version);
        status = String(existing.status);
      }
      if (status === 'DRAFT') {
        const published = await ctx.command(LEADER, `/document-templates/${id}/publish`, {}, { version });
        version = published.resource_version;
      }
      if (CONFIRMED_TEMPLATES.has(template.template_code)) {
        await ctx.command(OWNER, `/document-templates/${id}/legal-confirmation`, { legal_confirmation_ref: GUIDE_LEGAL_REF, evidence_document_id: evidenceDocument, note: 'Đã đối chiếu mẫu với văn bản gốc của cơ quan có thẩm quyền.' }, { version });
      }
      made(ctx, 'DOC', 'template', template.template_code, CONFIRMED_TEMPLATES.has(template.template_code) ? 'published and legally confirmed' : 'published, waiting for confirmation', { id, screen: 'DOC-14' });
      return { id };
    });
  }
}

const RETENTION_RULES = [
  { rule_set: 'TT74_2025_BTC', category_code: 'HO_SO_DU_AN', class_code: 'Y20', start_basis: 'FROM_CLOSED', handover_months: 12, legal_basis: 'Thông tư 74/2025/TT-BTC, bảng thời hạn bảo quản hồ sơ dự án đầu tư công', confirm: true },
  { rule_set: 'TT74_2025_BTC', category_code: 'HO_SO_QUYET_TOAN', class_code: 'PERMANENT', start_basis: 'FROM_SETTLEMENT', handover_months: 12, legal_basis: 'Thông tư 74/2025/TT-BTC, hồ sơ quyết toán dự án hoàn thành', confirm: true },
  { rule_set: 'TT10_2022_BNV', category_code: 'VAN_BAN_DIEU_HANH', class_code: 'Y10', start_basis: 'FROM_ISSUED', handover_months: 12, legal_basis: 'Thông tư 10/2022/TT-BNV, thời hạn bảo quản văn bản điều hành', confirm: true },
  { rule_set: 'TENANT_CUSTOM', category_code: 'HO_SO_GIAI_NGAN', class_code: 'Y10', start_basis: 'FROM_CLOSED', handover_months: 6, legal_basis: 'Quy chế công tác văn thư, lưu trữ của Sở Kế hoạch và Đầu tư', confirm: false },
  { rule_set: 'TENANT_CUSTOM', category_code: 'TAI_LIEU_THAM_KHAO', class_code: 'Y5', start_basis: 'FROM_ISSUED', handover_months: 6, legal_basis: 'Quy chế công tác văn thư, lưu trữ của Sở Kế hoạch và Đầu tư', confirm: false },
];

async function retentionRules(ctx: SeedContext, evidenceDocument: string): Promise<void> {
  for (const rule of RETENTION_RULES) {
    await once(ctx, `doc.retention.${rule.category_code}`, async () => {
      const { confirm, ...body } = rule;
      const existing = await ctx.find(DRAFTER, '/document-retention-rules', (row) => row.category_code === rule.category_code);
      const created = existing === undefined ? await ctx.command(DRAFTER, '/document-retention-rules', { ...body, effective_from: '2026-01-01' }) : { resource_id: String(existing.id), resource_version: Number(existing.version) };
      const published = await ctx.command(LEADER, `/document-retention-rules/${created.resource_id}/publish`, {}, { version: created.resource_version });
      if (confirm) await ctx.command(OWNER, `/document-retention-rules/${created.resource_id}/legal-confirmation`, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidenceDocument, note: 'Đã đối chiếu với bảng thời hạn bảo quản của Bộ Tài chính.' }, { version: published.resource_version });
      made(ctx, 'DOC', 'retention-rule', rule.category_code, `${rule.class_code}${confirm ? ' confirmed' : ' waiting for confirmation'}`, { id: created.resource_id, screen: 'DOC-18' });
      return { id: created.resource_id };
    });
  }
}

// ---- incoming letters --------------------------------------------------------------------------------------------------------------------

type IncomingTarget = 'received' | 'registered' | 'assigned' | 'processing' | 'resolved' | 'filed' | 'rejected';
interface IncomingPlan {
  key: string;
  title: string;
  type: string;
  channel: 'PAPER_SCAN' | 'EMAIL' | 'LGSP' | 'PORTAL' | 'UPLOAD';
  sender: string;
  symbol: string;
  issuedDaysAgo: number;
  urgency?: 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC';
  classification?: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';
  target: IncomingTarget;
  directive?: string;
  dueInDays?: number;
  handler?: 'projectManager' | 'owner';
  unit?: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP' | 'CB-STC';
  resolution?: string;
  dossier?: string;
  rejection?: string;
}

const INCOMING: IncomingPlan[] = [
  { key: 'CV-1523', title: 'Công văn về việc triển khai kế hoạch đầu tư công năm 2027', type: 'CV', channel: 'LGSP', sender: 'Ủy ban nhân dân tỉnh Cao Bằng', symbol: '1523/UBND-KTTH', issuedDaysAgo: 6, urgency: 'KHAN', target: 'assigned', directive: 'Giao Ban Quản lý dự án tổng hợp danh mục dự án chuyển tiếp, báo cáo lãnh đạo Sở trước ngày hết hạn.', dueInDays: 5, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
  { key: 'CV-3472', title: 'Công văn đôn đốc giải ngân vốn đầu tư công chín tháng đầu năm 2026', type: 'CV', channel: 'EMAIL', sender: 'Bộ Kế hoạch và Đầu tư', symbol: '3472/BKHĐT-GSTĐ', issuedDaysAgo: 9, urgency: 'THUONG_KHAN', target: 'processing', directive: 'Phòng Văn phòng chủ trì, phối hợp Sở Tài chính chuẩn bị báo cáo giải trình gửi Bộ.', dueInDays: 1, handler: 'projectManager', unit: 'CB-SKHDT-VP' },
  { key: 'TB-412', title: 'Thông báo số dư tạm ứng vốn đầu tư đến hết quý III năm 2026', type: 'TB', channel: 'PAPER_SCAN', sender: 'Kho bạc Nhà nước khu vực Cao Bằng', symbol: '412/TB-KBNN', issuedDaysAgo: 14, target: 'filed', directive: 'Ban Quản lý dự án đối chiếu số dư tạm ứng với sổ theo dõi.', dueInDays: 7, handler: 'projectManager', unit: 'CB-SKHDT-QLDA', resolution: 'Đã đối chiếu số dư tạm ứng với sổ theo dõi của Ban Quản lý dự án, số liệu khớp.', dossier: 'HO_SO_GIAI_NGAN' },
  { key: 'CV-87', title: 'Đề nghị gia hạn thời gian thực hiện hợp đồng gói thầu XL01 đường tỉnh 205', type: 'CV', channel: 'EMAIL', sender: 'Liên danh Công ty Cổ phần Xây dựng Đại Phát - Công ty TNHH Cao Bằng Xanh', symbol: '87/CV-LDĐP', issuedDaysAgo: 3, target: 'registered' },
  { key: 'CV-219', title: 'Ý kiến thẩm định nguồn vốn kế hoạch đầu tư công năm 2027', type: 'CV', channel: 'UPLOAD', sender: 'Sở Tài chính tỉnh Cao Bằng', symbol: '219/STC-QLNS', issuedDaysAgo: 1, target: 'received' },
  { key: 'GM-64', title: 'Giấy mời họp giao ban đầu tư công tháng 11 năm 2026', type: 'GM', channel: 'LGSP', sender: 'Văn phòng Ủy ban nhân dân tỉnh Cao Bằng', symbol: '64/GM-VPUBND', issuedDaysAgo: 2, urgency: 'HOA_TOC', target: 'assigned', directive: 'Lãnh đạo Sở dự họp, Văn phòng chuẩn bị báo cáo giải ngân.', dueInDays: 0, handler: 'owner', unit: 'CB-SKHDT-VP' },
  { key: 'CV-905', title: 'Yêu cầu cung cấp hồ sơ phục vụ kiểm toán dự án Nâng cấp Trạm y tế phường Tân Giang', type: 'CV', channel: 'PAPER_SCAN', sender: 'Kiểm toán nhà nước khu vực I', symbol: '905/KTNN-KV1', issuedDaysAgo: 8, urgency: 'KHAN', classification: 'CONFIDENTIAL', target: 'processing', directive: 'Ban Quản lý dự án cung cấp đủ hồ sơ theo danh mục, đầu mối là chuyên viên phụ trách dự án.', dueInDays: 4, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
  { key: 'CV-5588', title: 'Công văn về quy hoạch xây dựng vùng huyện Văn Quan (gửi nhầm cơ quan)', type: 'CV', channel: 'EMAIL', sender: 'Sở Xây dựng tỉnh Lạng Sơn', symbol: '5588/SXD-QLXD', issuedDaysAgo: 5, target: 'rejected', rejection: 'Văn bản gửi nhầm cơ quan, không thuộc thẩm quyền của Sở; đã thông báo cho nơi gửi.' },
  { key: 'QD-301', title: 'Quyết định giao chỉ tiêu kế hoạch đầu tư công vốn ngân sách trung ương năm 2027', type: 'QD', channel: 'LGSP', sender: 'Ủy ban nhân dân tỉnh Cao Bằng', symbol: '301/QĐ-UBND', issuedDaysAgo: 20, target: 'filed', directive: 'Giao Văn phòng lưu hồ sơ kế hoạch vốn năm 2027 và gửi các chủ đầu tư.', dueInDays: 3, handler: 'projectManager', unit: 'CB-SKHDT-VP', resolution: 'Đã thông báo chỉ tiêu cho các chủ đầu tư và lưu vào hồ sơ kế hoạch vốn năm 2027.', dossier: 'HO_SO_KE_HOACH_VON' },
  { key: 'BC-78', title: 'Báo cáo tiến độ giải phóng mặt bằng dự án đường tỉnh 205', type: 'BC', channel: 'PORTAL', sender: 'Ủy ban nhân dân phường Thục Phán', symbol: '78/BC-UBND', issuedDaysAgo: 4, target: 'registered' },
  { key: 'CV-1190', title: 'Công văn hướng dẫn lập hồ sơ quyết toán dự án hoàn thành', type: 'CV', channel: 'LGSP', sender: 'Bộ Tài chính', symbol: '1190/BTC-ĐT', issuedDaysAgo: 11, target: 'resolved', directive: 'Ban Quản lý dự án rà soát danh mục dự án đủ điều kiện quyết toán.', dueInDays: 6, handler: 'projectManager', unit: 'CB-SKHDT-QLDA', resolution: 'Đã rà soát: 2 dự án đủ điều kiện quyết toán năm 2026, 1 dự án chuyển sang năm sau.' },
  { key: 'TB-33', title: 'Thông báo thay đổi thông tin tài khoản thanh toán của nhà thầu', type: 'TB', channel: 'PAPER_SCAN', sender: 'Công ty TNHH Tư vấn Giám sát Bảo Lạc', symbol: '33/TB-BL', issuedDaysAgo: 7, target: 'resolved', directive: 'Kế toán đối chiếu thông tin tài khoản trước khi thanh toán đợt tiếp theo.', dueInDays: 2, handler: 'owner', unit: 'CB-SKHDT-VP', resolution: 'Đã đối chiếu giấy xác nhận của ngân hàng, cập nhật thông tin tài khoản.' },
  { key: 'CV-612', title: 'Đề nghị báo cáo tình hình thực hiện Chương trình mục tiêu quốc gia giảm nghèo bền vững', type: 'CV', channel: 'EMAIL', sender: 'Ban Dân tộc tỉnh Cao Bằng', symbol: '612/BDT-CSDT', issuedDaysAgo: 2, target: 'assigned', directive: 'Giao Ban Quản lý dự án tổng hợp số liệu giải ngân theo từng tiểu dự án.', dueInDays: 9, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
];

async function incomingLetters(ctx: SeedContext, registerId: string, dossiers: Map<string, string>): Promise<void> {
  const order: IncomingTarget[] = ['received', 'registered', 'assigned', 'processing', 'resolved', 'filed'];
  for (const plan of INCOMING) {
    await once(ctx, `doc.in.${plan.key}`, async () => {
      const reached = (target: IncomingTarget): boolean => order.indexOf(plan.target) >= order.indexOf(target) && plan.target !== 'rejected';
      const existing = await ctx.find(DRAFTER, '/incoming-documents', (row) => row.original_symbol === plan.symbol);
      let id: string;
      let version: number;
      if (existing !== undefined) {
        id = String(existing.id);
        version = Number(existing.version);
      } else {
        const pdf = ctx.pdf(plan.sender.toUpperCase(), `So: ${plan.symbol}`, plan.title);
        const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(DRAFTER, '/document-files', { filename: `${plan.key.toLowerCase()}.pdf`, buffer: pdf }), `upload the letter ${plan.symbol}`).json;
        const received = await ctx.must<Obj>(DRAFTER, 'POST', '/incoming-documents', {
          title: plan.title,
          doc_type_code: plan.type,
          channel: plan.channel,
          file_object_key: uploaded.file_object_key,
          file_sha256: uploaded.file_sha256,
          original_symbol: plan.symbol,
          original_issued_on: ctx.day(-plan.issuedDaysAgo),
          sender_name: plan.sender,
          urgency: plan.urgency ?? 'NORMAL',
          classification: plan.classification ?? 'INTERNAL',
        });
        id = received.resource_id;
        version = received.resource_version;
      }
      if (plan.target === 'rejected') {
        const rejected = await ctx.command(DRAFTER, `/incoming-documents/${id}/rejection`, { rejection_reason: plan.rejection }, { version });
        return { id, version: rejected.resource_version, documentId: String((await ctx.get<Obj>(DRAFTER, `/incoming-documents/${id}`)).document_id) };
      }
      if (reached('registered')) {
        const registered = await ctx.command(DRAFTER, `/incoming-documents/${id}/registration`, { register_id: registerId }, { version });
        version = registered.resource_version;
      }
      if (reached('assigned')) {
        const handler = plan.handler ?? 'projectManager';
        const assigned = await ctx.command(OWNER, `/incoming-documents/${id}/assignment`, { assigned_unit_id: ctx.unitId(plan.unit ?? 'CB-SKHDT-QLDA'), assignee_user_id: ctx.person(handler).membershipId, leader_directive: plan.directive, due_on: ctx.day(plan.dueInDays ?? 5) }, { version });
        version = assigned.resource_version;
      }
      if (reached('processing')) {
        const started = await ctx.command(plan.handler ?? 'projectManager', `/incoming-documents/${id}/processing`, {}, { version });
        version = started.resource_version;
      }
      if (reached('resolved')) {
        const resolved = await ctx.command(plan.handler ?? 'projectManager', `/incoming-documents/${id}/resolution`, { resolution_summary: plan.resolution }, { version });
        version = resolved.resource_version;
      }
      if (reached('filed') && plan.dossier !== undefined) {
        const dossierId = dossiers.get(plan.dossier);
        if (dossierId !== undefined) {
          const filed = await ctx.command(DRAFTER, `/incoming-documents/${id}/filing`, { dossier_id: dossierId }, { version });
          version = filed.resource_version;
        }
      }
      const letter = await ctx.get<Obj>(DRAFTER, `/incoming-documents/${id}`);
      return { id, version, documentId: String(letter.document_id) };
    });
    made(ctx, 'DOC', 'incoming-document', plan.symbol, plan.target, { screen: 'DOC-12' });
  }
}

// ---- dossiers ----------------------------------------------------------------------------------------------------------------------------

interface DossierPlan {
  key: string;
  code: string;
  title: string;
  category: string;
  unit: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP';
  project?: string;
  outgoing: string[];
  end: 'open' | 'closed' | 'handed-over';
}

const DOSSIERS: DossierPlan[] = [
  { key: 'HO_SO_DU_AN', code: 'HS-DT205-2026', title: 'Hồ sơ dự án Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12', category: 'HO_SO_DU_AN', unit: 'CB-SKHDT-QLDA', project: 'DA-DT205', outgoing: ['QD-PHE-DUYET-DT205'], end: 'closed' },
  { key: 'HO_SO_KE_HOACH_VON', code: 'HS-KHV-2027', title: 'Hồ sơ kế hoạch vốn đầu tư công năm 2027', category: 'VAN_BAN_DIEU_HANH', unit: 'CB-SKHDT-VP', outgoing: ['QD-GIAO-KE-HOACH-VON'], end: 'open' },
  { key: 'HO_SO_GIAI_NGAN', code: 'HS-GN-Q3-2026', title: 'Hồ sơ theo dõi giải ngân quý III năm 2026', category: 'HO_SO_GIAI_NGAN', unit: 'CB-SKHDT-VP', outgoing: ['CV-DON-DOC-GIAI-NGAN'], end: 'open' },
  { key: 'HO_SO_TH012', code: 'HS-TH012-2026', title: 'Hồ sơ dự án Xây dựng Trường Tiểu học phường Nùng Trí Cao', category: 'HO_SO_DU_AN', unit: 'CB-SKHDT-QLDA', project: 'DA-TH012', outgoing: ['QD-PHE-DUYET-TH012'], end: 'handed-over' },
  { key: 'HO_SO_THAM_KHAO', code: 'HS-TK-2026', title: 'Tài liệu tham khảo về quản lý đầu tư công năm 2026', category: 'TAI_LIEU_THAM_KHAO', unit: 'CB-SKHDT-VP', outgoing: [], end: 'open' },
];

/** The dossiers exist before the letters are filed; each is opened, filled with its issued documents and, when its plan says so, closed and handed over. */
async function openDossiers(ctx: SeedContext): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const plan of DOSSIERS) {
    const state = await once(ctx, `doc.dossier.${plan.key}.open`, async () => {
      const existing = await ctx.find(DRAFTER, '/dossiers', (row) => row.dossier_code === plan.code);
      if (existing !== undefined) return { id: String(existing.id) };
      const project = plan.project === undefined ? undefined : await projectId(ctx, plan.project);
      const created = await ctx.command(DRAFTER, '/dossiers', { dossier_code: plan.code, year: ctx.year, title: plan.title, organization_unit_id: ctx.unitId(plan.unit), category_code: plan.category, ...(project === undefined ? {} : { subject_module: 'PRJ', subject_id: project }) });
      made(ctx, 'DOC', 'dossier', plan.code, 'opened', { id: created.resource_id, screen: 'DOC-17' });
      return { id: created.resource_id };
    });
    ids.set(plan.key, state.id);
  }
  return ids;
}

async function fillDossiers(ctx: SeedContext, issued: Map<string, State>): Promise<void> {
  const ids = new Map<string, string>();
  for (const plan of DOSSIERS) ids.set(plan.key, (await once(ctx, `doc.dossier.${plan.key}.open`, async () => ({ id: '' }))).id);
  for (const plan of DOSSIERS) {
    const dossierId = ids.get(plan.key)!;
    for (const key of plan.outgoing) {
      const document = issued.get(key);
      if (document === undefined) continue;
      await once(ctx, `doc.dossier.${plan.key}.item.${key}`, async () => {
        await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/items`, { document_id: document.documentId }, { version: await dossierVersion(ctx, dossierId) });
        return { ok: true };
      });
    }
    if (plan.end === 'open') continue;
    const closed = await once(ctx, `doc.dossier.${plan.key}.closed`, async () => {
      const reply = await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/closure`, { settlement_closed_on: ctx.day(-3) }, { version: await dossierVersion(ctx, dossierId) });
      return { ok: reply.ok };
    });
    if (plan.end === 'handed-over' && closed.ok) {
      await once(ctx, `doc.dossier.${plan.key}.handed`, async () => {
        const reply = await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/handover`, { archive_ref: `LT-2026/${plan.code}`, handed_over_at: new Date(Date.now() - 1000).toISOString() }, { version: await dossierVersion(ctx, dossierId) });
        return { ok: reply.ok };
      });
    }
  }
}

async function dossierVersion(ctx: SeedContext, id: string): Promise<number> {
  const dossier = await ctx.get<Obj>(DRAFTER, `/dossiers/${id}`);
  return Number(dossier.version ?? dossier.resource_version);
}

// ---- the entry ----------------------------------------------------------------------------------------------------------------------------

export async function seedDoc(ctx: SeedContext): Promise<void> {
  const layoutId = await ctx.step('DOC', 'layout profile of Decree 30/2020', () => layoutProfile(ctx));
  await ctx.step('DOC', 'document types', () => documentTypes(ctx));
  const regs = await ctx.step('DOC', 'number registers', () => registers(ctx));

  // The decision of the People's Committee that the base group received is the evidence of the legal confirmations.
  const evidence = await ctx.find(DRAFTER, '/incoming-documents', (row) => row.original_symbol === '128/QĐ-UBND');
  if (evidence === undefined) throw new Error('the incoming decision 128/QĐ-UBND of the base group is missing: run the group base first');
  const evidenceDocument = String(evidence.document_id);

  await ctx.step('DOC', 'template library (platform pack)', () => templates(ctx, layoutId, evidenceDocument));
  await ctx.step('DOC', 'retention rules', () => retentionRules(ctx, evidenceDocument));

  const issued = new Map<string, State>();
  await ctx.step('DOC', 'outgoing documents', async () => {
    for (const plan of plans(ctx)) {
      const state = await advance(ctx, plan, regs.outgoing);
      issued.set(plan.key, state);
      made(ctx, 'DOC', 'outgoing-document', plan.title, `${plan.upTo}${plan.after === undefined ? '' : ` then ${plan.after}`}`, { id: state.id, screen: 'DOC-03' });
      await afterwards(ctx, plan, state, regs.outgoing);
    }
  });

  const dossierIds = await ctx.step('DOC', 'dossiers opened', () => openDossiers(ctx));
  await ctx.step('DOC', 'incoming letters', () => incomingLetters(ctx, regs.incoming, dossierIds));
  await ctx.step('DOC', 'dossiers filled, closed and handed over', () => fillDossiers(ctx, issued));
  void remembered;
}
