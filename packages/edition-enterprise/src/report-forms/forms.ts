import { COMMITTEE_PERIODIC_NARRATIVE, INVEST_STEERING_NARRATIVE, PLANT_PHU_MY_NARRATIVE, PVN_QUARTERLY_NARRATIVE } from './narratives.ts';
import { buildTableForm } from './common.ts';
import type { ColumnKey, DemoFormSpec, StripItem } from './common.ts';

/**
 * The six report forms of the first customer, designed by the system for the demo stage (RPT-1, owner decision of 2026-11-08): each is a `ReportLayout` with status DEMO, built from the dossier's description of
 * the five existing reports and the plant report. They carry the demo mark on every output, are issuable only while demo forms are on, and are never accepted as the official form (R18). To replace one by the
 * official template see docs/report-engine.md, "The six PVFCCo forms".
 */

const DTXDCB = { dataset: 'dtxdcb', title: 'ĐẦU TƯ XÂY DỰNG CƠ BẢN' };
const MSTB = { dataset: 'mstb', title: 'MUA SẮM TÀI SẢN, TRANG THIẾT BỊ' };
const MSTSCD = { dataset: 'mstscd', title: 'MUA SẮM TÀI SẢN CỐ ĐỊNH' };
const SCL = { dataset: 'scl', title: 'SỬA CHỮA LỚN' };

const A3 = { paper: 'A3', orientation: 'landscape' } as const;

const strip = (label: string, code: string, basis: StripItem['basis']): StripItem => ({ label, code, basis });
const PLAN = strip('Kế hoạch vốn năm hiện hành (triệu đồng)', 'ENT_PLAN_IN_FORCE', 'FULL_YEAR');

const NOTE_RATE = 'Ghi chú: Tỷ lệ % = giá trị lũy kế từ đầu năm chia cho kế hoạch vốn năm hiện hành, nhân 100; ô tỷ lệ là công thức, tự tính lại khi sửa số.';
const NOTE_CAPITAL = 'Cơ cấu vốn là kế hoạch vốn năm hiện hành chia theo nguồn: vốn chủ sở hữu, vốn vay và khác; tổng ba nguồn bằng kế hoạch vốn năm hiện hành.';
const NOTE_SCHEDULE = 'Đánh giá tiến độ: đúng tiến độ, vượt tiến độ hoặc chậm tiến độ so với tiến độ trong hợp đồng và kế hoạch được duyệt.';
const NOTE_DEMO = 'Biểu do hệ thống thiết kế cho giai đoạn demo, chưa phải mẫu chính thức; khi có mẫu chính thức, bố cục và tên cột sẽ theo mẫu đó.';

const MONEY_AND_RATES: ColumnKey[] = ['tmdt', 'plan_year', 'plan_force'];
const TEXTS: ColumnKey[] = ['status', 'schedule'];

