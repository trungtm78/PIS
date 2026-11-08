import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiReader, sessionToken } from './clip-seed-client.mjs';
import { DATASETS, DATASET_GROUPS, DATASET_PHASES, FUNDED, WORKFLOW_CLOCKS, phasesFor, buildPlan, checkPlan, createRng, judge, judgeAll, parseArgs, planDigest, streamSeed } from './clip-seed-lib.mjs';
import { verifyChecks } from './clip-seed-verify.mjs';
import { loadDataset, main, setClock } from './clip-seed.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const enterpriseDataset = () => JSON.parse(readFileSync(join(HERE, 'fixtures', 'clip-data', 'enterprise.json'), 'utf8'));
const publicDataset = () => JSON.parse(readFileSync(join(HERE, 'fixtures', 'clip-data', 'public.json'), 'utf8'));

test('the generator gives the same sequence for the same seed and another one for another seed', () => {
  const first = createRng(7);
  const again = createRng(7);
  const other = createRng(8);
  const a = [first.next(), first.next(), first.next()];
  assert.deepEqual(a, [again.next(), again.next(), again.next()]);
  assert.notDeepEqual(a, [other.next(), other.next(), other.next()]);
  assert.ok(a.every((value) => value >= 0 && value < 1));
});

test('integers stay inside their bounds and a shuffle keeps every item', () => {
  const rng = createRng(11);
  for (let index = 0; index < 500; index += 1) {
    const value = rng.int(3, 9);
    assert.ok(value >= 3 && value <= 9);
  }
  assert.deepEqual([...rng.shuffle([1, 2, 3, 4, 5, 6])].sort(), [1, 2, 3, 4, 5, 6]);
});

test('named streams of one seed are independent', () => {
  assert.equal(streamSeed(1, 'portfolio'), streamSeed(1, 'portfolio'));
  assert.notEqual(streamSeed(1, 'portfolio'), streamSeed(1, 'contractors'));
  assert.notEqual(streamSeed(1, 'portfolio'), streamSeed(2, 'portfolio'));
});

test('a dataset gives the same plan every time (same digest) and another plan for another seed', () => {
  const dataset = publicDataset();
  assert.equal(planDigest(buildPlan(dataset)), planDigest(buildPlan(dataset)));
  assert.notEqual(planDigest(buildPlan(dataset)), planDigest(buildPlan({ ...dataset, seed: dataset.seed + 1 })));
});

test('the public plan grows the portfolio past forty projects over all eight sectors and every stage of the mix', () => {
  const dataset = publicDataset();
  const plan = buildPlan(dataset);
  assert.ok(plan.expect.projectsTotal >= 40);
  assert.equal(plan.projects.length, dataset.extraProjects);
  assert.equal(new Set(plan.projects.map((project) => project.sector)).size, 8);
  for (const [stage, count] of Object.entries(dataset.stageMix)) assert.equal(plan.projects.filter((project) => project.target === stage).length, count);
});

