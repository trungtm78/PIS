#!/usr/bin/env node
// Writes the workbook of the demo accounts that is sent to the CUSTOMER of a demonstration, from what the installation really holds:
//   ssh <server> "type ...\demo-credentials.json" | node scripts/demo-accounts-xlsx.mjs --credentials - --api https://host:8443/api --out <file outside git> [--apk "<note>"]
// The rights of each account are READ from the installation as its tenant owner (memberships, role grants, role definitions, units): nothing about a right is written
// by hand here. The workbook holds passwords: `--out` must be a path git ignores. Sheets: "Truy cập", "Tài khoản", "Quyền theo vai", "Kịch bản xem thử".
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brokerOf, readCredentials } from './clip-seed-auth.mjs';
import { ApiReader } from './clip-seed-client.mjs';
import { ignoredByGit } from './demo-accounts-sheet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_NAME = 'Hệ thống quản lý đầu tư công';

/** The groups of functions of the matrix, each with the first segments of the permissions that belong to it (the catalogue of the product names a permission `<segment>.<...>`). */
export const FUNCTION_GROUPS = [
  ['Dự án', ['project', 'prj', 'stage', 'appraisal', 'progress_snapshot', 'look_ahead']],
  ['Kế hoạch vốn', ['capital', 'plan', 'plan_version', 'allocation_line', 'budget_reservation', 'funding', 'funding_snapshot_line']],
  ['Giải ngân', ['disbursement', 'dis', 'period', 'reporting_period', 'fin', 'treasury']],
  ['Đấu thầu', ['bid', 'procurement_package', 'contractor', 'proposal', 'criteria_version', 'evaluation']],
  ['Hợp đồng', ['contract', 'contract_revision', 'ctr', 'change', 'change_request', 'measurement', 'acceptance', 'qacceptance', 'guarantee', 'claim', 'boq', 'boq_line']],
  ['Thanh toán', ['payment', 'payment_request', 'pay', 'advance', 'advance_ledger_entry', 'ledger', 'reconciliation', 'invoice_line', 'settlement']],
  ['Quy trình và hạn', ['pwf']],
  ['KPI, điểm cán bộ', ['staff_score']],
  ['Phê duyệt', ['approval', 'approval_task']],
  ['Văn bản', ['doc', 'document_version']],
  ['Cảnh báo, chỉ đạo, Ban chỉ đạo', ['home', 'early_warning', 'alert', 'directive', 'committee']],
  ['Báo cáo và BI', ['bi', 'report', 'rpt', 'dashboard_version', 'metric_definition', 'analytics']],
  ['Thanh tra, kiểm toán', ['aud', 'audit', 'audit_event']],
  ['Quản trị (tổ chức, người dùng, vai trò, danh mục)', ['iam', 'adm', 'membership', 'organization_unit', 'role_grant', 'master', 'master_record_version', 'invitation']],
];

/** The system roles of the product carry a key instead of a name (`iam.role.<CODE>.name`): the words a reader of the workbook is given for them. */
export const SYSTEM_ROLE_NAMES = {
  TENANT_OWNER: 'Quản trị cao nhất (toàn quyền)',
  TENANT_ADMIN: 'Quản trị tổ chức',
  SECURITY_ADMIN: 'Quản trị bảo mật',
  UNIT_ADMIN: 'Quản trị đơn vị',
  LEADER: 'Lãnh đạo (quyết định phê duyệt)',
  COMMITTEE_HEAD: 'Trưởng Ban chỉ đạo',
  AUDITOR: 'Kiểm toán viên',
  STAFF_MEMBER: 'Cán bộ, nhân viên',
  MEMBER: 'Thành viên',
};

const READ = /(^|\.)(read|read_own|read_unit|read_hr|self|export|view)$/u;
const DECIDE = /approve|decide|publish|sign|confirm|certify|review|lock|accept|issue|verify|close|seal|activate/u;
const ADMIN_GROUP = FUNCTION_GROUPS.length - 1;

