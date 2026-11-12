import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_CLAUSES, MIN_TEXT_PX, aliasesOf, clausesOf, isOpenToEveryone, undecidedOf, fieldsOutOfOrder, fold, judgeScreen, missingFields, operationMatchers, segmentsOf, showsDenied, unboundCalls } from './screen-contract.ts';
import type { ApiCall, Clause, ContractInput, Observation, ScreenFacts } from './screen-contract.ts';
import { PERSONAL_PERMISSIONS, READER_KEY, readerPermissions, withReaderPersona } from './screen-personas.ts';

const STANDARD = 'Không crash/tràn; mọi control có nhãn; không action ngoài quyền; dữ liệu/validation theo Module_Implementation_Contracts và FRD; API binding phải được review trước chạy';
const DENIED = 'Trường hiển thị đúng thứ tự mockup; người thiếu quyền thấy trạng thái denied và API trả 403; lỗi hiển thị theo Problem.code (DOA_MATRIX_INVALID (GAP/OVERLAP), SELF_APPROVAL_DENIED) với correlation_id; không mất dữ liệu nhập khi 409';
const FIELDS = 'Hồ sơ tài sản: hiển thị đúng 7 trường; áp quy tắc "Tổng giá trị tài sản không vượt giá trị hợp đồng; mã ngoài nhập tay (adapter MISSING)"; không action ngoài quyền; token/component theo mockup (D-B11); lỗi nghiệp vụ hiển thị mã Problem ổn định';
const HUB = 'Kết nối: hiển thị đúng 5 trường, áp quy tắc "khóa nhập tay", 7 trạng thái hiển thị đúng, không lỗi console, không tràn ngang ở 390 px';
const ENGLISH = 'trạng thái, chạy thử và nhập tệp: all 6 fields shown, the rule applied, the PENDING-EXTERNAL band visible, no action outside the permission';

const facts = (over: Partial<ScreenFacts> = {}): ScreenFacts => ({
  screenIds: ['ADM-01'],
  notImplemented: false,
  crashed: false,
  breadcrumb: true,
  title: 'Cây tổ chức',
  overflowPx: 0,
  stateCards: [],
  hasContent: true,
  dataRows: true,
  formFields: false,
  writeActions: [],
  screenText: 'đơn vị cấp cha ngày hiệu lực đơn vị kế thừa',
  tokens: { primaryDefined: true, bodyFont: '"Be Vietnam Pro", sans-serif', textBelowFloor: [], italicHeadings: [] },
  ...over,
});

const observation = (over: Partial<Observation> = {}, factOver: Partial<ScreenFacts> = {}): Observation => ({ user: 'owner', width: 1440, facts: facts(factOver), consoleErrors: [], pageErrors: [], calls: [], axe: [], ...over });

const MATCHERS = operationMatchers({ paths: { '/resources/organization_unit': { get: {}, post: {} }, '/resources/organization_unit/{id}': { get: {} }, '/home/my-work/counts': { get: {} } } });

const input = (clauses: Clause[], over: Partial<ContractInput> = {}): ContractInput => ({
  screen: 'ADM-01',
  clauses,
  fields: ['Đơn vị', 'Cấp cha', 'Ngày hiệu lực', 'Đơn vị kế thừa'],
  kind: 'table',
  role: 'Chuyên viên dữ liệu',
  deniedTitle: 'Bạn chưa có quyền truy cập',
  wide: observation(),
  narrow: observation({ width: 390 }),
  matchers: MATCHERS,
  ...over,
});

const ALL: Clause[] = ['render', 'console', 'overflow', 'labels', 'permission', 'denied', 'api', 'problem', 'fields', 'order', 'states', 'tokens'];
const clausesFound = (findings: Array<{ clause: Clause }>): Clause[] => [...new Set(findings.map((finding) => finding.clause))];

