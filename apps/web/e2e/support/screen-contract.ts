/**
 * The screen contract (UAT cases UI-<SCREEN>, design type `screen-contract`): what one screen of the web application must hold, read from the `expected` text of
 * the case itself and decided by measuring the screen in a real browser.
 *
 * The case texts are of two families. The standard one: "Không crash/tràn; mọi control có nhãn; không action ngoài quyền; dữ liệu/validation theo Module_Implementation_Contracts
 * và FRD; API binding phải được review trước chạy". The specific ones name the fields, the rule, the denied state and the 403, the design tokens, the seven states.
 * `clausesOf` splits a text into the clauses this module can decide and the ones it cannot (a business rule applied, a figure that is right); the second kind is returned
 * and recorded with every verdict, never counted as checked.
 *
 * Everything in this file is plain data and pure functions except `FACTS_OF_THE_SCREEN` (it runs inside the page), so the verdicts can be exercised by the negative controls
 * with no browser (screen-contract.test.ts) and with a deliberately broken page (screen-contract.spec.ts).
 */

/** What a clause of a case asks of the screen. */
export type Clause = 'render' | 'console' | 'overflow' | 'labels' | 'permission' | 'denied' | 'api' | 'problem' | 'fields' | 'order' | 'states' | 'tokens';

/** The clauses that every screen contract holds: the steps of every case open the route, look at the responsive layout and at the controls. */
export const BASE_CLAUSES: readonly Clause[] = ['render', 'console', 'overflow', 'labels'];

interface ClauseRule {
  /** The wording of the cases that asks for it (Vietnamese and English texts of the catalogue). */
  pattern: RegExp;
  clauses: readonly Clause[];
  /** The browser decides one side of the wording only (an error answer is a Problem; whether the screen words the business error is not decided): the part stays in the list of what is not decided. */
  partial?: true;
}

const RULES: readonly ClauseRule[] = [
  { pattern: /crash\/tràn|no crash|không lỗi console|không tràn ngang/i, clauses: ['render', 'console', 'overflow'] },
  { pattern: /mọi control có nhãn|every control has a label/i, clauses: ['labels'] },
  { pattern: /action ngoài quyền|hành động ngoài quyền|action outside the permission|no write in the read-only mode/i, clauses: ['permission'] },
  { pattern: /trạng thái denied|API trả 403/i, clauses: ['denied', 'problem'] },
  { pattern: /API binding/i, clauses: ['api'] },
  { pattern: /mã Problem|Problem\.code|correlation_id/i, clauses: ['problem'], partial: true },
  { pattern: /dữ liệu\/validation theo/i, clauses: [], partial: true },
  { pattern: /đúng thứ tự mockup/i, clauses: ['fields', 'order'] },
  { pattern: /đúng \d+ (?:nhóm )?trường|đúng các trường|all (?:\d+ |twelve |eleven )?fields shown|every labelled field is present|all sections shown/i, clauses: ['fields'] },
  { pattern: /7 trạng thái/i, clauses: ['states'] },
  { pattern: /token\/component theo mockup/i, clauses: ['tokens'] },
];

export interface ClausesOfCase {
  /** What the browser decides for the case, in a fixed order. */
  clauses: Clause[];
  /** The parts of the text that the measuring cannot decide (a rule applied, a number right): said out loud in every verdict. */
  unautomated: string[];
}

/** The parts of an `expected` text: the prefix before the first colon names the screen and is no clause; the rest splits at `;` and `,`, parentheses kept whole. */
export function segmentsOf(expected: string): string[] {
  const named = /^[^:]{0,80}: /.test(expected) && !/^(?:Không crash|Trường hiển thị|Every|All)/.test(expected);
  const text = named ? expected.replace(/^[^:]{0,80}: /, '') : expected;
  const segments: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && (char === ';' || char === ',')) {
      segments.push(current.trim());
      current = '';
    } else current += char;
  }
  segments.push(current.trim());
  return segments.filter((segment) => segment !== '');
}