/** What a list of permissions lets a person do in one group of functions: { view, make, decide }. A pattern `segment.*` gives all three. Pure. */
export function capabilityOf(permissions, segments) {
  const out = { view: false, make: false, decide: false };
  for (const permission of permissions) {
    const [segment, ...rest] = permission.split('.');
    if (!segments.includes(segment)) continue;
    const tail = rest.join('.');
    if (tail === '*' || tail === '') {
      out.view = true;
      out.make = true;
      out.decide = true;
    } else if (READ.test(tail)) out.view = true;
    else if (DECIDE.test(tail)) out.decide = true;
    else out.make = true;
  }
  return out;
}

/** The cell of the matrix, in words. Pure. */
export function cellOf(capability, admin = false) {
  const words = [];
  if (capability.view) words.push('Xem');
  if (capability.make) words.push(admin ? 'Quản trị' : 'Lập');
  if (capability.decide) words.push('Duyệt');
  return words.length === 0 ? '–' : words.join(', ');
}

/** The sentence of what a person can see and do, from the matrix row of the person. Pure. */
export function summaryOf(row) {
  const pick = (test) => FUNCTION_GROUPS.map(([name], index) => (test(row[index], index) ? name : undefined)).filter((name) => name !== undefined);
  const all = (list) => (list.length === FUNCTION_GROUPS.length ? 'tất cả các nhóm chức năng' : list.join('; '));
  const view = pick((cell) => cell.view);
  const make = pick((cell, index) => cell.make && index !== ADMIN_GROUP);
  const decide = pick((cell) => cell.decide);
  const admin = row[ADMIN_GROUP].make;
  const parts = [];
  if (view.length > 0) parts.push(`Xem: ${all(view)}.`);
  if (make.length > 0) parts.push(`Lập, cập nhật: ${make.length === FUNCTION_GROUPS.length - 1 ? 'tất cả các nhóm nghiệp vụ' : make.join('; ')}.`);
  if (decide.length > 0) parts.push(`Duyệt, quyết định: ${all(decide)}.`);
  if (admin) parts.push('Quản trị tổ chức, người dùng, vai trò, danh mục.');
  return parts.length === 0 ? 'Chỉ đăng nhập và xem thông tin của chính mình; chưa được cấp quyền nghiệp vụ.' : parts.join(' ');
}

/** The screens worth opening for an account of the demonstration, by the person of the seed layer. */
export const SUGGESTED = {
  owner: 'Tổng quan điều hành; Danh sách dự án; Tổng hợp giải ngân; Bảng deadline toàn danh mục; Hộp phê duyệt; Cây tổ chức',
  capApprover: 'Việc của tôi; Hộp phê duyệt; Tổng hợp giải ngân theo chủ đầu tư; Cảnh báo sớm; Kế hoạch năm',
  projectManager: 'Việc của tôi; Danh sách dự án, không gian dự án (tab Quy trình); Gói thầu; Hợp đồng; Bảng điểm của tôi',
  treasuryMaker: 'Danh sách hồ sơ thanh toán; Theo dõi gửi Kho bạc; Tạm ứng; Việc của tôi',
  projectViewer: 'Việc của tôi (Việc hôm nay); Bảng điểm của tôi; Thông báo',
  unitAdmin: 'Cây tổ chức; Người dùng và mời thành viên; Vai trò và quyền',
  auditor: 'Tổng quan thanh tra, kiểm toán; Nhật ký kiểm toán; Danh sách dự án',
  docHead: 'Bảng điều hành Ban chỉ đạo; Dự án cần Trưởng ban quan tâm; Theo dõi chỉ đạo',
  securityAdmin: 'Cấu hình an toàn; Ủy quyền có thời hạn; Nhật ký kiểm toán',
  nobody: 'Trang chủ; Thông tin cá nhân (tài khoản chưa có quyền nghiệp vụ, dùng để thấy hệ thống chặn đúng)',
};

