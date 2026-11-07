import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeTour, describeScreen, fold, joinList, matchFields, plainRole, plainRule } from './narration.mjs';

const screen = { id: 'PRJ-02', title: 'Tạo dự án', kind: 'form', role: 'Chủ đầu tư, Sở Tài chính', rule: 'Quản lý vòng đời dự án', fields: ['Mã dự án', 'Tên dự án', 'Nhóm dự án (QTQG/A/B/C)', 'Năm bắt đầu–kết thúc'] };
const facts = (extra = {}) => ({ labels: ['Mã dự án', 'Tên dự án', 'Nhóm dự án', 'Tổng mức'], buttons: ['Tạo dự án', 'Hủy', 'Trợ giúp'], rows: 0, empty: false, denied: false, ...extra });

test('words are compared without accents or case, and a list is read as a person reads it', () => {
  assert.equal(fold('  Nhóm  DỰ ÁN Đầu tư '), 'nhom du an dau tu');
  assert.equal(joinList([]), '');
  assert.equal(joinList(['a']), 'a');
  assert.equal(joinList(['a', 'b', 'c']), 'a, b và c');
});

test('a field of the design is shown when the real screen has its words, and absent when it does not', () => {
  const { shown, absent } = matchFields(screen.fields, facts().labels);
  assert.deepEqual(shown, ['Mã dự án', 'Tên dự án', 'Nhóm dự án']);
  assert.deepEqual(absent, ['Năm bắt đầu–kết thúc']);
});

test('the words of a screen say what it is, who uses it, the rule, what is on it and what can be done; the buttons of the shell are left out', () => {
  const { text, actions } = describeScreen(screen, facts({ rows: 12 }));
  assert.match(text, /^Tạo dự án\. Đây là biểu mẫu để nhập thông tin, dành cho Chủ đầu tư và Sở Tài chính\. Quản lý vòng đời dự án\./);
  assert.match(text, /Trên màn hình có: Mã dự án, Tên dự án và Nhóm dự án\./);
  assert.match(text, /Các thao tác chính: Tạo dự án\./);
  assert.match(text, /đang có 12 dòng dữ liệu/);
  assert.deepEqual(actions, ['Tạo dự án']);
});

test('a screen that refuses the person says so and does not invent fields; an empty screen says it is empty', () => {
  const denied = describeScreen(screen, facts({ denied: true }));
  assert.match(denied.text, /không đủ quyền/);
  assert.doesNotMatch(denied.text, /Trên màn hình có/);
  assert.match(describeScreen(screen, facts({ empty: true })).text, /chưa có dữ liệu nào/);
});

test('when the design names few fields the real labels are used, and the tour has one step for each screen', () => {
  const bare = { id: 'X-01', title: 'Màn X', kind: 'weird', role: '', rule: 'Quy tắc riêng', fields: ['Không có trên màn'] };
  const flow = composeTour({ id: 'tour-x', module: 'X', group: 'G', title: 'T' }, [screen, bare], new Map([['PRJ-02', facts()], ['X-01', facts({ labels: ['Cột A', 'Cột B'] })]]));
  assert.equal(flow.steps.length, 2);
  assert.deepEqual(flow.steps.map((step) => step.id), ['prj-02', 'x-01']);
  assert.match(flow.steps[1].text, /Trên màn hình có: Cột A và Cột B\./);
  assert.match(flow.steps[1].text, /Đây là màn hình\./);
  assert.match(flow.steps[0].note, /Năm bắt đầu–kết thúc/);
  assert.equal(flow.generated, true);
  assert.equal(flow.audience, 'Chủ đầu tư và Sở Tài chính');
  assert.match(flow.steps[0].text, /Quản lý vòng đời dự án/);
  assert.doesNotMatch(flow.steps[1].text, /Quản lý vòng đời/);
});

test('the roles of the catalogue are said in the words of the customer: no codes, no English, no duplicates, at most three', () => {
  assert.equal(plainRole('TENANT_ADMIN / UNIT_ADMIN (cấu hình trong subtree); AUDITOR chỉ đọc'), 'quản trị tổ chức, quản trị đơn vị và kiểm toán viên');
  assert.equal(plainRole('NOTIFICATION_ADMIN; người duyệt chiến dịch NOTIFICATION_APPROVER'), 'quản trị thông báo và người duyệt chiến dịch thông báo');
  assert.equal(plainRole('Theo vai trò đang chọn'), '');
  assert.equal(plainRole('Data owner, Data steward, data engineer, FinOps'), 'chủ sở hữu dữ liệu, người quản lý dữ liệu và kỹ sư dữ liệu');
  assert.equal(plainRole(undefined), '');
});

test('the rule of a screen keeps what a person can say and leaves out identifiers, arrows and the English of engineers', () => {
  assert.equal(plainRule('registerMigrationBatch→dryRunMigrationBatch→applyMigrationBatch; cùng tệp bị chặn; lỗi từng dòng'), 'Cùng tệp bị chặn. Lỗi từng dòng.');
  assert.equal(plainRule('Dữ liệu offline chỉ cho bản nháp; phê duyệt kiểm tra online tại server.'), 'Dữ liệu ngoại tuyến chỉ cho bản nháp. Phê duyệt kiểm tra trực tuyến tại máy chủ.');
  assert.equal(plainRule('Append-only. seal Merkle mỗi 5 phút.'), '');
  assert.equal(plainRule('Lũy kế là snapshot không cộng giữa các tuần'), 'Lũy kế là ảnh chụp số liệu không cộng giữa các tuần.');
});

test('the buttons that belong to one record of the test data, and the ones that retry, are not read as the actions of the screen', () => {
  const { actions, text } = describeScreen(screen, facts({ buttons: ['Mở dự án E2E 001', 'Thử lại', 'Tạo dự án'], labels: ['Mã dự án', 'Tên dự án', 'Thử lại'] }));
  assert.deepEqual(actions, ['Tạo dự án']);
  assert.doesNotMatch(text, /E2E|Thử lại/);
  assert.match(describeScreen({ ...screen, role: 'AUDITOR' }, facts({ denied: true })).text, /vai trò kiểm toán viên mới dùng được/);
});