test('codes, names and national codes are unique and never clash with the projects of the guide', () => {
  const dataset = publicDataset();
  const plan = buildPlan(dataset);
  const codes = plan.projects.map((project) => project.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.ok(!dataset.reservedProjectCodes.includes(code), code);
  const names = plan.projects.map((project) => project.name);
  assert.equal(new Set(names).size, names.length);
  const nationals = plan.projects.filter((project) => project.national !== undefined).map((project) => project.national);
  assert.equal(new Set(nationals).size, nationals.length);
  for (const national of nationals) assert.match(national, /^\d{7}$/u);
});

test('only the funded stages carry a national code and a plan, and the lines add up to the plan of each project', () => {
  const plan = buildPlan(publicDataset());
  for (const project of plan.projects) {
    const lines = plan.lines.filter((line) => line.project === project.code);
    if (FUNDED.has(project.target)) {
      assert.ok(project.national !== undefined && project.planBillions !== undefined, project.code);
      assert.equal(lines.reduce((sum, line) => sum + line.billions, 0), project.planBillions, project.code);
    } else {
      assert.equal(project.national, undefined);
      assert.equal(lines.length, 0);
    }
  }
});

test('the lines never draw more than an appropriation holds, and the three kinds of source are all used', () => {
  const plan = buildPlan(publicDataset());
  assert.deepEqual(checkPlan(plan), []);
  const sources = new Set(plan.lines.map((line) => line.appropriation));
  for (const key of ['NSTW', 'NSDP']) assert.ok(sources.has(key), key);
  assert.ok(sources.has('SUPPORT') || sources.has('ODAV'), 'an ODA source is used');
});

test('checkPlan names an over-drawn appropriation and a funded project without a code', () => {
  const plan = buildPlan(publicDataset());
  const broken = { ...plan, lines: [...plan.lines, { project: plan.projects[0].code, appropriation: 'NSTW', billions: 100000 }] };
  assert.ok(checkPlan(broken).some((problem) => problem.includes('over-drawn')));
  const unfunded = { ...plan, projects: plan.projects.map((project, index) => (index === 0 ? { ...project, national: undefined } : project)) };
  assert.ok(checkPlan(unfunded).some((problem) => problem.includes('no national code')));
});

test('the stage mix must add up to the number of extra projects', () => {
  const dataset = publicDataset();
  assert.throws(() => buildPlan({ ...dataset, extraProjects: dataset.extraProjects + 1 }), /stageMix adds up/u);
});

test('an unknown dataset is refused by name and the two datasets have their groups', () => {
  assert.throws(() => loadDataset('nope'), /unknown dataset/u);
  assert.deepEqual(DATASETS, ['public', 'enterprise']);
  assert.ok(DATASET_GROUPS.public.includes('base') && DATASET_GROUPS.public.includes('capital'));
});

test('judge fails on a missing figure and applies min, max and equals', () => {
  assert.equal(judge({ name: 'a', value: undefined, min: 0 }).ok, false);
  assert.equal(judge({ name: 'a', value: Number.NaN, min: 0 }).ok, false);
  assert.equal(judge({ name: 'a', value: 5, min: 6 }).ok, false);
  assert.equal(judge({ name: 'a', value: 5, max: 4 }).ok, false);
  assert.equal(judge({ name: 'a', value: 5, equals: 4 }).ok, false);
  assert.equal(judge({ name: 'a', value: 5, min: 5, max: 5, equals: 5 }).ok, true);
  assert.equal(judgeAll([{ name: 'x', value: 1, min: 1 }, { name: 'y', value: 0, min: 1 }]).ok, false);
});

test('arguments are read as a command and flags, and a stray word is refused', () => {
  assert.deepEqual(parseArgs(['apply', '--dataset', 'public', '--api', 'http://x', '--dry']), { command: 'apply', flags: { dataset: 'public', api: 'http://x', dry: true } });
  assert.throws(() => parseArgs(['apply', 'oops']), /unexpected argument/u);
});

test('the session token is a signed payload that carries the tenant, the membership and an expiry', () => {
  const key = Buffer.from('k'.repeat(32)).toString('base64');
  const token = sessionToken({ key, tenantId: 't1', membershipId: 'm1', now: 1_000_000 });
  const [payload, signature] = token.split('.');
  assert.ok(signature.length > 20);
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), { tenantId: 't1', membershipId: 'm1', scopeVersion: 1, exp: 1300 });
});