export const TOUR = [
  ['1', 'demo', 'Đăng nhập tại địa chỉ web, vào "Tổng quan điều hành"', 'Việc cần xử lý ngay, số đã giải ngân năm 2026, cảnh báo đang mở, dòng vốn theo tháng'],
  ['2', 'demo', 'Mở "Dự án" > "Danh sách dự án", lọc theo giai đoạn; mở một dự án đang thực hiện', 'Dự án minh họa của tỉnh Cà Mau (kè biển, đường ven biển, bệnh viện, trường học...), nhóm A/B/C, mã dự án quốc gia; các tab của không gian dự án'],
  ['3', 'demo', 'Mở "Kế hoạch vốn" > "Kế hoạch năm" và "Nguồn vốn"', 'Kế hoạch vốn năm 2026 theo nguồn (ngân sách trung ương, địa phương, ODA) và từng dự án'],
  ['4', 'lanhdao', 'Mở "Giải ngân" > "Tổng hợp theo chủ đầu tư"', 'Kế hoạch, số giải ngân và tỷ lệ theo chủ đầu tư; số liệu chốt theo kỳ'],
  ['5', 'canbo.qlda', 'Mở "Nhà thầu" và "Gói thầu và đề án"; mở "Hợp đồng"', 'Kế hoạch lựa chọn nhà thầu, gói thầu ở nhiều bước của quy trình, hợp đồng đang hiệu lực'],
  ['6', 'ketoan', 'Mở "Thanh toán" > "Danh sách hồ sơ thanh toán"', 'Đề nghị thanh toán, tạm ứng, trạng thái gửi Kho bạc'],
  ['7', 'demo', 'Mở "Quy trình dự án và hạn ba màu" > "Bảng deadline"', 'Mọi việc đang mở của các dự án với màu đỏ (quá hạn), vàng (sắp đến hạn), xanh'],
  ['8', 'lanhdao', 'Mở "Việc của tôi" và hộp phê duyệt; mở một hồ sơ chờ duyệt', 'Hồ sơ chờ quyết định, nội dung và nút Duyệt / Trả lại (không bắt buộc bấm)'],
  ['9', 'nhanvien', 'Đăng nhập bằng tài khoản cán bộ, mở "Việc của tôi" và "Bảng điểm của tôi"', 'Việc được giao cho chính mình và điểm của mình; không thấy điểm của người khác'],
  ['10', 'demo', 'Mở "Quản trị tổ chức" > "Cây tổ chức"; mở ứng dụng điện thoại bằng cùng tài khoản', 'Cây đơn vị của tỉnh sau hợp nhất năm 2025; trên điện thoại: trang chủ, dự án, việc của tôi, phê duyệt'],
];

/** The rows of the workbook from what the installation answered. Pure. */
export function rowsOf({ credentials, memberships, grants, roles, units }) {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]));
  const people = Object.entries(credentials.people).map(([person, account]) => {
    const membership = membershipById.get(account.membershipId);
    const own = grants.filter((grant) => grant.membership_id === account.membershipId && String(grant.status ?? 'Active') === 'Active').map((grant) => roleById.get(grant.role_id)).filter((role) => role !== undefined);
    const permissions = [...new Set(own.flatMap((role) => role.permissions ?? []))];
    const matrix = FUNCTION_GROUPS.map(([, segments]) => capabilityOf(permissions, segments));
    // A role made in parts (CODE, CODE_2, ...) is one role to a reader.
    const names = [...new Set([...own].sort((x, y) => Number(y.rank ?? 0) - Number(x.rank ?? 0)).map((role) => SYSTEM_ROLE_NAMES[role.code] ?? String(role.name ?? role.code).replace(/ \(phần \d+\)$/u, '')))];
    return { person, username: account.username, password: account.password, displayName: account.displayName ?? '', unit: unitById.get(membership?.organization_id)?.name ?? '', roles: names, matrix, permissionCount: permissions.length, sample: account.sample === true, title: account.title ?? '' };
  });
  return people.sort((a, b) => Number(b.sample) - Number(a.sample));
}

