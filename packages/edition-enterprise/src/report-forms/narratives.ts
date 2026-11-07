import { DEMO_MARK } from '@machvon/kernel/src/report-layout.ts';
import type { NarrativeBlock } from '@machvon/kernel/src/report-layout.ts';

/**
 * The narrative parts (thuyết minh) of the demo report forms that have one: the skeleton of the Word document, as blocks the kernel resolves (`fillNarrative` puts the figure of the indicator register into every
 * `{{indicator:CODE@BASIS}}` token, so the sentence and the table of the form cannot give two numbers for one indicator). The parts the people write (nguyên nhân, khó khăn và giải pháp, kiến nghị) are numbered
 * placeholders in square brackets: a skeleton never invents a reason or a request. The demo mark is the first paragraph, and the Word writer repeats it in the header of every page.
 */

const sectionPlaceholder = (hint: string): NarrativeBlock => ({ type: 'PARAGRAPH', text: `[${hint}]`, italic: true });

const head = (title: string): NarrativeBlock[] => [
  { type: 'PARAGRAPH', text: DEMO_MARK, align: 'CENTER', bold: true },
  { type: 'PARAGRAPH', text: '{{meta:PARENT_NAME}}', align: 'LEFT', bold: false },
  { type: 'PARAGRAPH', text: '{{meta:ORG_NAME}}', align: 'LEFT', bold: true },
  { type: 'HEADING', level: 1, text: title },
  { type: 'PARAGRAPH', text: '{{meta:PERIOD_LABEL}}', align: 'CENTER', bold: true },
  { type: 'PARAGRAPH', text: '{{meta:UNIT_LABEL}}', align: 'RIGHT', italic: true },
];

const figures: NarrativeBlock[] = [
  { type: 'HEADING', level: 2, text: '1. Tình hình thực hiện kế hoạch' },
  {
    type: 'PARAGRAPH',
    text: 'Kế hoạch vốn năm hiện hành là {{indicator:ENT_PLAN_IN_FORCE@FULL_YEAR}} triệu đồng cho {{indicator:ENT_PROJECTS_TOTAL@AS_OF_END}} dự án và hạng mục. Trong kỳ, giá trị thực hiện đạt {{indicator:ENT_EXECUTED_PERIOD@IN_PERIOD}} triệu đồng, giải ngân {{indicator:ENT_DISBURSED_PERIOD@IN_PERIOD}} triệu đồng.',
  },
  {
    type: 'PARAGRAPH',
    text: 'Lũy kế từ đầu năm, giá trị thực hiện đạt {{indicator:ENT_EXECUTED_YTD@YEAR_TO_DATE}} triệu đồng ({{indicator:ENT_RATE_EXECUTED_YTD@YEAR_TO_DATE}}% kế hoạch năm), giải ngân {{indicator:ENT_DISBURSED_YTD@YEAR_TO_DATE}} triệu đồng ({{indicator:ENT_RATE_DISBURSED_YTD@YEAR_TO_DATE}}% kế hoạch năm). Lũy kế từ khởi công, giá trị thực hiện đạt {{indicator:ENT_EXECUTED_SINCE_START@AS_OF_END}} triệu đồng, giải ngân {{indicator:ENT_DISBURSED_SINCE_START@AS_OF_END}} triệu đồng ({{indicator:ENT_RATE_SINCE_START@AS_OF_END}}% tổng mức đầu tư).',
  },
  { type: 'HEADING', level: 2, text: '2. Cơ cấu vốn kế hoạch năm' },
  {
    type: 'TABLE',
    header: ['Nguồn vốn', 'Kế hoạch năm (triệu đồng)', 'Tỷ trọng (%)'],
    rows: [
      ['Vốn chủ sở hữu', '{{indicator:ENT_CAPITAL_EQUITY@FULL_YEAR}}', '{{indicator:ENT_SHARE_EQUITY@FULL_YEAR}}'],
      ['Vốn vay', '{{indicator:ENT_CAPITAL_DEBT@FULL_YEAR}}', '{{indicator:ENT_SHARE_DEBT@FULL_YEAR}}'],
      ['Khác', '{{indicator:ENT_CAPITAL_OTHER@FULL_YEAR}}', '{{indicator:ENT_SHARE_OTHER@FULL_YEAR}}'],
    ],
    widths: [40, 35, 25],
  },
  { type: 'HEADING', level: 2, text: '3. Đánh giá tiến độ' },
  {
    type: 'PARAGRAPH',
    text: 'Trong {{indicator:ENT_PROJECTS_TOTAL@AS_OF_END}} dự án và hạng mục có {{indicator:ENT_PROJECTS_ON_TRACK@AS_OF_END}} dự án đúng hoặc vượt tiến độ và {{indicator:ENT_PROJECTS_DELAYED@AS_OF_END}} dự án chậm tiến độ.',
  },
];

const signatures: NarrativeBlock = {
  type: 'SIGNATURES',
  slots: [
    { role: 'NGƯỜI LẬP BIỂU', name: '{{meta:SIGN_PREPARER}}' },
    { role: 'NGƯỜI KIỂM TRA', name: '{{meta:SIGN_CHECKER}}' },
    { role: 'NGƯỜI PHÊ DUYỆT', name: '{{meta:SIGN_APPROVER}}' },
  ],
};