/** The answers of a fully seeded public stack: lists by path and single reads by path. */
function seededPublic(plan) {
  const base = { IMPLEMENTATION: 3, BUDGETED: 2, SUSPENDED: 1, COMPLETED: 1, APPRAISAL: 2, PIPELINE: 2, REJECTED: 1, CONCEPT: 1 };
  const rows = [];
  for (const [stage, count] of Object.entries(base)) for (let index = 0; index < count; index += 1) rows.push({ status: stage, national_project_code: index === 0 ? '1' : null });
  for (const project of plan.projects) rows.push({ status: project.target, national_project_code: project.national ?? null });
  const packages = plan.procurement.plans.flatMap((entry) => entry.packages);
  const lists = {
    '/resources/project': rows,
    '/procurement-plans': plan.procurement.plans.map(() => ({ status: 'APPROVED' })),
    '/resources/procurement_package': packages,
    '/resources/contractor': Array.from({ length: 16 }, (_, index) => ({ id: index })),
    '/early-warning-rules': plan.alerts.rules.map((rule) => ({ rule_code: rule.rule_code, status: 'PUBLISHED' })),
    '/home/warnings': [{ severity: 'INFO' }, { severity: 'WARNING' }, { severity: 'CRITICAL' }],
    '/period-snapshots': [{ status: 'FROZEN' }, { status: 'FROZEN' }],
    '/directives': plan.meetings.flatMap((meeting) => meeting.directives),
    '/resources/contract': Array.from({ length: 5 }, () => ({ status: 'ACTIVE' })),
    '/resources/payment_request': [{ status: 'SETTLED' }, { status: 'SENT_TREASURY' }, { status: 'SETTLED' }],
    '/advances': [{ id: 1 }],
    '/advances/overdue': [{ id: 1 }],
    '/resources/metric_definition': [{ status: 'CERTIFIED' }, { status: 'CERTIFIED' }],
    '/bi/dashboards': plan.bi.dashboards.map((entry) => ({ code: entry.code, status: 'PUBLISHED' })),
  };
  const gets = {
    '/egp/connection': { record_counts: { KHLCNT: 12, TBMT: 7 } },
    '/egp/obligations': { counts: { overdue: 3, due_soon: 1, met: 2 } },
    '/egp/mappings': { counts: { ACTIVE: 9, PROPOSED: 2 } },
    '/egp/reconciliation/items': { counts: { open: 4, resolved: 3 } },
    '/package-workflows/summary': { total: packages.length, not_started: 2, late: 20, on_hold: 2 },
    '/package-workflows/process-tree': { nodes: Array.from({ length: 30 }, (_, index) => ({ id: index })), total: { count: packages.length } },
    '/home/command-center': [{ metric_code: 'DISBURSED_TREASURY', value: '175760000000' }, { metric_code: 'DISBURSEMENT_RATE_TOTAL', value: '41.2' }],
    '/finance-feed/connection': { record_counts: { PROJECT: 20, PLAN: 20, DISBURSEMENT: 60 } },
    '/committee/workspace': { feed: { empty: false, projects: 18 } },
    '/committee/roster': { committees: [{ members: [{ committee_role: 'HEAD' }, { committee_role: 'DEPUTY' }, { committee_role: 'MEMBER' }, { committee_role: 'SECRETARIAT' }] }] },
    '/directives/summary': { by_status: { OVERDUE: 2 } },
  };
  return { lists, gets };
}

function readerOf({ lists, gets }) {
  return {
    async list(_person, path) { return lists[path]; },
    async get(_person, path) { return gets[path] === undefined ? { ok: false } : { ok: true, json: gets[path] }; },
  };
}

test('verify passes on a fully seeded stack and fails, naming the check, when one thing is short', async () => {
  const plan = buildPlan(publicDataset());
  const seeded = seededPublic(plan);
  const verdict = judgeAll(await verifyChecks(plan, readerOf(seeded)));
  assert.deepEqual(verdict.results.filter((result) => !result.ok), []);
  assert.equal(verdict.ok, true);
  const short = { ...seeded, lists: { ...seeded.lists, '/resources/project': seeded.lists['/resources/project'].filter((row, index) => !(row.status === 'IMPLEMENTATION' && index > 4)) } };
  const projects = judgeAll(await verifyChecks(plan, readerOf(short)));
  assert.equal(projects.ok, false);
  assert.ok(projects.results.some((result) => !result.ok && result.name.includes('IMPLEMENTATION')));
  const noCritical = { ...seeded, lists: { ...seeded.lists, '/home/warnings': [{ severity: 'INFO' }, { severity: 'WARNING' }] } };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf(noCritical))).results.some((result) => !result.ok && result.name === 'warnings CRITICAL'));
  const unpublished = { ...seeded, lists: { ...seeded.lists, '/bi/dashboards': [] } };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf(unpublished))).results.some((result) => !result.ok && result.name === 'dashboards published'));
  const noOverdueAdvance = { ...seeded, lists: { ...seeded.lists, '/advances/overdue': [] } };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf(noOverdueAdvance))).results.some((result) => !result.ok && result.name === 'advances over the recovery deadline'));
  const noWorkflowLate = { ...seeded, gets: { ...seeded.gets, '/package-workflows/summary': { total: 42, not_started: 2, late: 0, on_hold: 2 } } };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf(noWorkflowLate))).results.some((result) => !result.ok && result.name === 'workflows late'));
  const emptyCommittee = { ...seeded, gets: { ...seeded.gets, '/committee/workspace': { feed: { empty: true, projects: 0 } } } };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf(emptyCommittee))).results.some((result) => !result.ok && result.name === 'committee workspace has data'));
});

test('verify fails (and does not throw) when the register cannot be read', async () => {
  const plan = buildPlan(publicDataset());
  const reader = { async list() { throw new Error('down'); }, async get() { return { ok: false }; } };
  assert.equal(judgeAll(await verifyChecks(plan, reader)).ok, false);
});