test('the standard text asks for the base clauses, the permission and the API binding, and says what it cannot decide', () => {
  const parsed = clausesOf(STANDARD);
  assert.deepEqual(parsed.clauses, ['render', 'console', 'overflow', 'labels', 'permission', 'api']);
  assert.deepEqual(parsed.unautomated, ['dữ liệu/validation theo Module_Implementation_Contracts và FRD']);
});

test('the denied text asks for the denied state, the Problem, the fields and their order', () => {
  const parsed = clausesOf(DENIED);
  assert.deepEqual(parsed.clauses, ['render', 'console', 'overflow', 'labels', 'denied', 'problem', 'fields', 'order']);
  assert.ok(parsed.unautomated.some((part) => part.includes('Problem.code')), 'the display of a business error is not decided');
  assert.ok(parsed.unautomated.includes('không mất dữ liệu nhập khi 409'));
});

test('a text that names the fields, the rule and the tokens asks for the fields and the tokens; the rule applied stays undecided', () => {
  const parsed = clausesOf(FIELDS);
  assert.ok(parsed.clauses.includes('fields') && parsed.clauses.includes('tokens') && parsed.clauses.includes('permission'));
  assert.ok(parsed.unautomated.some((part) => part.startsWith('áp quy tắc "Tổng giá trị tài sản')), 'a semicolon inside quotes does not split the rule');
  assert.ok(parsed.unautomated.some((part) => part.includes('Problem')));
});

test('the states text and the English texts are read', () => {
  assert.ok(clausesOf(HUB).clauses.includes('states'));
  const english = clausesOf(ENGLISH);
  assert.ok(english.clauses.includes('fields') && english.clauses.includes('permission'));
  assert.deepEqual(english.unautomated, ['the rule applied', 'the PENDING-EXTERNAL band visible']);
});

test('every case holds the base clauses, even a text that names none of them', () => {
  assert.deepEqual(clausesOf('DIR-06 hiển thị đúng quyền, trạng thái và theo mockup; không có dữ liệu ngoài phạm vi').clauses.slice(0, BASE_CLAUSES.length), [...BASE_CLAUSES]);
});

test('a text splits at ; and , outside parentheses and quotes, and loses the name of the screen before the colon', () => {
  assert.deepEqual(segmentsOf('Danh sách: a (b, c); d, "e; f"'), ['a (b, c)', 'd', '"e; f"']);
  assert.deepEqual(segmentsOf('Không crash/tràn; mọi control có nhãn'), ['Không crash/tràn', 'mọi control có nhãn']);
});

test('the fields are found with or without marks and capitals, and a field that is not there is named', () => {
  assert.equal(fold('Đơn Vị  KẾ thừa'), 'don vi ke thua');
  assert.deepEqual(missingFields(['Đơn vị', 'Cấp cha', 'Ghi chú'], 'DON VI ... cấp cha'), ['Ghi chú']);
  assert.deepEqual(fieldsOutOfOrder(['A', 'B', 'C'], 'a c b'), ['C']);
  assert.deepEqual(fieldsOutOfOrder(['A', 'B', 'C'], 'a b c'), []);
});

test('a field is told by its name without the explanation in brackets, or by each of the two things it names', () => {
  assert.deepEqual(aliasesOf('Hướng (vào, ra, hai chiều)'), { whole: 'huong', parts: [] });
  assert.deepEqual(aliasesOf('Mã và tên bộ kết nối'), { whole: 'ma va ten bo ket noi', parts: ['ma', 'ten bo ket noi'] });
  assert.deepEqual(missingFields(['Hướng (vào, ra, hai chiều)', 'Mã và tên bộ kết nối', 'Trạng thái'], 'Hướng kết nối: vào. Mã hiệu; Tên bộ kết nối. trạng thái'), []);
  assert.deepEqual(missingFields(['Mã và tên bộ kết nối'], 'Mã hiệu của bộ'), ['Mã và tên bộ kết nối'], 'one of the two things is not enough');
  assert.deepEqual(missingFields(['Đơn'], 'đơn vị'), [], 'a word of the text');
  assert.deepEqual(missingFields(['Đơ'], 'đơn vị'), ['Đơ'], 'never a part of another word');
});

