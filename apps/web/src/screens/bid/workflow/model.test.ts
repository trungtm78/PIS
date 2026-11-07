import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import { blockerLabel, countdownText, errorText, methodLabel, toTimelineEntry, whereLine } from './labels';
import { billions, blockersOf, filtersOf, healthOf, queryOf, toDetail, toTree, treeToView, withoutPeriod } from './model';
import type { TreeNodeDto, TreeWords } from './model';
import { detailDto, entry, node, treeDto } from './test-support';

const WORDS: TreeWords = { root: 'Tất cả', unit: 'tỷ đồng', notStarted: 'Chưa bắt đầu', completed: 'Đã hoàn thành', cancelled: 'Đã hủy', onHold: 'Tạm dừng', late: 'Trễ hạn', returned: 'Bị trả lại', onTrack: 'Đúng tiến độ', hold: 'tạm dừng {count}' };

describe('money', () => {
  it('writes whole VND as billions with two decimals, counted exactly', () => {
    expect(billions('128400000000', 'vi')).toBe('128,40');
    expect(billions('128400000000', 'en')).toBe('128.40');
    expect(billions('1234567890123', 'vi')).toBe('1.234,57');
    expect(billions('0', 'vi')).toBe('0,00');
    expect(billions('4999999', 'vi')).toBe('0,00');
    expect(billions('5000000', 'vi')).toBe('0,01');
    expect(billions('12x', 'vi')).toBe('');
  });
});

describe('filters', () => {
  it('reads the filters of the address, keeps what is known and drops what is empty', () => {
    const filters = filtersOf(new URLSearchParams('method=OPEN_BIDDING&late_only=true&owner_id=&from=2026-10-01&other=1'));
    expect(filters).toEqual({ method: 'OPEN_BIDDING', late_only: true, from: '2026-10-01' });
    expect(withoutPeriod(filters)).toEqual({ method: 'OPEN_BIDDING', late_only: true });
    expect(queryOf(filters)).toEqual({ method: 'OPEN_BIDDING', late_only: true, from: '2026-10-01' });
    expect(filtersOf(new URLSearchParams('late_only=false'))).toEqual({});
  });
});

describe('health', () => {
  const step = (over: Partial<TreeNodeDto>): TreeNodeDto => node('S:M:A', { kind: 'STEP', ...over }) as TreeNodeDto;
  it('is on track with nothing late, needs attention below 30% late, late from 30%, on hold when all are held, none when empty', () => {
    expect(healthOf(step({ count: 10, late_count: 0 }), 0)).toBe('ok');
    expect(healthOf(step({ count: 10, late_count: 2 }), 0)).toBe('attention');
    expect(healthOf(step({ count: 10, late_count: 3 }), 0)).toBe('late');
    expect(healthOf(step({ count: 4, late_count: 0 }), 4)).toBe('hold');
    expect(healthOf(step({ count: 0 }), 0)).toBe('none');
  });
  it('reads a sub-state by what it is and a terminal by whether it was reached', () => {
    expect(healthOf(step({ kind: 'SUBSTATE', substate: 'LATE', count: 1 }), 0)).toBe('late');
    expect(healthOf(step({ kind: 'SUBSTATE', substate: 'RETURNED', count: 1 }), 0)).toBe('attention');
    expect(healthOf(step({ kind: 'SUBSTATE', substate: 'ON_HOLD', count: 1 }), 0)).toBe('hold');
    expect(healthOf(step({ kind: 'TERMINAL', terminal: 'COMPLETED', count: 1 }), 0)).toBe('ok');
    expect(healthOf(step({ kind: 'TERMINAL', terminal: 'CANCELLED', count: 1 }), 0)).toBe('none');
  });
});