/** Báo cáo quý gửi Tập đoàn (Biểu 2): thuyết minh kèm biểu. */
export const PVN_QUARTERLY_NARRATIVE: readonly NarrativeBlock[] = Object.freeze([
  ...head('THUYẾT MINH BIỂU 2 - TÌNH HÌNH THỰC HIỆN KẾ HOẠCH ĐẦU TƯ XÂY DỰNG CƠ BẢN VÀ MUA SẮM TRANG THIẾT BỊ'),
  ...figures,
  { type: 'PARAGRAPH', text: 'Ước thực hiện cả năm là {{indicator:ENT_OUTLOOK_YEAR@FULL_YEAR}} triệu đồng, bằng {{indicator:ENT_RATE_OUTLOOK_YEAR@FULL_YEAR}}% kế hoạch vốn năm hiện hành.' },
  { type: 'HEADING', level: 2, text: '4. Nguyên nhân' },
  sectionPlaceholder('Nêu nguyên nhân chính của các dự án chậm tiến độ hoặc giải ngân thấp'),
  { type: 'HEADING', level: 2, text: '5. Khó khăn, vướng mắc và giải pháp' },
  { type: 'LIST', ordered: true, items: ['[Khó khăn, vướng mắc thứ nhất và giải pháp]', '[Khó khăn, vướng mắc thứ hai và giải pháp]'] },
  { type: 'HEADING', level: 2, text: '6. Kế hoạch quý tới' },
  sectionPlaceholder('Nêu khối lượng và giải ngân dự kiến của quý tới'),
  { type: 'HEADING', level: 2, text: '7. Kiến nghị' },
  sectionPlaceholder('Nêu kiến nghị đối với Tập đoàn'),
  signatures,
]);

/** Báo cáo định kỳ Ủy ban Đầu tư phát triển và Khoa học công nghệ. */
export const COMMITTEE_PERIODIC_NARRATIVE: readonly NarrativeBlock[] = Object.freeze([
  ...head('BÁO CÁO ĐỊNH KỲ GỬI ỦY BAN ĐẦU TƯ PHÁT TRIỂN VÀ KHOA HỌC CÔNG NGHỆ'),
  { type: 'PARAGRAPH', text: 'Kính gửi: Ủy ban Đầu tư phát triển và Khoa học công nghệ.', bold: true },
  ...figures,
  { type: 'HEADING', level: 2, text: '4. Đánh giá chung' },
  sectionPlaceholder('Đánh giá chung về việc thực hiện kế hoạch đầu tư trong kỳ so với kế hoạch năm'),
  { type: 'HEADING', level: 2, text: '5. Nguyên nhân' },
  sectionPlaceholder('Nêu nguyên nhân của các chênh lệch lớn so với kế hoạch'),
  { type: 'HEADING', level: 2, text: '6. Khó khăn, vướng mắc và giải pháp' },
  { type: 'LIST', ordered: true, items: ['[Khó khăn, vướng mắc thứ nhất và giải pháp]', '[Khó khăn, vướng mắc thứ hai và giải pháp]'] },
  { type: 'HEADING', level: 2, text: '7. Kế hoạch kỳ tới' },
  sectionPlaceholder('Nêu các việc chính và mục tiêu thực hiện, giải ngân của kỳ tới'),
  { type: 'HEADING', level: 2, text: '8. Kiến nghị, đề xuất với Ủy ban' },
  sectionPlaceholder('Nêu các vấn đề đề nghị Ủy ban cho ý kiến hoặc chỉ đạo'),
  signatures,
]);

/** Báo cáo giao ban đầu tư hằng tháng. */
export const INVEST_STEERING_NARRATIVE: readonly NarrativeBlock[] = Object.freeze([
  ...head('BÁO CÁO GIAO BAN ĐẦU TƯ'),
  ...figures,
  { type: 'HEADING', level: 2, text: '4. Các dự án cần lãnh đạo chỉ đạo' },
  { type: 'LIST', ordered: true, items: ['[Dự án, vấn đề, đề nghị chỉ đạo thứ nhất]', '[Dự án, vấn đề, đề nghị chỉ đạo thứ hai]'] },
  { type: 'HEADING', level: 2, text: '5. Kết quả thực hiện các nội dung chỉ đạo của kỳ trước' },
  sectionPlaceholder('Nêu kết quả thực hiện các chỉ đạo của cuộc giao ban trước'),
  { type: 'HEADING', level: 2, text: '6. Kế hoạch tháng tới' },
  sectionPlaceholder('Nêu các việc chính của tháng tới'),
  signatures,
]);

/** Báo cáo Nhà máy Đạm Phú Mỹ: đầu tư xây dựng cơ bản và sửa chữa lớn. */
export const PLANT_PHU_MY_NARRATIVE: readonly NarrativeBlock[] = Object.freeze([
  ...head('BÁO CÁO NHÀ MÁY ĐẠM PHÚ MỸ - ĐẦU TƯ XÂY DỰNG CƠ BẢN VÀ SỬA CHỮA LỚN'),
  ...figures,
  { type: 'HEADING', level: 2, text: '4. Tình hình các hạng mục sửa chữa lớn' },
  sectionPlaceholder('Nêu tiến độ các hạng mục sửa chữa lớn, thời gian dừng máy và việc nghiệm thu'),
  { type: 'HEADING', level: 2, text: '5. Nguyên nhân' },
  sectionPlaceholder('Nêu nguyên nhân của các hạng mục chậm tiến độ'),
  { type: 'HEADING', level: 2, text: '6. Khó khăn, vướng mắc và giải pháp' },
  { type: 'LIST', ordered: true, items: ['[Khó khăn, vướng mắc thứ nhất và giải pháp]', '[Khó khăn, vướng mắc thứ hai và giải pháp]'] },
  { type: 'HEADING', level: 2, text: '7. Kế hoạch kỳ tới' },
  sectionPlaceholder('Nêu kế hoạch đầu tư và sửa chữa lớn của kỳ tới'),
  { type: 'HEADING', level: 2, text: '8. Kiến nghị' },
  sectionPlaceholder('Nêu kiến nghị đối với Tổng công ty'),
  signatures,
]);
