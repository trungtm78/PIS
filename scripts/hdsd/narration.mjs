/** The kind of a screen of the catalogue, said the way a person would say it. */
const KIND_NOUN = {
  dashboard: 'bảng điều hành',
  list: 'danh sách',
  table: 'bảng dữ liệu',
  form: 'biểu mẫu để nhập thông tin',
  detail: 'màn hình xem chi tiết',
  kanban: 'bảng công việc theo cột',
  map: 'bản đồ',
  rank: 'bảng xếp hạng',
  tree: 'sơ đồ dạng cây',
  cards: 'các thẻ thông tin',
  timeline: 'dòng thời gian',
  review: 'màn hình rà soát',
  approval: 'màn hình phê duyệt',
  search: 'màn hình tìm kiếm',
  auth: 'màn hình xác thực',
  compare: 'màn hình so sánh',
  import: 'màn hình nhập dữ liệu từ tệp',
  wizard: 'các bước hướng dẫn',
  matrix: 'ma trận',
  calendar: 'lịch',
  chart: 'biểu đồ',
};

// What the shell and the screens repeat everywhere: it says nothing about the screen the person is looking at.
const GENERIC = /^(đóng|hủy|huỷ|quay lại|mở menu|đóng menu|trợ giúp|ghim|bỏ ghim|tìm kiếm toàn hệ thống|thông báo|tổng quan|việc của tôi|tất cả ứng dụng|quản trị & cấu hình|tất cả chức năng)$/iu;

export const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/đ/giu, 'd')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();

/** A list the way it is read aloud: "a, b và c". */
export function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} và ${items[items.length - 1]}`;
}

const sentence = (text) => {
  const trimmed = String(text).trim().replace(/[.;,\s]+$/u, '');
  return trimmed === '' ? '' : `${trimmed}.`;
};

const unique = (items) => [...new Set(items.map((item) => item.trim()).filter((item) => item !== ''))];

/** The fields the design names that the real screen shows, found by their words (without accents or case); the rest the screen does not show. */
export function matchFields(designFields, labels) {
  const haystack = labels.map(fold);
  const shown = [];
  const absent = [];
  for (const field of designFields) {
    // "Nhóm dự án (QTQG/A/B/C)" is looked for by "nhóm dự án"
    const name = fold(field.replace(/\(.*?\)/gu, ' '));
    if (name === '') continue;
    (haystack.some((label) => label.includes(name) || (label.length >= 4 && name.includes(label))) ? shown : absent).push(field.replace(/\s*\(.*?\)/gu, '').trim());
  }
  return { shown, absent };
}

/** The words the voice says about one screen: what it is, who uses it, the rule, what is on it now and what can be done. */
export function describeScreen(screen, facts, { withRule = true } = {}) {
  const noun = KIND_NOUN[screen.kind] ?? 'màn hình';
  const parts = [sentence(`${screen.title}`)];
  if (facts.denied) {
    parts.push(sentence(`Với tài khoản đang dùng, màn hình này hiện thông báo không đủ quyền; người có vai trò ${screen.role} mới dùng được`));
    return { text: parts.join(' '), shown: [], absent: screen.fields ?? [], actions: [] };
  }
  parts.push(sentence(`Đây là ${noun}${screen.role ? `, dành cho ${screen.role}` : ''}`));
  // The rule is the one of the whole group of screens: it is said once, on the first screen, not on every one.
  if (withRule && screen.rule) parts.push(sentence(screen.rule));
  const { shown, absent } = matchFields(screen.fields ?? [], facts.labels);
  const named = shown.length >= 2 ? shown : unique(facts.labels.filter((label) => !GENERIC.test(label) && label.length <= 40)).slice(0, 6);
  if (named.length > 0) parts.push(sentence(`Trên màn hình có: ${joinList(named.slice(0, 8))}`));
  const actions = unique(facts.buttons.filter((button) => !GENERIC.test(button) && button.length <= 40)).slice(0, 5);
  if (actions.length > 0) parts.push(sentence(`Các thao tác chính: ${joinList(actions)}`));
  if (facts.rows > 0) parts.push(sentence(`Lúc quay, màn hình đang có ${facts.rows} dòng dữ liệu`));
  else if (facts.empty) parts.push(sentence('Lúc quay, chưa có dữ liệu nào trong màn hình này'));
  return { text: parts.join(' '), shown, absent, actions };
}

/** The flow of a tour: one step for each screen of the group, with the words made from the catalogue and from what the real screen showed. */
export function composeTour(chapter, screens, factsById) {
  const roles = unique(screens.flatMap((screen) => (screen.role ?? '').split(/,\s*/u)));
  const steps = screens.map((screen, index) => {
    const facts = factsById.get(screen.id) ?? { labels: [], buttons: [], rows: 0, empty: false, denied: false };
    const described = describeScreen(screen, facts, { withRule: index === 0 });
    return {
      id: screen.id.toLowerCase(),
      screens: [screen.id],
      heading: screen.title,
      text: described.text,
      note: described.absent.length > 0 && !facts.denied ? `Thiết kế còn nêu các thông tin: ${joinList(described.absent)}. Màn hình ở bản hiện tại chưa hiện các mục này bằng đúng tên đó.` : '',
    };
  });
  return {
    id: chapter.id,
    group: chapter.groupTitle ?? chapter.module,
    title: chapter.title,
    audience: joinList(roles.slice(0, 4)) || 'Người dùng hệ thống',
    outcome: `Biết mỗi màn hình của nhóm ${chapter.group} dùng để làm gì, ai dùng, có những thông tin và thao tác nào.`,
    persona: 'owner',
    generated: true,
    steps,
  };
}