/** The clauses of a case and what is left that the measuring cannot decide. The base clauses are always in: every case opens the route and looks at its layout and its controls. */
export function clausesOf(expected: string): ClausesOfCase {
  const wanted = new Set<Clause>(BASE_CLAUSES);
  const unautomated: string[] = [];
  for (const segment of segmentsOf(expected)) {
    const hits = RULES.filter((rule) => rule.pattern.test(segment));
    for (const hit of hits) for (const clause of hit.clauses) wanted.add(clause);
    if (hits.length === 0 || hits.some((hit) => hit.partial === true)) unautomated.push(segment);
  }
  const order: Clause[] = ['render', 'console', 'overflow', 'labels', 'permission', 'denied', 'api', 'problem', 'fields', 'order', 'states', 'tokens'];
  return { clauses: order.filter((clause) => wanted.has(clause)), unautomated };
}

// ---------------------------------------------------------------------------------------------------------------------
// What is measured
// ---------------------------------------------------------------------------------------------------------------------

/** One control of the screen that changes data when it is used, as the screen offers it to the person who looks at it. */
export interface WriteAction {
  tag: string;
  name: string;
  classes: string;
}

export interface TextBelowFloor {
  text: string;
  px: number;
}

/** What the page says about itself, measured inside the page. */
export interface ScreenFacts {
  /** Every `data-screen-id` of the page. */
  screenIds: string[];
  /** The page carries the "not implemented yet" stand-in of the registry. */
  notImplemented: boolean;
  /** The crash card of the error boundary is shown. */
  crashed: boolean;
  /** Something on the page says it is busy loading (`aria-busy="true"`): the skeleton of the loading state. */
  busy: boolean;
  breadcrumb: boolean;
  title: string;
  /** document scrollWidth minus innerWidth, never negative. */
  overflowPx: number;
  /** The state cards of the screen (empty, denied, error, expired...): their text. */
  stateCards: string[];
  /** Whether the screen is showing its data (no state card in the place of the content). */
  hasContent: boolean;
  /** The screen shows at least one record: a table row with data or a term of a description list. A list with no rows shows no column, so no field. */
  dataRows: boolean;
  /** The screen shows a form: a field outside the filter, the shell and the search. */
  formFields: boolean;
  writeActions: WriteAction[];
  /** The visible text of the screen part of the page, lower case, plus the labels, placeholders and titles of its controls. */
  screenText: string;
  tokens: { primaryDefined: boolean; bodyFont: string; textBelowFloor: TextBelowFloor[]; italicHeadings: string[] };
}

export interface ApiCall {
  method: string;
  path: string;
  status: number;
  /** For an answer with a status of 400 or more: whether the body is a Problem (type, title, status, code, correlation_id). */
  problem?: boolean;
  /** The beginning of the body of an answer that is no Problem, for the report. */
  body?: string;
  /** The answer is one that the product specifies for the person the screen is opened as (walk-plan `isExpectedAbsence`: a project with no estimate, the portal opened by a member who is no contractor). */
  expected?: boolean;
}

/** One opening of the screen: who opened it, how wide, and what the page did and said. */
export interface Observation {
  user: string;
  width: number;
  facts: ScreenFacts;
  /** The console errors that are not the browser noting an answer the product specifies. */
  consoleErrors: string[];
  pageErrors: string[];
  calls: ApiCall[];
  /** The axe rules that failed (rule id and the nodes), empty when none or when axe was not run for this opening. */
  axe: string[];
  loadError?: string;
}

export interface Finding {
  clause: Clause;
  detail: string;
}

/** The rules of the clause `labels`: the controls of the page have an accessible name (axe 4: names of buttons, links, inputs, selects; ARIA attributes and roles valid). */
export const AXE_RULES: readonly string[] = [
  'button-name',
  'link-name',
  'input-button-name',
  'label',
  'select-name',
  'image-alt',
  'aria-command-name',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-tooltip-name',
  'aria-treeitem-name',
  'aria-allowed-attr',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'aria-roles',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'aria-hidden-focus',
];

/** The size under which text is a defect of the design system ("No type below 12", design.md). */
export const MIN_TEXT_PX = 12;

