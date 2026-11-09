import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClipPlan } from './plan.ts';
import { feedFiles } from './public-feed.ts';
import { khlcntCsv, tbmtCsv } from './public-egp.ts';
import { statementCsv } from './public-dis.ts';
import { ebsCsv } from './enterprise.ts';
import { periodCode } from './enterprise-reports.ts';

/** The files the groups upload are built by pure functions: their headers are the layouts of the product, their rows follow the plan. */

const day = (days: number): string => new Date(Date.UTC(2026, 10, 8 + days)).toISOString().slice(0, 10);
const PACKAGES = [
  { code: 'GT100-XL01', title: 'Package one', project: 'DA-GT100', millions: 1000, method: 'OPEN_BIDDING' },
  { code: 'GT100-TV01', title: 'Package "two"', project: 'DA-GT100', millions: 200, method: 'LIMITED_BIDDING' },
];
const EGP = { planPrefix: 'KH2026', fileRows: 2, badRows: 3, decisionNo: 'QD-1', noticePrefix: 'IB', reason: 'A reason of more than ten characters', badPrice: 'Bad price', badDay: 'Bad day', repeated: 'Repeated' };

test('the e-GP plan file has the header of the layout, one row for each package and three rows with an error on purpose', () => {
  const lines = khlcntCsv(PACKAGES, EGP, day).trim().split('\n');
  assert.equal(lines[0], 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code');
  assert.equal(lines.length, 1 + PACKAGES.length + 3);
  assert.ok(lines[1]?.endsWith('DA-GT100,GT100-XL01'));
  assert.ok(lines.some((line) => line.includes('1.200.000.000')), 'a price with dots is the bad row');
  assert.ok(lines.some((line) => line.includes('2026-02-31')), 'a day that does not exist is the bad row');
  assert.ok(lines[lines.length - 1]?.includes('PK-GT100-XL01'), 'the repeated package is last');
});

test('the e-GP notice file keeps the order of the dates: published, then closing and opening', () => {
  const lines = tbmtCsv(PACKAGES, EGP, day).trim().split('\n');
  assert.equal(lines.length, 1 + PACKAGES.length);
  for (const line of lines.slice(1)) {
    const columns = line.split(',');
    assert.ok((columns[5] ?? '') <= (columns[6] ?? ''));
    assert.ok((columns[6] ?? '') <= (columns[7] ?? ''));
  }
});

test('the Treasury statement has one line for each payment with the office code of the layout', () => {
  const csv = statementCsv({
    office: { key: 'KB', name: 'Office', externalCode: '0011', province: 'P' },
    decision: { symbol: 's', title: 't', sender: 'x' },
    reason: 'r',
    fiscalYear: 2026,
    lastMonth: 10,
    rows: [
      { project: 'DA-GT100', no: 'KB-1', date: '2026-03-04', millions: 5 },
      { project: 'DA-GT100', no: 'KB-2', date: '2026-04-09', millions: 7 },
    ],
  });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'document_no,document_date,project_code,treasury_office_code,amount_vnd,confirmed_at');
  assert.equal(lines[1], 'KB-1,2026-03-04,DA-GT100,0011,5000000,2026-03-04');
  assert.equal(lines.length, 3);
});

test('the feed files add the months up and report every fifth project three per cent above ours', () => {
  const projects = Array.from({ length: 5 }, (_, index) => ({ code: `DA-GT${100 + index}`, name: `Project ${index}`, sector: 'TRANSPORT', area: 'CB-A', planBillions: 10 }));
  const rows = projects.flatMap((project) => [
    { project: project.code, date: '2026-03-10', millions: 1000 },
    { project: project.code, date: '2026-03-20', millions: 500 },
    { project: project.code, date: '2026-05-02', millions: 1000 },
  ]);
  const files = feedFiles({ projects } as unknown as ClipPlan, 2026, rows, '2026-11-08');
  const disbursement = files.disbursement.trim().split('\n');
  assert.equal(disbursement[0], 'feed_project_code,fiscal_year,month,fund_code,disbursed_month,disbursed_cumulative,reported_on,as_of');
  assert.equal(disbursement.length, 1 + projects.length * 2);
  assert.ok(disbursement[1]?.includes(',3,NSTW,1500000000,1500000000,'));
  assert.ok(disbursement[2]?.includes(',5,NSTW,1000000000,2500000000,'));
  const fifth = disbursement.filter((line) => line.startsWith('F-GT104,'));
  assert.ok(fifth[0]?.includes(',3,NSTW,1545000000,1545000000,'), 'three per cent above ours');
  assert.equal(files.project.trim().split('\n').length, 1 + projects.length);
  assert.equal(files.plan.trim().split('\n')[1], 'F-GT100,2026,NSTW,10000000000,2026-11-08');
});

test('the accounting file names the projects and the periods of the plan', () => {
  const csv = ebsCsv(
    { ebs: { note: 'n', rows: [{ project: 'DA-PMDT105', period: '2026-08', disbursedMillions: 12, committedMillions: 300 }] } } as unknown as Parameters<typeof ebsCsv>[0],
    '2026-11-05',
  );
  assert.equal(csv, 'project_code,period,extract_date,disbursed_vnd,committed_vnd\nDA-PMDT105,2026-08,2026-11-05,12000000,300000000\n');
});

test('the period codes are the ones the report engine writes: months zero padded, quarters not', () => {
  assert.equal(periodCode({ kind: 'MONTH', index: 9 }, 2026), '2026-M09');
  assert.equal(periodCode({ kind: 'MONTH', index: 10 }, 2026), '2026-M10');
  assert.equal(periodCode({ kind: 'QUARTER', index: 3 }, 2026), '2026-Q3');
});

// ---- the actuals of the enterprise snapshot --------------------------------------------------------------------------------------------------

test('the actuals of the snapshot group: the same cell always gets the same figures, only for the months asked, whole millions, and a cell without a plan gets none', async () => {
  const { actualPlan, hashOf } = await import('./enterprise-snapshot.ts');
  const input = { key: 'DA-1:EQUITY', measure: 'DISBURSED', planVnd: '100000000000', lastMonth: 10, months: [1, 2, 3, 10] };
  const first = actualPlan(input);
  assert.deepEqual(first, actualPlan(input));
  assert.deepEqual(
    first.map((entry) => entry.month),
    [1, 2, 3, 10],
  );
  for (const entry of first) assert.match(entry.amountVnd, /^[1-9]\d*000000$/);
  const total = actualPlan({ ...input, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).reduce((sum, entry) => sum + BigInt(entry.amountVnd), 0n);
  assert.ok(total > 30_000_000_000n && total < 100_000_000_000n, `the cumulative stays under the plan, got ${total}`);
  assert.ok(actualPlan({ ...input, measure: 'EXECUTED' }).every((entry, index) => BigInt(entry.amountVnd) >= BigInt(first[index]?.amountVnd ?? '0') - 1_000_000n * 3n));
  assert.deepEqual(actualPlan({ ...input, planVnd: null }), [1, 2, 3, 10].map((month) => ({ month, amountVnd: '0' })));
  assert.notEqual(hashOf('DA-1:EQUITY'), hashOf('DA-1:LOAN'));
});
