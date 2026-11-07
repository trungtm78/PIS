import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeTour, describeScreen, fold, joinList, matchFields } from './narration.mjs';

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
  assert.match(text, /^Tạo dự án\. Đây là biểu mẫu để nhập thông tin, dành cho Chủ đầu tư, Sở Tài chính\. Quản lý vòng đời dự án\./);
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