// ---------------------------------------------------------------------------------------------------------------------
// The measuring inside the page
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Measures the screen. It runs inside the page (page.evaluate), so it is one self-contained function.
 *
 * A control "changes data" when it is enabled and visible, outside the shell (sidebar, top bar, navigation), outside a filter or a search form (they change what is shown, never the
 * data) and outside a state card (its retry button reloads), and it is a primary or a danger button of the design system (`ui-button--primary`, `ui-button--danger`, the plain
 * `primary` of the older screens), or a submit button, or names a change of data in its own words ("Thêm", "Lưu", "Gửi", "Duyệt", "Xóa"...; a bare "Hủy" is a cancel, not a void).
 * A link never counts: it navigates, whatever it is called and however it is drawn.
 */
export function factsInPage(minTextPx: number): ScreenFacts {
  const visible = (element: Element): boolean => {
    const box = (element as HTMLElement).getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const nameOf = (element: Element): string => (element.getAttribute('aria-label') ?? textOf(element)) || element.getAttribute('title') || '';
  const all = (scope: ParentNode, selector: string): Element[] => Array.prototype.slice.call(scope.querySelectorAll(selector)) as Element[];
  const root: Element = document.querySelector('[data-screen-id]') ?? document.querySelector('main') ?? document.body;
  const cards = all(document, '.statecard').filter(visible);
  const outsideShell = 'nav, [role="navigation"], [role="tablist"], .sidebar, .workspace-topbar, .topbar, [role="search"], .ui-filter, [role="dialog"], .statecard';
  const writeActions = all(root, 'button, a[href], input[type="submit"], [role="button"]')
    .filter((element) => visible(element) && !element.closest(outsideShell))
    .filter((element) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true')
    .filter((element) => {
      const classes = typeof element.className === 'string' ? element.className : '';
      const primary = element.tagName !== 'A' && /(?:^|\s)(?:ui-button--primary|ui-button--danger|primary)(?:\s|$)/.test(classes);
      const name = nameOf(element);
      // What only shows or narrows the data is no change of it, in whatever style it is drawn ("Xem", "Lọc", "Áp dụng", "Tất cả", "Xóa bộ lọc").
      if (/^(?:Xem|Lọc|Tìm|Tra cứu|Áp dụng|Tất cả|Mở|Quay lại|Tải lại|Làm mới|Hiển thị|Đặt lại|Xóa lọc|Xóa bộ lọc|Chọn|So sánh|In|Tải về|Tải xuống)(?=\s|$|[:,.])/.test(name)) return false;
      // A button that names a change of data in its own words: the same control in an outline style is no less a write.
      const verb = element.tagName !== 'A' && /^(?:\+\s*)?(?:Thêm|Tạo|Lập|Lưu|Gửi|Trình duyệt|Trình ký|Trình lên|Duyệt|Phê duyệt|Từ chối|Xóa|Hủy(?=\s+(?!bỏ)\S)|Sửa|Chỉnh sửa|Cập nhật|Ghi nhận|Ghi|Xác nhận|Phát hành|Thu hồi|Khóa|Mở lại|Gia hạn)(?=\s|$|[:,.])/.test(name);
      return primary || verb || element.matches('button[type="submit"], input[type="submit"]');
    })
    .map((element) => ({ tag: element.tagName.toLowerCase(), name: nameOf(element), classes: typeof element.className === 'string' ? element.className : '' }));

  const labelled = all(root, '[aria-label], [placeholder], [title], label, th, dt, legend, caption').map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('title') ?? ''} ${textOf(element)}`);
  const screenText = `${(root as HTMLElement).innerText ?? textOf(root)} ${labelled.join(' ')}`.replace(/\s+/g, ' ').toLowerCase();

  const small: TextBelowFloor[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null && small.length < 8; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || (node.textContent ?? '').trim() === '' || !visible(parent) || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
    const px = Number.parseFloat(getComputedStyle(parent).fontSize);
    if (px < minTextPx) small.push({ text: (node.textContent ?? '').trim().slice(0, 40), px });
  }
  const bodyStyle = getComputedStyle(document.body);
  return {
    screenIds: all(document, '[data-screen-id]').map((element) => element.getAttribute('data-screen-id') ?? ''),
    notImplemented: document.querySelector('[data-not-implemented]') !== null,
    crashed: document.querySelector('[data-state="crash"]') !== null,
    busy: document.querySelector('[aria-busy="true"]') !== null,
    breadcrumb: document.querySelector('.workspace-breadcrumb strong') !== null,
    title: textOf(root.querySelector('h1') ?? document.createElement('span')),
    overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    stateCards: cards.map(textOf),
    hasContent: cards.length === 0,
    dataRows: all(root, 'table tbody tr').some((row) => visible(row) && row.querySelectorAll('td').length >= 2) || all(root, 'dl dd').some(visible),
    formFields: all(root, 'input:not([type="hidden"]), select, textarea').some((field) => visible(field) && !field.closest('.ui-filter, [role="search"], nav, .sidebar, .workspace-topbar')),
    writeActions,
    screenText,
    tokens: {
      primaryDefined: getComputedStyle(document.documentElement).getPropertyValue('--mv-color-primary').trim() !== '',
      bodyFont: bodyStyle.fontFamily,
      textBelowFloor: small,
      italicHeadings: all(root, 'h1, h2, h3').filter((heading) => visible(heading) && getComputedStyle(heading).fontStyle === 'italic').map(textOf),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The contract of the API binding
// ---------------------------------------------------------------------------------------------------------------------

/** The operations of the OpenAPI contract as `METHOD /path/{param}` patterns. */
export function operationMatchers(openapi: { paths: Record<string, Record<string, unknown>> }): Array<{ method: string; pattern: RegExp }> {
  const matchers: Array<{ method: string; pattern: RegExp }> = [];
  for (const [path, operations] of Object.entries(openapi.paths)) {
    const source = path
      .split(/(\{[^}]+\})/)
      .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    const pattern = new RegExp(`^${source}$`);
    for (const method of Object.keys(operations)) if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) matchers.push({ method: method.toUpperCase(), pattern });
  }
  return matchers;
}

/** The requests that no operation of the contract serves. */
export function unboundCalls(calls: readonly ApiCall[], matchers: ReadonlyArray<{ method: string; pattern: RegExp }>): string[] {
  return [...new Set(calls.filter((call) => !matchers.some((matcher) => matcher.method === call.method && matcher.pattern.test(call.path))).map((call) => `${call.method} ${call.path}`))];
}

// ---------------------------------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------------------------------

/** Folds the case of a word and its marks, so "Đơn vị" and "đơn vi" are one word: the catalogue and the screens do not agree on the marks of capital letters. */
export const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * How a field of the catalogue is told on a screen. The catalogue names fields by description ("Hướng (vào, ra, hai chiều)", "Mã và tên bộ kết nối"), the screen by its label: the
 * name without the explanation in brackets stands for the field, and for the name of two things ("Mã và tên bộ kết nối") each of the two does. A name is a whole word or words of the
 * folded text, never a part of another word.
 */
export function aliasesOf(field: string): { whole: string; parts: string[] } {
  const whole = fold(field.replace(/\([^)]*\)/g, ''));
  const parts = whole.split(/ va |, /).map((part) => part.trim()).filter((part) => part.length >= 2);
  return { whole, parts: parts.length > 1 ? parts : [] };
}

const wordAt = (text: string, phrase: string): number => {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).exec(text);
  return found === null ? -1 : found.index;
};

/** Where on the screen text the field stands (the first place), or -1 when it is not there. */
function positionOf(field: string, text: string): number {
  const { whole, parts } = aliasesOf(field);
  const at = whole === '' ? -1 : wordAt(text, whole);
  if (at >= 0 || parts.length === 0) return at;
  const places = parts.map((part) => wordAt(text, part));
  return places.every((place) => place >= 0) ? Math.min(...places) : -1;
}

/** Which of the fields of the catalogue the screen text does not hold. */
export function missingFields(fields: readonly string[], screenText: string): string[] {
  const text = fold(screenText);
  return fields.filter((field) => positionOf(field, text) < 0);
}

/** For the clause `order`: the fields found that stand before a field that the catalogue lists earlier. */
export function fieldsOutOfOrder(fields: readonly string[], screenText: string): string[] {
  const text = fold(screenText);
  const wrong: string[] = [];
  let last = -1;
  for (const field of fields) {
    const at = positionOf(field, text);
    if (at < 0) continue;
    if (at < last) wrong.push(field);
    else last = at;
  }
  return wrong;
}

export interface ContractInput {
  screen: string;
  clauses: readonly Clause[];
  /** The fields, the kind and the audience of the screen in the catalogue (`screen_catalog.json`). */
  fields: readonly string[];
  kind: string;
  role: string;
  /** The text the denied state of the screen carries (`states.denied.title`). */
  deniedTitle: string;
  /** The opening as the person the route walk uses, at the wide viewport. */
  wide: Observation;
  /** The same person at the phone width. */
  narrow: Observation;
  /** The person who only reads. Absent when the clause `permission` is not asked for. */
  reader?: Observation;
  /** A member with no right. Absent when the clause `denied` is not asked for. */
  denied?: Observation;
  /** The states of the screen besides its data, each forced on the screen itself by what the API answers (clause `states`). */
  states?: Array<{ state: string; observation: Observation }>;
  /** The title of the card of each state (`states.<state>.title`), by the name of the state. */
  stateTitles?: Readonly<Record<string, string>>;
  matchers: ReadonlyArray<{ method: string; pattern: RegExp }>;
}

const SHELL_CALLS: readonly RegExp[] = [/^\/home\/my-work\/counts$/];
const isShellCall = (call: ApiCall): boolean => SHELL_CALLS.some((pattern) => pattern.test(call.path));

/** Whether the screen shows a refusal for a person without the right: its own denied card or a notice that names the missing right. */
export function showsDenied(facts: ScreenFacts, deniedTitle: string): boolean {
  const refusal = /không có quyền|chưa có quyền|không được xem|not allowed|no permission/i;
  return facts.stateCards.some((card) => fold(card).includes(fold(deniedTitle))) || refusal.test(facts.screenText);
}

/** A screen that the catalogue gives to every user ("Tất cả người dùng", "Mọi người dùng đã đăng nhập", "mọi membership"): what it offers is within the right of whoever opens it, so no action is outside the permission. */
export function isOpenToEveryone(role: string): boolean {
  return /^(?:Tất cả|Mọi)\s|\(mọi membership\)/i.test(role.trim());
}

/** The kinds of screen of the catalogue whose fields are the fields of a form (the others show theirs as the columns and terms of the records). */
export const FORM_KINDS: ReadonlySet<string> = new Set(['form', 'auth', 'policy', 'editor', 'builder', 'import', 'confirm', 'approval', 'review', 'criteria', 'workflow']);

/** The fields are told only where the screen shows what carries them: the rows or terms of a record, or, for a screen of a form, its fields. An empty list, a denied or an error card shows no column and no label, and that says nothing about the fields. */
export function fieldsAreDecidable(facts: ScreenFacts, kind: string): boolean {
  return facts.hasContent && (facts.dataRows || (FORM_KINDS.has(kind) && facts.formFields));
}

/** The clauses the case asks for that the measure of this run could not decide (said in the verdict, never counted as held). */
export function undecidedOf(input: ContractInput): string[] {
  const undecided: string[] = [];
  const wanted = new Set(input.clauses);
  if (wanted.has('permission') && isOpenToEveryone(input.role)) undecided.push(`permission: the catalogue gives the screen to "${input.role}", so no persona lacks the right to what it offers`);
  if ((wanted.has('fields') || wanted.has('order')) && !fieldsAreDecidable(input.wide.facts, input.kind)) {
    undecided.push(input.wide.facts.hasContent ? `fields: the screen (a ${input.kind}) shows no record and no form on the data of the seeded stack, so it shows no field` : 'fields: the screen shows a state card on the data of the seeded stack, so it shows no field');
  }
  return undecided;
}

/**
 * Decides the clauses of one case from what was measured. Every finding names the clause it breaks; an empty list is a pass for every clause the case asks for.
 * A clause that is not asked for is not decided (its measure may be absent).
 */
export function judgeScreen(input: ContractInput): Finding[] {
  const wanted = new Set(input.clauses);
  const findings: Finding[] = [];
  const { wide, narrow } = input;

  if (wanted.has('render')) {
    findings.push(...(wide.loadError === undefined ? [] : [{ clause: 'render' as const, detail: `the screen did not load (${wide.loadError})` }]));
    if (!wide.facts.screenIds.includes(input.screen)) findings.push({ clause: 'render', detail: `the page does not carry data-screen-id="${input.screen}" (found: ${wide.facts.screenIds.join(', ') || 'none'})` });
    if (wide.facts.notImplemented) findings.push({ clause: 'render', detail: 'the page is the "not implemented yet" stand-in of the registry' });
    if (wide.facts.crashed) findings.push({ clause: 'render', detail: 'the page shows the crash card of the error boundary' });
    if (!wide.facts.breadcrumb) findings.push({ clause: 'render', detail: 'the shell has no breadcrumb' });
    if (wide.facts.title === '') findings.push({ clause: 'render', detail: 'the screen has no heading (h1)' });
    if (narrow.loadError !== undefined) findings.push({ clause: 'render', detail: `the screen did not load at ${narrow.width} px (${narrow.loadError})` });
    if (narrow.facts.crashed) findings.push({ clause: 'render', detail: `the page shows the crash card at ${narrow.width} px` });
  }
  if (wanted.has('console')) {
    for (const observation of [wide, narrow]) {
      for (const error of observation.pageErrors) findings.push({ clause: 'console', detail: `${observation.width} px: uncaught error: ${error}` });
      for (const error of observation.consoleErrors) findings.push({ clause: 'console', detail: `${observation.width} px: console error: ${error}` });
    }
  }
  if (wanted.has('overflow')) {
    for (const observation of [wide, narrow]) {
      if (observation.facts.overflowPx > 0) findings.push({ clause: 'overflow', detail: `the page scrolls sideways by ${observation.facts.overflowPx} px at ${observation.width} px` });
    }
  }
  if (wanted.has('labels')) {
    for (const violation of wide.axe) findings.push({ clause: 'labels', detail: `axe ${violation}` });
  }
  if (wanted.has('permission') && input.reader !== undefined && !isOpenToEveryone(input.role)) {
    const { reader } = input;
    if (reader.loadError !== undefined) findings.push({ clause: 'permission', detail: `the screen did not load for the person who only reads (${reader.loadError})` });
    // A screen that crashed, or never rendered, under the rights of the reader offers no write because it offers nothing: that is no evidence of a screen without a write.
    if (reader.facts.crashed) findings.push({ clause: 'permission', detail: 'the screen crashes for the person who only reads' });
    if (reader.loadError === undefined && !reader.facts.screenIds.includes(input.screen)) findings.push({ clause: 'permission', detail: `the person who only reads does not see the screen ${input.screen} (found: ${reader.facts.screenIds.join(', ') || 'none'})` });
    for (const error of reader.pageErrors) findings.push({ clause: 'permission', detail: `uncaught error for the person who only reads: ${error}` });
    for (const action of reader.facts.writeActions) findings.push({ clause: 'permission', detail: `a person who may only read is offered "${action.name}" (${action.tag}.${action.classes.trim().replace(/\s+/g, '.')})` });
  }
  if (wanted.has('denied') && input.denied !== undefined) {
    const { denied } = input;
    const refused = denied.calls.filter((call) => call.status === 403 && !isShellCall(call));
    if (refused.length > 0 && !showsDenied(denied.facts, input.deniedTitle)) findings.push({ clause: 'denied', detail: `the API answered 403 to a member without the right (${refused.map((call) => `${call.method} ${call.path}`).join(', ')}) and the screen shows no denied state` });
    if (denied.facts.crashed) findings.push({ clause: 'denied', detail: 'the screen crashes for a member without the right' });
    if (denied.loadError !== undefined) findings.push({ clause: 'denied', detail: `the screen did not load for a member without the right (${denied.loadError})` });
    findings.push(...denied.pageErrors.map((error) => ({ clause: 'denied' as const, detail: `uncaught error for a member without the right: ${error}` })));
  }
  if (wanted.has('problem')) {
    const answers = [...(input.denied?.calls ?? []), ...wide.calls];
    const notProblem = answers.filter((call) => call.status >= 400 && call.problem === false);
    for (const call of notProblem) findings.push({ clause: 'problem', detail: `${call.method} ${call.path} answered ${call.status} with a body that is not a Problem (type, title, status, code, correlation_id): ${call.body ?? ''}` });
  }
  if (wanted.has('api')) {
    const calls = [...wide.calls, ...narrow.calls];
    for (const call of unboundCalls(calls, input.matchers)) findings.push({ clause: 'api', detail: `the screen calls ${call}, which no operation of the contract serves` });
    for (const call of wide.calls.filter((entry) => entry.status >= 500)) findings.push({ clause: 'api', detail: `${call.method} ${call.path} answered ${call.status}` });
    for (const call of wide.calls.filter((entry) => entry.status >= 400 && entry.status < 500 && !isShellCall(entry) && entry.expected !== true)) {
      findings.push({ clause: 'api', detail: `${call.method} ${call.path} answered ${call.status} to the person the screen is walked with` });
    }
  }
  if ((wanted.has('fields') || wanted.has('order')) && fieldsAreDecidable(wide.facts, input.kind) && input.fields.length > 0) {
    if (wanted.has('fields')) {
      const missing = missingFields(input.fields, wide.facts.screenText);
      if (missing.length > 0) findings.push({ clause: 'fields', detail: `fields of the catalogue not on the screen: ${missing.join(', ')}` });
    }
    if (wanted.has('order')) {
      const wrong = fieldsOutOfOrder(input.fields, wide.facts.screenText);
      if (wrong.length > 0) findings.push({ clause: 'order', detail: `fields out of the order of the catalogue: ${wrong.join(', ')}` });
    }
  }
  if (wanted.has('states') && input.states !== undefined) {
    for (const { state, observation } of input.states) {
      if (observation.facts.crashed) findings.push({ clause: 'states', detail: `state ${state}: the page crashes` });
      if (observation.facts.overflowPx > 0) findings.push({ clause: 'states', detail: `state ${state}: the page scrolls sideways by ${observation.facts.overflowPx} px at ${observation.width} px` });
      for (const error of observation.pageErrors) findings.push({ clause: 'states', detail: `state ${state}: uncaught error: ${error}` });
      if (observation.loadError !== undefined) findings.push({ clause: 'states', detail: `state ${state}: the page did not load (${observation.loadError})` });
      if (state === 'loading') {
        if (!observation.facts.busy) findings.push({ clause: 'states', detail: 'state loading: nothing on the screen says it is loading while the data is awaited' });
        continue;
      }
      const title = input.stateTitles?.[state] ?? '';
      if (title !== '' && !observation.facts.stateCards.some((card) => fold(card).includes(fold(title)))) {
        findings.push({ clause: 'states', detail: `state ${state}: no state card titled "${title}" is shown (cards: ${observation.facts.stateCards.join(' | ') || 'none'})` });
      }
    }
  }
  if (wanted.has('tokens')) {
    const { tokens } = wide.facts;
    if (!tokens.primaryDefined) findings.push({ clause: 'tokens', detail: 'the token --mv-color-primary is not defined on the page' });
    if (!/Be Vietnam Pro/i.test(tokens.bodyFont)) findings.push({ clause: 'tokens', detail: `the body font is not Be Vietnam Pro (${tokens.bodyFont})` });
    for (const small of tokens.textBelowFloor) findings.push({ clause: 'tokens', detail: `text under ${MIN_TEXT_PX} px: "${small.text}" at ${small.px} px` });
    for (const heading of tokens.italicHeadings) findings.push({ clause: 'tokens', detail: `italic heading: "${heading}"` });
  }
  return findings;
}