export async function workbookOf({ credentials, people, apkNote, date }) {
  const require = createRequire(join(HERE, '..', 'apps', 'api', 'package.json'));
  const ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = SYSTEM_NAME;
  book.created = date;
  const head = (sheet, widths) => {
    sheet.columns.forEach((column, index) => (column.width = widths[index]));
    const row = sheet.getRow(sheet.rowCount);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17414B' } };
    row.alignment = { vertical: 'middle', wrapText: true };
    row.height = 30;
  };
  const wrap = (sheet, from) => {
    for (let index = from; index <= sheet.rowCount; index += 1) {
      const row = sheet.getRow(index);
      row.alignment = { vertical: 'top', wrapText: true };
      row.eachCell((cell) => (cell.border = { top: { style: 'thin', color: { argb: 'FFB8C4C8' } }, bottom: { style: 'thin', color: { argb: 'FFB8C4C8' } }, left: { style: 'thin', color: { argb: 'FFB8C4C8' } }, right: { style: 'thin', color: { argb: 'FFB8C4C8' } } }));
    }
  };
  const page = (sheet, landscape) => {
    sheet.pageSetup = { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    sheet.headerFooter = { oddFooter: `&L${SYSTEM_NAME} · tài khoản demo&RTrang &P / &N` };
  };
  const shared = new Set(people.map((person) => person.password)).size === 1 ? people[0].password : undefined;

  const access = book.addWorksheet('Truy cập');
  access.columns = [{ width: 28 }, { width: 90 }];
  access.addRow([`${SYSTEM_NAME}: thông tin truy cập bản DEMO`]).font = { bold: true, size: 14 };
  access.mergeCells('A1:B1');
  access.addRow([]);
  for (const [name, value] of [
    ['Tên hệ thống', SYSTEM_NAME],
    ['Địa chỉ web', credentials.origin],
    ['Ứng dụng điện thoại', apkNote],
    ['Cách đăng nhập', 'Nhập tên đăng nhập và mật khẩu (bản demo không hỏi mã OTP). Danh sách tài khoản ở trang tính "Tài khoản".'],
    ['Mật khẩu', shared === undefined ? 'Mỗi tài khoản một mật khẩu, xem trang tính "Tài khoản".' : `${shared} (dùng chung cho mọi tài khoản demo; phân biệt chữ hoa, chữ thường)`],
    ['Lưu ý về dữ liệu', 'Đây là môi trường DEMO. Toàn bộ dự án, số liệu, văn bản và tên người là dữ liệu MINH HỌA lấy bối cảnh tỉnh Cà Mau, KHÔNG phải số liệu thật của tỉnh.'],
    ['Lưu ý khi dùng', 'Không nhập dữ liệu thật hoặc dữ liệu nhạy cảm vào bản demo. Mật khẩu dùng chung chỉ dành cho việc xem thử; nhập sai mật khẩu 5 lần liên tiếp thì tài khoản bị khóa tạm.'],
    ['Văn bản ký số', 'Chữ ký số trên văn bản của bản demo do một tổ chức chứng thực minh họa cấp, không có giá trị pháp lý.'],
    ['Ngày lập', date.toISOString().slice(0, 10)],
  ]) {
    const row = access.addRow([name, value]);
    row.getCell(1).font = { bold: true };
  }
  wrap(access, 3);
  page(access, false);

  const accounts = book.addWorksheet('Tài khoản');
  accounts.columns = Array.from({ length: 8 }, () => ({}));
  accounts.addRow(['STT', 'Tên đăng nhập', 'Mật khẩu', 'Họ tên (minh họa)', 'Đơn vị', 'Vai trò', 'Xem được / làm được gì', 'Gợi ý màn hình nên xem']);
  head(accounts, [6, 18, 16, 22, 34, 30, 70, 50]);
  people.forEach((person, index) => accounts.addRow([index + 1, person.username, person.password, person.displayName, person.unit, person.roles.join(', '), summaryOf(person.matrix), SUGGESTED[person.person] ?? '']));
  wrap(accounts, 2);
  accounts.views = [{ state: 'frozen', ySplit: 1 }];
  page(accounts, true);

  const matrix = book.addWorksheet('Quyền theo vai');
  matrix.columns = Array.from({ length: people.length + 1 }, () => ({}));
  matrix.addRow(['Nhóm chức năng', ...people.map((person) => `${person.username}\n${person.roles[0] ?? ''}`)]);
  head(matrix, [38, ...people.map(() => 19)]);
  matrix.getRow(1).height = 48;
  FUNCTION_GROUPS.forEach(([name], index) => matrix.addRow([name, ...people.map((person) => cellOf(person.matrix[index], index === ADMIN_GROUP))]));
  wrap(matrix, 2);
  matrix.addRow([]);
  matrix.addRow(['Ghi chú: bảng lập từ quyền đang cấp trên hệ thống demo (vai trò và quyền của từng tài khoản) tại thời điểm lập tệp. "Xem" là đọc dữ liệu; "Lập" là tạo, cập nhật, trình; "Duyệt" là phê duyệt, quyết định, ký, khóa sổ; "Quản trị" là quản lý tổ chức, người dùng, vai trò, danh mục. "–" là không có quyền.']);
  matrix.mergeCells(matrix.rowCount, 1, matrix.rowCount, people.length + 1);
  matrix.getRow(matrix.rowCount).alignment = { wrapText: true, vertical: 'top' };
  matrix.getRow(matrix.rowCount).height = 48;
  matrix.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  page(matrix, true);

  const tour = book.addWorksheet('Kịch bản xem thử');
  tour.columns = Array.from({ length: 4 }, () => ({}));
  tour.addRow(['Bước', 'Đăng nhập bằng', 'Thao tác', 'Sẽ thấy']);
  head(tour, [7, 16, 62, 70]);
  for (const step of TOUR) tour.addRow(step);
  wrap(tour, 2);
  page(tour, true);
  return book;
}

export async function main(argv, { log = (line) => process.stdout.write(`${line}\n`), fetchImpl = fetch } = {}) {
  const { values } = parseArgs({ args: argv, options: { credentials: { type: 'string' }, api: { type: 'string' }, out: { type: 'string' }, apk: { type: 'string', default: 'Tệp cài đặt Android (APK) được giao kèm; đăng nhập bằng cùng tên đăng nhập và mật khẩu.' } }, allowPositionals: false });
  if (!values.credentials || !values.api || !values.out) {
    log('demo-accounts-xlsx: --credentials <file|->, --api <url> and --out <file> are required');
    return 2;
  }
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  if (!ignoredByGit(out)) {
    log(`demo-accounts-xlsx: ${out} is not ignored by git: a workbook with passwords is not written there`);
    return 1;
  }
  const credentials = readCredentials(values.credentials);
  const broker = brokerOf(credentials, {});
  const reader = new ApiReader({ base: values.api, tokenOf: (person) => broker.token(person), fetchImpl });
  const memberships = await reader.list('owner', '/resources/membership');
  const grants = await reader.list('owner', '/resources/role_grant');
  const roles = await reader.list('owner', '/resources/role_definition');
  const units = await reader.list('owner', '/resources/organization_unit');
  const people = rowsOf({ credentials, memberships, grants, roles, units });
  const book = await workbookOf({ credentials, people, apkNote: values.apk, date: new Date() });
  await book.xlsx.writeFile(out);
  // The file is opened again to prove what was written: sheets, rows and Vietnamese text.
  const require = createRequire(join(HERE, '..', 'apps', 'api', 'package.json'));
  const check = new (require('exceljs').Workbook)();
  await check.xlsx.readFile(out);
  for (const sheet of check.worksheets) log(`  ${sheet.name}: ${sheet.rowCount} dòng; ô đầu: ${String(sheet.getRow(1).getCell(1).value).slice(0, 60)}`);
  for (const person of people) log(`  ${person.username}: ${person.unit} | ${person.roles.join(', ')} | ${person.permissionCount} quyền`);
  log(`demo-accounts-xlsx: ${people.length} accounts written to ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`demo-accounts-xlsx: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