test('the reader follows the cursor of a list and signs one token per call', async () => {
  const pages = [{ items: [{ id: 1 }, { id: 2 }], next_cursor: 'c2' }, { items: [{ id: 3 }], next_cursor: null }];
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, auth: options.headers.authorization });
    const page = pages[seen.length - 1];
    return { status: 200, ok: true, text: async () => JSON.stringify(page) };
  };
  const fixtures = join(HERE, '..', 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json');
  const reader = new ApiReader({ base: 'http://x/', key: Buffer.alloc(32, 1).toString('base64'), tenantId: 't', fixturesPath: fixtures, fetchImpl });
  const rows = await reader.list('owner', '/things', { q: 'a' });
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /cursor=c2/u);
  assert.ok(seen.every((call) => call.auth.startsWith('Bearer ')));
});

test('the command line plans a dataset, refuses a missing api and prints the usage for nothing', async () => {
  assert.equal(await main(['plan', '--dataset', 'public']), 0);
  await assert.rejects(() => main(['apply', '--dataset', 'public']), /--api/u);
  assert.equal(await main([]), 2);
});

test('the dataset fixtures hold no key, token or password', () => {
  const text = readFileSync(join(HERE, 'fixtures', 'clip-data', 'public.json'), 'utf8');
  assert.doesNotMatch(text, /api[_-]?key|secret(?!ariat)|password|bearer/iu);
});

test('the procurement plans cover forty packages inside the biggest line of each project, with a spread of workflow targets', () => {
  const plan = buildPlan(publicDataset());
  const packages = plan.procurement.plans.flatMap((entry) => entry.packages);
  assert.ok(packages.length >= 40);
  assert.equal(plan.expect.packages, packages.length);
  const codes = packages.map((item) => item.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const entry of plan.procurement.plans) {
    const own = plan.lines.filter((line) => line.project === entry.project);
    const biggest = Math.max(...own.map((line) => line.billions)) * 1000;
    assert.ok(entry.packages.reduce((sum, item) => sum + item.millions, 0) <= biggest, entry.project);
  }
  const targets = new Set(packages.map((item) => item.target));
  assert.ok(targets.size >= 6, 'the tree needs many different steps');
  assert.ok([...targets].some((target) => target.startsWith('HOLD:')) || [...targets].includes('NOT_STARTED'));
});

test('the enterprise plan has investment and equipment projects with equity and loan that add up to the year plan', () => {
  const dataset = enterpriseDataset();
  const plan = buildPlan(dataset);
  assert.equal(plan.projects.length, dataset.projectsPerKind * 2);
  assert.deepEqual(new Set(plan.projects.map((project) => project.kind)), new Set(['INVESTMENT', 'EQUIPMENT']));
  for (const project of plan.projects) {
    assert.equal(project.equityBillions + project.loanBillions, project.planBillions, project.code);
    assert.ok(project.equityBillions >= 1 && project.loanBillions >= 0);
  }
  assert.equal(new Set(plan.projects.map((project) => project.code)).size, plan.projects.length);
  assert.equal(planDigest(plan), planDigest(buildPlan(dataset)));
  assert.equal(plan.expect.directives, dataset.meetings.reduce((sum, meeting) => sum + meeting.directives.length, 0));
});

test('the accounting rows name projects of the plan, two periods, and differ from the plan figures', () => {
  const plan = buildPlan(enterpriseDataset());
  const codes = new Set(plan.projects.map((project) => project.code));
  assert.ok(plan.ebs.rows.length >= 8);
  for (const row of plan.ebs.rows) {
    assert.ok(codes.has(row.project));
    assert.match(row.period, /^2026-[0-9]{2}$/u);
    assert.ok(row.disbursedMillions > 0);
  }
  assert.equal(checkPlan(plan).length, 0);
});

test('the enterprise dataset runs the four enterprise groups and no group of the public dataset', () => {
  assert.deepEqual(DATASET_GROUPS.enterprise, ['clip-ent-projects', 'clip-ent-funding', 'clip-ent-directives', 'clip-ent-ebs', 'clip-ent-reports']);
  assert.ok(DATASET_GROUPS.public.every((group) => !group.startsWith('clip-ent')));
});

test('a verdict over no check fails, so an unsupported dataset or an empty list never passes', () => {
  assert.equal(judgeAll([]).ok, false);
});

