import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK, TITLE_MAX, isGenericTitle, notificationFromPush, pushDataOf, safeDeepLink } from './push-payload';

const WORDS = { appName: 'Hệ thống quản lý đầu tư công', body: 'Bạn có một thông báo mới. Mở để xem.' };
const ID = 'AbCdEfGhIjKlMnOpQrSt1234';

describe('what a push may carry (R7): a generic title and a link, nothing else', () => {
  it('shows the generic title and the link of the notification', () => {
    expect(notificationFromPush(JSON.stringify({ v: 1, title: 'Bạn có việc mới', url: `/r/${ID}` }), WORDS)).toEqual({ title: 'Bạn có việc mới', body: WORDS.body, url: `/r/${ID}` });
  });

  it('has exactly three members and the body is always the fixed sentence, whatever the server wrote', () => {
    const shown = notificationFromPush(JSON.stringify({ title: 'Việc mới', body: 'Duyệt 2.500.000.000 đồng cho Nguyễn Văn A', amount: 2500000000, name: 'Nguyễn Văn A', url: `/r/${ID}`, data: { project: 'DA-001' } }), WORDS);
    expect(Object.keys(shown).sort()).toEqual(['body', 'title', 'url']);
    expect(shown.body).toBe(WORDS.body);
    expect(JSON.stringify(shown)).not.toMatch(/2\.?500|Nguyễn Văn A|DA-001|amount/);
  });

  it('replaces a title that holds a figure, a code, a mail address or a word of money by the name of the product', () => {
    for (const title of ['Duyệt 2.500.000.000 đồng', 'Báo cáo BC-2027-001', 'Gửi an@example.vn', 'Giải ngân 3 tỷ', 'Chi 5 triệu', 'Payment of $5', 'Tổng 1 billion', 'x'.repeat(TITLE_MAX + 1), '', '   ']) {
      expect(isGenericTitle(title), title).toBe(false);
      expect(notificationFromPush(JSON.stringify({ title, url: '/m' }), WORDS).title, title).toBe(WORDS.appName);
    }
    expect(isGenericTitle(42)).toBe(false);
    expect(isGenericTitle(null)).toBe(false);
  });

  it('opens only the opaque link of a notification or a start page of the manager screens', () => {
    for (const link of [`/r/${ID}`, '/m', '/m/approvals', '/m/dashboard', '/m/directives']) expect(safeDeepLink(link)).toBe(link);
    for (const link of ['/r/short', '/projects/DA-001', '/m/approvals?task=1', '/m/approvals#x', 'https://evil.example/r/' + ID, '//evil.example', 'javascript:alert(1)', '/r/' + ID + '/extra', '/home/home-09', '', null, undefined, 7]) {
      expect(safeDeepLink(link), String(link)).toBe(DEFAULT_LINK);
    }
  });

  it('survives data that is not what the server writes', () => {
    for (const data of [undefined, '', 'not json', '[]', '"text"', 'null', '123', '{"title": 7, "url": {}}']) {
      expect(notificationFromPush(data, WORDS)).toEqual({ title: WORDS.appName, body: WORDS.body, url: DEFAULT_LINK });
    }
  });

  it('writes the data of a push as the version, a generic title and a safe link only', () => {
    expect(JSON.parse(pushDataOf('Việc mới', `/r/${ID}`))).toEqual({ v: 1, title: 'Việc mới', url: `/r/${ID}` });
    expect(JSON.parse(pushDataOf('Duyệt 5 tỷ', '/projects/x'))).toEqual({ v: 1, title: '', url: DEFAULT_LINK });
  });
});