/** Báo cáo tháng thực hiện kế hoạch ĐTXDCB và mua sắm trang thiết bị gửi Tập đoàn. */
export const PVN_MONTHLY: DemoFormSpec = buildTableForm({
  code: 'PVN-MONTHLY',
  sheetName: 'Bao cao thang',
  title: 'BÁO CÁO TÌNH HÌNH THỰC HIỆN KẾ HOẠCH ĐẦU TƯ XÂY DỰNG CƠ BẢN VÀ MUA SẮM TRANG THIẾT BỊ',
  formNo: 'PVN-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', ...MONEY_AND_RATES, 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD],
  strip: [
    PLAN,
    strip('Thực hiện trong tháng (triệu đồng)', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('Giải ngân trong tháng (triệu đồng)', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('Thực hiện lũy kế từ đầu năm (triệu đồng)', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Giải ngân lũy kế từ đầu năm (triệu đồng)', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('Tỷ lệ giải ngân lũy kế (%)', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
});

/** Biểu 2: báo cáo quý gửi Tập đoàn, có ước thực hiện của quý và cả năm. */
export const PVN_QUARTERLY_F2: DemoFormSpec = buildTableForm({
  code: 'PVN-QUARTERLY-F2',
  sheetName: 'Bieu 2',
  title: 'BIỂU 2 - BÁO CÁO TÌNH HÌNH THỰC HIỆN KẾ HOẠCH ĐẦU TƯ XÂY DỰNG CƠ BẢN VÀ MUA SẮM TRANG THIẾT BỊ THEO QUÝ',
  formNo: 'PVN-02/QUY',
  period: 'QUARTER',
  keys: ['stt', 'code', 'name', 'grp', ...MONEY_AND_RATES, 'exec_p', 'disb_p', 'est_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'outlook', 'rate_exec', 'rate_disb', 'rate_outlook', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD],
  strip: [
    PLAN,
    strip('Thực hiện trong quý (triệu đồng)', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('Giải ngân trong quý (triệu đồng)', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('Ước thực hiện cả năm (triệu đồng)', 'ENT_OUTLOOK_YEAR', 'FULL_YEAR'),
    strip('Tỷ lệ ước cả năm so kế hoạch (%)', 'ENT_RATE_OUTLOOK_YEAR', 'FULL_YEAR'),
    strip('Tỷ lệ giải ngân lũy kế (%)', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, 'Ước thực hiện quý là số ước của cả quý đã đưa vào báo cáo; ước thực hiện cả năm gồm số thực hiện các tháng đã chốt và số ước của các tháng còn lại.', NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: PVN_QUARTERLY_NARRATIVE,
});

/** Báo cáo tháng theo định dạng của hệ thống HPM: một danh sách phẳng, mỗi dòng một dự án hoặc hạng mục, có cột loại hình, một dòng tổng. */
export const HPM_MONTHLY: DemoFormSpec = buildTableForm({
  code: 'HPM-MONTHLY',
  sheetName: 'HPM thang',
  title: 'BÁO CÁO THÁNG THEO ĐỊNH DẠNG HỆ THỐNG HPM - KẾ HOẠCH ĐẦU TƯ VÀ MUA SẮM',
  formNo: 'HPM-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'kind', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS],
  groups: [{ dataset: 'items', title: 'DANH MỤC DỰ ÁN VÀ HẠNG MỤC' }],
  flat: true,
  strip: [
    PLAN,
    strip('Thực hiện trong tháng (triệu đồng)', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('Giải ngân trong tháng (triệu đồng)', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('Thực hiện lũy kế từ đầu năm (triệu đồng)', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Tỷ lệ thực hiện lũy kế (%)', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Tỷ lệ giải ngân lũy kế (%)', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, 'Cột Loại hình ghi một trong ba loại: ĐTXDCB, Mua sắm tài sản, Mua sắm tài sản cố định, để hệ thống HPM đọc từng dòng; mỗi dòng là một dự án hoặc hạng mục.', NOTE_DEMO],
  print: A3,
});

/** Báo cáo định kỳ gửi Ủy ban Đầu tư phát triển và Khoa học công nghệ của Tập đoàn. */
export const COMMITTEE_PERIODIC: DemoFormSpec = buildTableForm({
  code: 'COMMITTEE-PERIODIC',
  sheetName: 'Bao cao dinh ky',
  title: 'BÁO CÁO ĐỊNH KỲ GỬI ỦY BAN ĐẦU TƯ PHÁT TRIỂN VÀ KHOA HỌC CÔNG NGHỆ',
  formNo: 'UB-01/QUY',
  period: 'QUARTER',
  keys: ['stt', 'code', 'name', 'grp', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', 'schedule', 'issues', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD, SCL],
  strip: [
    PLAN,
    strip('Thực hiện lũy kế từ đầu năm (triệu đồng)', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Giải ngân lũy kế từ đầu năm (triệu đồng)', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('Thực hiện lũy kế từ khởi công (triệu đồng)', 'ENT_EXECUTED_SINCE_START', 'AS_OF_END'),
    strip('Tỷ lệ thực hiện so tổng mức đầu tư (%)', 'ENT_RATE_SINCE_START', 'AS_OF_END'),
    strip('Tỷ lệ thực hiện lũy kế (%)', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: COMMITTEE_PERIODIC_NARRATIVE,
});

/** Báo cáo giao ban đầu tư hằng tháng: tập trung vào tiến độ, vướng mắc và đề nghị chỉ đạo. */
export const INVEST_STEERING: DemoFormSpec = buildTableForm({
  code: 'INVEST-STEERING',
  sheetName: 'Giao ban',
  title: 'BÁO CÁO GIAO BAN ĐẦU TƯ',
  formNo: 'GB-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'plan_force', 'exec_ytd', 'disb_ytd', 'rate_exec', 'rate_disb', 'schedule', 'status', 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, MSTB, MSTSCD, SCL],
  strip: [
    strip('Số dự án và hạng mục', 'ENT_PROJECTS_TOTAL', 'AS_OF_END'),
    strip('Đúng hoặc vượt tiến độ', 'ENT_PROJECTS_ON_TRACK', 'AS_OF_END'),
    strip('Chậm tiến độ', 'ENT_PROJECTS_DELAYED', 'AS_OF_END'),
    PLAN,
    strip('Tỷ lệ thực hiện lũy kế (%)', 'ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Tỷ lệ giải ngân lũy kế (%)', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: INVEST_STEERING_NARRATIVE,
});

/** Báo cáo Nhà máy Đạm Phú Mỹ: đầu tư xây dựng cơ bản và sửa chữa lớn. */
export const PLANT_PHU_MY: DemoFormSpec = buildTableForm({
  code: 'PLANT-PHU-MY',
  sheetName: 'Nha may',
  title: 'BÁO CÁO ĐẦU TƯ XÂY DỰNG CƠ BẢN VÀ SỬA CHỮA LỚN CỦA NHÀ MÁY ĐẠM PHÚ MỸ',
  formNo: 'NM-01/THANG',
  period: 'MONTH',
  keys: ['stt', 'code', 'name', 'grp', 'owner_unit', 'tmdt', 'plan_force', 'exec_p', 'disb_p', 'exec_ytd', 'disb_ytd', 'exec_start', 'disb_start', 'rate_exec', 'rate_disb', 'cap_equity', 'cap_debt', 'cap_other', ...TEXTS, 'cause', 'issues', 'next', 'proposal'],
  groups: [DTXDCB, SCL],
  strip: [
    PLAN,
    strip('Thực hiện trong tháng (triệu đồng)', 'ENT_EXECUTED_PERIOD', 'IN_PERIOD'),
    strip('Giải ngân trong tháng (triệu đồng)', 'ENT_DISBURSED_PERIOD', 'IN_PERIOD'),
    strip('Thực hiện lũy kế từ đầu năm (triệu đồng)', 'ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
    strip('Giải ngân lũy kế từ đầu năm (triệu đồng)', 'ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
    strip('Tỷ lệ giải ngân lũy kế (%)', 'ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  ],
  notes: [NOTE_RATE, NOTE_CAPITAL, NOTE_SCHEDULE, NOTE_DEMO],
  print: A3,
  narrative: PLANT_PHU_MY_NARRATIVE,
});

/** The six forms in the order of the catalogue. */
export const DEMO_FORMS: readonly DemoFormSpec[] = Object.freeze([PVN_MONTHLY, PVN_QUARTERLY_F2, HPM_MONTHLY, COMMITTEE_PERIODIC, INVEST_STEERING, PLANT_PHU_MY]);