describe('the tree as the kit draws it', () => {
  const view = treeToView(toTree(treeDto()), WORDS, 'vi');
  const byId = (id: string) => view.nodes.find((one) => one.id === id);

  it('puts the steps in their columns in the lane of their method, the packages not started first and the ends last', () => {
    expect(byId('S:OPEN_BIDDING:DOC_PREPARE')).toMatchObject({ lane: 'Quy trình đấu thầu rộng rãi', column: 1, row: 'main', inFlow: true, count: 2, value: '200,00', unit: 'tỷ đồng', share: 0.5, medianDays: 6, lateCount: 1 });
    expect(byId('T:OPEN_BIDDING:NOT_STARTED')).toMatchObject({ column: 0, inFlow: true, label: 'Chưa bắt đầu' });
    expect(byId('T:OPEN_BIDDING:COMPLETED')).toMatchObject({ column: 3, terminal: true, row: 'main', label: 'Đã hoàn thành' });
    expect(byId('T:OPEN_BIDDING:CANCELLED')).toMatchObject({ column: 3, terminal: true, row: 'below' });
    expect(byId('ROOT')).toMatchObject({ inFlow: false, label: 'Tất cả' });
  });

  it('draws only the hold and returned paths that have packages, below their step; late and on track stay in the outline', () => {
    expect(byId('S:OPEN_BIDDING:EVALUATE:ON_HOLD')).toMatchObject({ inFlow: true, row: 'below', column: 2, label: 'Tạm dừng', health: 'hold' });
    expect(byId('S:OPEN_BIDDING:DOC_PREPARE:ON_HOLD')?.inFlow).toBe(false);
    expect(byId('S:OPEN_BIDDING:DOC_PREPARE:LATE')?.inFlow).toBe(false);
    expect(byId('S:OPEN_BIDDING:DOC_PREPARE:ON_TRACK')?.inFlow).toBe(false);
  });

  it('counts the held packages of a step on its card', () => {
    expect(byId('S:OPEN_BIDDING:EVALUATE')).toMatchObject({ heldCount: 1, health: 'hold' });
  });

  it('keeps the edges between the nodes that are drawn and names a hold edge in words', () => {
    const tree = toTree(treeDto({ edges: [{ from: 'S:OPEN_BIDDING:DOC_PREPARE', to: 'S:OPEN_BIDDING:EVALUATE', kind: 'ADVANCE', count: 2 }, { from: 'S:OPEN_BIDDING:EVALUATE', to: 'S:OPEN_BIDDING:EVALUATE:ON_HOLD', kind: 'HOLD', count: 1 }, { from: 'S:OPEN_BIDDING:EVALUATE', to: 'T:OPEN_BIDDING:CANCELLED', kind: 'CANCEL', count: 1 }, { from: 'S:OPEN_BIDDING:DOC_PREPARE', to: 'S:OPEN_BIDDING:DOC_PREPARE:LATE', kind: 'HOLD', count: 9 }] }));
    const { edges } = treeToView(tree, WORDS, 'vi');
    expect(edges).toEqual([
      { from: 'S:OPEN_BIDDING:DOC_PREPARE', to: 'S:OPEN_BIDDING:EVALUATE', count: 2, kind: 'forward' },
      { from: 'S:OPEN_BIDDING:EVALUATE', to: 'S:OPEN_BIDDING:EVALUATE:ON_HOLD', count: 1, kind: 'return', label: 'tạm dừng 1' },
      { from: 'S:OPEN_BIDDING:EVALUATE', to: 'T:OPEN_BIDDING:CANCELLED', count: 1, kind: 'drop' },
    ]);
  });

  it('refuses an answer that is not a tree instead of drawing an empty one', () => {
    expect(() => toTree({ nodes: 'x' })).toThrow('unexpected tree');
    expect(() => toDetail({ workflow: { steps: [] } })).toThrow('unexpected detail');
    expect(toDetail(detailDto()).package.code).toBe('GT-1');
  });
});