test('a path of the contract binds the calls that match its pattern and its method, and names the others', () => {
  const calls: ApiCall[] = [
    { method: 'GET', path: '/resources/organization_unit', status: 200 },
    { method: 'GET', path: '/resources/organization_unit/00000000-0000-4000-8000-000000000001', status: 200 },
    { method: 'DELETE', path: '/resources/organization_unit', status: 200 },
    { method: 'GET', path: '/nowhere', status: 200 },
  ];
  assert.deepEqual(unboundCalls(calls, MATCHERS), ['DELETE /resources/organization_unit', 'GET /nowhere']);
});

test('a page that keeps the contract has no finding for any clause', () => {
  const owner = observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 200 }] });
  const denied = observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 403, problem: true }], user: 'nobody' }, { stateCards: ['Bạn chưa có quyền truy cậpLiên hệ quản trị'], hasContent: false });
  const states = ['loading', 'empty', 'error', 'denied', 'expired', 'offline'].map((state) => ({ state, observation: observation({ width: 390 }, { stateCards: state === 'loading' ? [] : ['thẻ'] }) }));
  assert.deepEqual(judgeScreen(input(ALL, { wide: owner, reader: observation(), denied, states })), []);
});

// Negative controls of the verdict: each mutation of the measure breaks one clause, and only the clauses that the case asks for are decided.
const MUTATIONS: Array<{ name: string; clause: Clause; build: () => ContractInput; detail: string }> = [
  { name: 'the page does not carry its screen id', clause: 'render', build: () => input(['render'], { wide: observation({}, { screenIds: ['ADM-02'] }) }), detail: 'data-screen-id="ADM-01"' },
  { name: 'the page is the stand-in of the registry', clause: 'render', build: () => input(['render'], { wide: observation({}, { notImplemented: true }) }), detail: 'not implemented' },
  { name: 'the page shows the crash card', clause: 'render', build: () => input(['render'], { narrow: observation({ width: 390 }, { crashed: true }) }), detail: 'crash card at 390' },
  { name: 'the page did not load', clause: 'render', build: () => input(['render'], { wide: observation({ loadError: 'Timeout 15000ms exceeded.' }) }), detail: 'Timeout 15000ms' },
  { name: 'the shell has no breadcrumb', clause: 'render', build: () => input(['render'], { wide: observation({}, { breadcrumb: false }) }), detail: 'breadcrumb' },
  { name: 'the screen has no heading', clause: 'render', build: () => input(['render'], { wide: observation({}, { title: '' }) }), detail: 'heading' },
  { name: 'an uncaught error', clause: 'console', build: () => input(['console'], { narrow: observation({ width: 390, pageErrors: ['x is not defined'] }) }), detail: 'x is not defined' },
  { name: 'a console error', clause: 'console', build: () => input(['console'], { wide: observation({ consoleErrors: ['Failed to load resource: 500'] }) }), detail: 'Failed to load resource' },
  { name: 'the page scrolls sideways at the phone width', clause: 'overflow', build: () => input(['overflow'], { narrow: observation({ width: 390 }, { overflowPx: 7 }) }), detail: 'sideways by 7 px at 390' },
  { name: 'a button has no name', clause: 'labels', build: () => input(['labels'], { wide: observation({ axe: ['button-name (critical): 1 node(s), button.x'] }) }), detail: 'button-name' },
  { name: 'a person who only reads is offered a write', clause: 'permission', build: () => input(['permission'], { reader: observation({}, { writeActions: [{ tag: 'button', name: 'Lưu', classes: 'ui-button ui-button--primary' }] }) }), detail: 'is offered "Lưu"' },
  { name: 'the API refuses and the screen shows no denied state', clause: 'denied', build: () => input(['denied'], { denied: observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 403, problem: true }] }) }), detail: 'shows no denied state' },
  { name: 'the screen crashes for a member without the right', clause: 'denied', build: () => input(['denied'], { denied: observation({}, { crashed: true }) }), detail: 'crashes' },
  { name: 'an error answer is no Problem', clause: 'problem', build: () => input(['problem'], { wide: observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 500, problem: false }] }) }), detail: 'not a Problem' },
  { name: 'a call that no operation serves', clause: 'api', build: () => input(['api'], { wide: observation({ calls: [{ method: 'GET', path: '/nowhere', status: 200 }] }) }), detail: 'GET /nowhere' },
  { name: 'a call that answers 500', clause: 'api', build: () => input(['api'], { wide: observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 500 }] }) }), detail: 'answered 500' },
  { name: 'a call refused to the person the screen is walked with', clause: 'api', build: () => input(['api'], { wide: observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 403 }] }) }), detail: 'answered 403' },
  { name: 'a field of the catalogue is not on the screen', clause: 'fields', build: () => input(['fields'], { wide: observation({}, { screenText: 'đơn vị cấp cha' }) }), detail: 'Ngày hiệu lực' },
  { name: 'the fields are out of order', clause: 'order', build: () => input(['order'], { wide: observation({}, { screenText: 'cấp cha đơn vị ngày hiệu lực đơn vị kế thừa' }) }), detail: 'out of the order' },
  { name: 'a state shows no card', clause: 'states', build: () => input(['states'], { states: [{ state: 'empty', observation: observation({ width: 390 }, { stateCards: [] }) }] }), detail: 'state empty: no state card' },
  { name: 'the tokens are missing', clause: 'tokens', build: () => input(['tokens'], { wide: observation({}, { tokens: { primaryDefined: false, bodyFont: 'Arial', textBelowFloor: [{ text: 'nhỏ', px: 10 }], italicHeadings: ['Chữ nghiêng'] } }) }), detail: `under ${MIN_TEXT_PX} px` },
];