test('the enterprise checks fail on an unseeded stack and pass on a seeded one', async () => {
  const plan = buildPlan(enterpriseDataset());
  const empty = { async list() { return []; }, async get() { return { ok: true, json: {} }; } };
  assert.equal(judgeAll(await verifyChecks(plan, empty)).ok, false);
  const projects = plan.projects.map((project, index) => ({ code: project.code, id: `p${index}` }));
  const batches = projects.flatMap((project) => [{ project_id: project.id, figure_kind: 'PLAN_YEAR', class_code: 'EQUITY', status: 'ACCEPTED' }, { project_id: project.id, figure_kind: 'PLAN_YEAR', class_code: 'LOAN', status: 'ACCEPTED' }]);
  const directives = Array.from({ length: plan.expect.directives }, (_, index) => ({ id: index }));
  const issues = Array.from({ length: plan.expect.reportIssues }, (_, index) => ({ id: index, form_status: 'DEMO' }));
  const lists = { '/resources/project': projects, '/funding-figures/batches': batches, '/directives': directives, '/ebs/differences': [{ id: 1 }], '/report-engine/issues': issues };
  const gets = { '/hpm/connection': { counts: { pushes: 2, written: 1, rejected: 1, accepted: 0 } } };
  assert.equal(judgeAll(await verifyChecks(plan, readerOf({ lists, gets }))).ok, true);
  // Two batches of one project do not stand in for the missing batches of the others.
  const doubled = { ...lists, '/funding-figures/batches': batches.filter((batch) => batch.project_id === 'p0').concat(batches.filter((batch) => batch.project_id === 'p0')) };
  assert.equal(judgeAll(await verifyChecks(plan, readerOf({ lists: doubled, gets }))).ok, false);
  // A copy that is not marked as a demo form fails: the forms of the clip are always stamped.
  const unmarked = { ...lists, '/report-engine/issues': issues.map((row) => ({ ...row, form_status: 'OFFICIAL' })) };
  assert.ok(judgeAll(await verifyChecks(plan, readerOf({ lists: unmarked, gets }))).results.some((result) => !result.ok && result.name.includes('demo')));
});

test('the phases cover every group of a dataset once, keep the order, and cut down to the groups asked for', () => {
  for (const dataset of DATASETS) {
    const all = DATASET_PHASES[dataset].flatMap((phase) => phase.groups);
    assert.deepEqual([...new Set(all)], DATASET_GROUPS[dataset]);
  }
  assert.deepEqual(phasesFor('public', ['clip-public-workflow']).map((phase) => phase.clockDays), WORKFLOW_CLOCKS);
  assert.deepEqual(phasesFor('public', ['nothing']), []);
  assert.ok(DATASET_PHASES.public.some((phase) => phase.clockDays < 0), 'the clip data is made in the past');
  assert.equal(DATASET_PHASES.public.at(-1).clockDays, 0, 'the last phase runs on the real day');
});

test('the clock of the stack is moved with a post and a stack without the route is left alone', async () => {
  const calls = [];
  assert.equal(await setClock('http://x/', -65, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; }), true);
  assert.deepEqual(calls, [{ url: 'http://x/__e2e/clock', body: { offset_days: -65 } }]);
  assert.equal(await setClock('http://x', 0, async () => ({ ok: false })), false);
  assert.equal(await setClock('http://x', 0, async () => { throw new Error('down'); }), false);
});

test('every package of the plan is driven at one of the workflow clocks, and the clocks are spread', () => {
  const plan = buildPlan(publicDataset());
  const clocks = plan.procurement.plans.flatMap((entry) => entry.packages.map((item) => item.clockDays));
  assert.ok(clocks.every((clock) => WORKFLOW_CLOCKS.includes(clock)));
  assert.ok(new Set(clocks).size >= 5);
});

test('the dashboards of the dataset use only metrics the repository defines, and the payment forms and groups agree with the plan', () => {
  const plan = buildPlan(publicDataset());
  const defined = new Set(readdirSync(join(HERE, '..', 'metrics')).filter((name) => name.endsWith('.metric.yaml')).map((name) => name.replace('.metric.yaml', '')));
  for (const dashboard of plan.bi.dashboards) {
    assert.ok(dashboard.metrics.length >= 2, dashboard.code);
    for (const code of dashboard.metrics) assert.ok(defined.has(code), code);
  }
  assert.equal(new Set(plan.bi.dashboards.map((entry) => entry.code)).size, plan.bi.dashboards.length);
  assert.deepEqual(plan.payments.formCodes, ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
  assert.ok(plan.bi.sourceCommit.length >= 7);
});