describe('the words of the screens', () => {
  it('names the methods, the countdown and the line under the stepper', () => {
    expect(methodLabel(t, 'OPEN_BIDDING')).toBe('Đấu thầu rộng rãi');
    expect(methodLabel(t, 'UNKNOWN')).toBe('UNKNOWN');
    expect(countdownText(t, { days_left: 2, due_on: '2026-11-14' })).toBe('Còn 2 ngày · 14/11');
    expect(countdownText(t, { days_left: 0, due_on: '2026-11-14' })).toBe('Hôm nay là hạn · 14/11');
    expect(countdownText(t, { days_left: -3, due_on: '2026-11-09' })).toBe('Quá hạn 3 ngày · 09/11');
    expect(countdownText(t, null)).toBe('Chưa tính được hạn');
    expect(whereLine(t, { stepName: 'Đánh giá hồ sơ', days: 12, over: 4, owner: 'Nguyễn Văn An' })).toBe('Đang ở Đánh giá hồ sơ · 12 ngày ở bước · trễ 4 ngày so với chuẩn · người giữ: Nguyễn Văn An');
    expect(whereLine(t, { stepName: 'Đánh giá hồ sơ', days: null, over: 0, owner: null })).toBe('Đang ở Đánh giá hồ sơ · chưa có người phụ trách');
    expect(blockerLabel(t, { reason: 'REQUIRED_ITEMS_OPEN', count: 2, detail: null })).toBe('Còn 2 mục bắt buộc chưa xong');
  });

  it('turns the entries of the API into entries of the timeline with their days spent and their evidence', () => {
    const names = { step: (code: string | null) => (code === 'A' ? 'Bước A' : code === 'B' ? 'Bước B' : undefined) };
    const move = toTimelineEntry(t, entry('x', { from_step: 'A', to_step: 'B', spent_working_days: 3, spent_calendar_days: 5 }) as never, names);
    expect(move).toMatchObject({ kind: 'transition', from: 'Bước A', to: 'Bước B', after: 'sau 3 ngày làm việc ở bước trước', actor: { name: 'Nguyễn Văn An', initials: 'NA' } });
    const calendar = toTimelineEntry(t, entry('x', { spent_working_days: null, spent_calendar_days: 5 }) as never, names);
    expect(calendar.after).toBe('sau 5 ngày ở bước trước');
    const back = toTimelineEntry(t, entry('x', { kind: 'RETURN', from_step: 'B', to_step: 'A', reason: 'Thiếu hồ sơ', state_change: true }) as never, names);
    expect(back).toMatchObject({ kind: 'return', title: 'Trả lại từ Bước B về Bước A', note: 'Thiếu hồ sơ' });
    const clock = toTimelineEntry(t, entry('x', { kind: 'CLOCK_OVERDUE', actor: null, from_step: 'B' }) as never, names);
    expect(clock).toMatchObject({ kind: 'clock', badge: 'Quá hạn', tone: 'danger', actor: null });
    expect(toTimelineEntry(t, entry('x', { kind: 'IMPORT', subject: 'BID_OPENING' }) as never, names)).toMatchObject({ kind: 'import', title: 'Nhập từ muasamcong: Mở thầu' });
  });

  it('says a refusal in words of the screen, never the text of the server', () => {
    const error = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', detail: 'internal detail' });
    expect(errorText(t, error('VERSION_CONFLICT'))).toContain('tải lại');
    expect(errorText(t, error('WORKFLOW_MAKER_IS_APPROVER', 403))).toContain('người duyệt');
    expect(errorText(t, error('SOMETHING_NEW', 500))).toContain('SOMETHING_NEW');
    expect(errorText(t, error('SOMETHING_NEW', 403))).toContain('quyền');
    expect(errorText(t, new Error('x'))).toBe(t('prc1.error.unknown.text'));
    expect(errorText(t, error('X'))).not.toContain('internal detail');
  });

  it('reads the blockers a refusal names', () => {
    expect(blockersOf(new ApiError({ status: 409, code: 'PACKAGE_WORKFLOW_BLOCKED', correlationId: 'c', extensions: { blockers: [{ code: 'REQUIRED_ITEM_OPEN', subject: 'A1' }, { code: 'MAKER_IS_APPROVER', subject: null }, { nope: 1 }] } }))).toEqual([
      { code: 'REQUIRED_ITEM_OPEN', subject: 'A1' },
      { code: 'MAKER_IS_APPROVER', subject: null },
    ]);
    expect(blockersOf(new Error('x'))).toEqual([]);
  });
});