for (const mutation of MUTATIONS) {
  test(`negative control: ${mutation.name} turns the clause ${mutation.clause} red`, () => {
    const findings = judgeScreen(mutation.build());
    assert.ok(clausesFound(findings).includes(mutation.clause), JSON.stringify(findings));
    assert.ok(findings.some((finding) => finding.detail.includes(mutation.detail)), `${mutation.detail} not in ${JSON.stringify(findings)}`);
  });
}

test('negative control: a clause the case does not ask for is not decided, and a call the product specifies is not a defect', () => {
  assert.deepEqual(judgeScreen(input(['render'], { wide: observation({ consoleErrors: ['boom'] }, {}) })), []);
  const specified = observation({ calls: [{ method: 'GET', path: '/resources/organization_unit', status: 404, expected: true }] });
  assert.deepEqual(judgeScreen(input(['api'], { wide: specified })), []);
  const shell = observation({ calls: [{ method: 'GET', path: '/home/my-work/counts', status: 403 }], user: 'nobody' }, { hasContent: false });
  assert.deepEqual(judgeScreen(input(['denied'], { denied: shell })), []);
});

test('the fields are decided only where the screen shows a record or a form, and the verdict says when they were not', () => {
  const card = input(['fields'], { wide: observation({}, { screenText: '', hasContent: false, stateCards: ['Chưa có dữ liệu'] }) });
  assert.deepEqual(judgeScreen(card), []);
  assert.match(undecidedOf(card)[0] ?? '', /state card/);
  const empty = input(['fields', 'order'], { wide: observation({}, { screenText: 'chưa có bản ghi', dataRows: false, formFields: true }) });
  assert.deepEqual(judgeScreen(empty), [], 'a list with a filter form but no row shows no column');
  assert.match(undecidedOf(empty)[0] ?? '', /a table\) shows no record and no form/);
  const form = input(['fields'], { kind: 'form', fields: ['Mã'], wide: observation({}, { screenText: 'tên', dataRows: false, formFields: true }) });
  assert.match(judgeScreen(form)[0]?.detail ?? '', /Mã/, 'a form screen shows its fields without records');
  assert.deepEqual(undecidedOf(input(['fields'])), []);
  assert.deepEqual(undecidedOf(input(['render'], { wide: observation({}, { dataRows: false }) })), [], 'a clause that is not asked for is not undecided');
});

