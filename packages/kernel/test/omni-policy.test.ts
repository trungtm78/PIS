import { assertCannedReply, assertPolicy, assertPublishReason, foldText, routeOf } from '../src/omni-policy';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const UNIT_A = '00000000-0000-4000-8000-0000000000a1';
const UNIT_B = '00000000-0000-4000-8000-0000000000a2';
const policy = (change: Record<string, unknown> = {}) => ({ rules: [{ queue_unit_id: UNIT_A }], calendar_code: 'VN-STD', first_response_minutes: 30, resolution_hours: 24, ...change });
const reply = (change: Record<string, unknown> = {}) => ({ code: 'greet.hello', title: 'Lời chào', body_text: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'ZALO_OA'], classification: 'PUBLIC', ...change });

describe('the routing and the canned replies of the omnichannel center (ST-OMNI-006, OMNI.md 3.1, BR-OMNI-06, BR-OMNI-08)', () => {
  describe('a routing policy', () => {
    it('takes rules in order, the calendar, the minutes of the first answer and the hours of the resolution', () => {
      expect(assertPolicy(policy({ rules: [{ channels: ['WHATSAPP'], keywords: ['  Hủy Hợp Đồng ', 'khiếu nại'], queue_unit_id: UNIT_A.toUpperCase(), priority: 'HIGH' }, { queue_unit_id: UNIT_B }] }))).toEqual({
        rules: [
          { channels: ['WHATSAPP'], keywords: ['huy hop dong', 'khieu nai'], queueUnitId: UNIT_A, priority: 'HIGH' },
          { channels: [], keywords: [], queueUnitId: UNIT_B, priority: 'NORMAL' },
        ],
        calendarCode: 'VN-STD',
        firstResponseMinutes: 30,
        resolutionHours: 24,
      });
      expect(assertPolicy(policy({ rules: [] })).rules).toEqual([]);
    });

    it('refuses what is not a rule: another key, a channel that carries no message, a repeat, a word that is empty or too long, a unit that is not an id, a priority that is not one', () => {
      const bad = (rule: unknown) => refusal(() => assertPolicy(policy({ rules: [rule] })));
      for (const rule of [
        null,
        'x',
        { queue_unit_id: UNIT_A, owner: 'x' },
        { queue_unit_id: UNIT_A, channels: 'EMAIL' },
        { queue_unit_id: UNIT_A, channels: ['PUSH_FCM'] },
        { queue_unit_id: UNIT_A, channels: ['EMAIL', 'EMAIL'] },
        { queue_unit_id: UNIT_A, channels: [3] },
        { queue_unit_id: UNIT_A, keywords: 'x' },
        { queue_unit_id: UNIT_A, keywords: ['  '] },
        { queue_unit_id: UNIT_A, keywords: ['a', 'A'] },
        { queue_unit_id: UNIT_A, keywords: ['x'.repeat(61)] },
        { queue_unit_id: UNIT_A, keywords: Array.from({ length: 21 }, (_, index) => `w${index}`) },
        { queue_unit_id: 'x' },
        {},
        { queue_unit_id: UNIT_A, priority: 'URGENT' },
      ]) {
        expect(bad(rule)).toEqual({ code: 'POLICY_INVALID', detail: 'rules', status: 422 });
      }
      expect(refusal(() => assertPolicy(policy({ rules: 'x' }))).detail).toBe('rules');
      expect(refusal(() => assertPolicy(policy({ rules: Array.from({ length: 51 }, () => ({ queue_unit_id: UNIT_A })) }))).detail).toBe('rules');
    });

    it('refuses a calendar that is not a code and minutes or hours that are not whole numbers in range', () => {
      for (const calendar_code of [undefined, '', '   ', 'a b', 'x'.repeat(61), 3]) expect(refusal(() => assertPolicy(policy({ calendar_code }))).detail).toBe('calendar_code');
      for (const first_response_minutes of [0, -1, 1.5, '30', 10_081, undefined]) expect(refusal(() => assertPolicy(policy({ first_response_minutes }))).detail).toBe('first_response_minutes');
      for (const resolution_hours of [0, 2.5, '24', 2_401, undefined]) expect(refusal(() => assertPolicy(policy({ resolution_hours }))).detail).toBe('resolution_hours');
      expect(assertPolicy(policy({ first_response_minutes: 10_080, resolution_hours: 2_400, calendar_code: ' VN-STD ' }))).toMatchObject({ firstResponseMinutes: 10_080, resolutionHours: 2_400, calendarCode: 'VN-STD' });
    });

    it('routes by the first rule that fits the channel and the words, ignoring case and accents, and by none when none fits', () => {
      const rules = assertPolicy(
        policy({
          rules: [
            { channels: ['WHATSAPP'], keywords: ['khiếu nại', 'tố cáo'], queue_unit_id: UNIT_B, priority: 'HIGH' },
            { keywords: ['hồ sơ'], queue_unit_id: UNIT_A },
            { channels: ['EMAIL'], queue_unit_id: UNIT_B, priority: 'LOW' },
          ],
        }),
      ).rules;
      expect(routeOf(rules, { channel: 'WHATSAPP', text: 'Tôi muốn KHIEU NAI về việc đền bù' })).toEqual({ queueUnitId: UNIT_B, priority: 'HIGH' });
      // The same words on another channel fall to the next rule that fits.
      expect(routeOf(rules, { channel: 'EMAIL', text: 'khiếu nại hồ sơ' })).toEqual({ queueUnitId: UNIT_A, priority: 'NORMAL' });
      expect(routeOf(rules, { channel: 'EMAIL', text: 'Xin chào' })).toEqual({ queueUnitId: UNIT_B, priority: 'LOW' });
      expect(routeOf(rules, { channel: 'SMS', text: 'Xin chào' })).toBeUndefined();
      expect(routeOf([], { channel: 'SMS', text: 'x' })).toBeUndefined();
    });

    it('folds a text to what can be compared: no accents, no case, one space between words', () => {
      expect(foldText('  Đền   BÙ\tGiải phóng  ')).toBe('den bu giai phong');
    });
  });

  describe('a canned reply', () => {
    it('takes a code, a title, a text with no variable, the channels it is for and a class that may be sent', () => {
      expect(assertCannedReply(reply({ title: '  Lời chào  ', classification: 'INTERNAL' }))).toEqual({
        code: 'greet.hello',
        title: 'Lời chào',
        bodyText: 'Xin chào, chúng tôi đã nhận được tin của bạn.',
        channels: ['EMAIL', 'ZALO_OA'],
        classification: 'INTERNAL',
      });
    });

    it('AC-ST-OMNI-006-3 UAT-PLAN-52: refuses a variable in the text, however it is written, and a class that is confidential or personal, with 422 on the field', () => {
      for (const body_text of ['Xin chào {{name}}', 'Xin chào {name}', 'Xin chào ${name}', 'Mã hồ sơ %code%', 'a {{ x }} b']) {
        expect(refusal(() => assertCannedReply(reply({ body_text })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'body_text', status: 422 });
      }
      for (const classification of ['CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE', 'SECRET', undefined]) {
        expect(refusal(() => assertCannedReply(reply({ classification })))).toEqual({ code: 'VALIDATION_FAILED', detail: 'classification', status: 422 });
      }
      // A text that only has braces in it is not a variable.
      expect(assertCannedReply(reply({ body_text: 'Giá 50% {không đổi} (xem {1})' })).bodyText).toBe('Giá 50% {không đổi} (xem {1})');
    });

    it('refuses what is not a code, a title, a text of 1 to 2000 characters or a list of channels that carry messages', () => {
      for (const code of [undefined, 'ab', 'Has Space', 'UPPER', 'x'.repeat(61)]) expect(refusal(() => assertCannedReply(reply({ code }))).detail).toBe('code');
      for (const title of [undefined, '   ', 'x'.repeat(121)]) expect(refusal(() => assertCannedReply(reply({ title }))).detail).toBe('title');
      for (const body_text of [undefined, '   ', 'x'.repeat(2_001)]) expect(refusal(() => assertCannedReply(reply({ body_text }))).detail).toBe('body_text');
      for (const channels of [undefined, [], 'EMAIL', ['PUSH_FCM'], ['EMAIL', 'EMAIL'], [3]]) expect(refusal(() => assertCannedReply(reply({ channels }))).detail).toBe('channels');
      expect(assertCannedReply(reply({ body_text: 'x'.repeat(2_000) })).bodyText).toHaveLength(2_000);
    });
  });

  it('asks a reason of 10 to 2000 characters for a publication', () => {
    expect(assertPublishReason({ reason: '  Chính sách mới áp dụng từ tháng 11.  ' })).toBe('Chính sách mới áp dụng từ tháng 11.');
    for (const reason of [undefined, 3, 'short', 'r'.repeat(2_001)]) expect(refusal(() => assertPublishReason({ reason })).detail).toBe('reason');
  });
});