test('a screen the catalogue gives to every user has no action outside the permission, and the verdict says it was not measured', () => {
  assert.equal(isOpenToEveryone('Tất cả người dùng (nhân sự, khách nhà thầu)'), true);
  assert.equal(isOpenToEveryone('Mọi người dùng đã đăng nhập'), true);
  assert.equal(isOpenToEveryone('Người nhận thông báo (mọi membership)'), true);
  assert.equal(isOpenToEveryone('Tất cả cán bộ quản trị'), true);
  assert.equal(isOpenToEveryone('Quản trị tích hợp (hpm.admin)'), false);
  const everyone = input(['permission'], { role: 'Tất cả người dùng', reader: observation({}, { writeActions: [{ tag: 'button', name: 'Lưu thay đổi', classes: 'primary' }] }) });
  assert.deepEqual(judgeScreen(everyone), []);
  assert.match(undecidedOf(everyone)[0] ?? '', /^permission: the catalogue gives the screen to "Tất cả người dùng"/);
});

test('the denied state is the card of the screen or a notice that names the missing right', () => {
  assert.equal(showsDenied(facts({ stateCards: ['⌁Bạn chưa có quyền truy cậpLiên hệ quản trị'] }), 'Bạn chưa có quyền truy cập'), true);
  assert.equal(showsDenied(facts({ screenText: 'bạn không có quyền xem từ điển chỉ tiêu.' }), 'Bạn chưa có quyền truy cập'), true);
  assert.equal(showsDenied(facts({ screenText: 'chưa có dữ liệu' }), 'Bạn chưa có quyền truy cập'), false);
});

test('the reader persona holds the rights to read and the personal ones, and no right to change anything', () => {
  const openapi = JSON.stringify({
    paths: {
      '/a': { get: { 'x-permission': 'capital.read' }, post: { 'x-permission': 'capital.plan.draft' } },
      '/b': { get: { 'x-permission': 'report.export' }, put: { 'x-permission': 'project.update' } },
      '/c': { get: { 'x-permission': 'project.read' } },
      '/d': { put: { 'x-permission': 'notification.self' } },
    },
  });
  assert.deepEqual(readerPermissions(openapi), ['capital.read', ...PERSONAL_PERMISSIONS, 'notification.self', 'project.read'].sort());
  const real = readerPermissions();
  assert.ok(real.includes('capital.read') && real.includes('session.self'));
  assert.ok(real.every((right) => right.endsWith('.read') || right.endsWith('.self') || PERSONAL_PERMISSIONS.includes(right)), 'only reading rights and personal ones');
  assert.ok(!real.some((right) => /.(manage|approve|create|update|submit)$/.test(right)), 'no right to change');
});

test('the reader persona is added to the fixture users with the membership of the owner, and the owner is required', () => {
  const users = [{ key: 'owner', displayName: 'A', membershipId: 'm-1' }, { key: 'x', displayName: 'B', membershipId: 'm-2' }];
  const withReader = withReaderPersona(users, ['capital.read']);
  assert.equal(withReader.length, 3);
  assert.deepEqual(withReader[2], { key: READER_KEY, displayName: 'Người chỉ xem', membershipId: 'm-1', permissions: ['capital.read'] });
  assert.throws(() => withReaderPersona([{ key: 'x', displayName: 'B', membershipId: 'm-2' }]), /owner/);
});
