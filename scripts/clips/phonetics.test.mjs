import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPhonetics } from './common.mjs';
import { applyPhonetics, foreignTokens, isVietnameseSyllable, uncoveredTerms } from './phonetics.mjs';
import { speechText } from './text.mjs';

const table = loadPhonetics();

test('the examples of the plan are in the table', () => {
  assert.equal(applyPhonetics('dashboard', table), 'đát-bo');
  assert.equal(applyPhonetics('Dashboard của AI', table), 'đát-bo của ây-ai');
  assert.equal(applyPhonetics('PWA cho ERP', table), 'pê-đắp-liu-a cho i-a-pi');
});

test('every term the scenarios read aloud has an entry (HPM, EBS, SoD, EVM, KPI, BI, API, SSO, MFA, OCR, e-GP, muasamcong, PVN, PVFCCo)', () => {
  const needed = ['HPM', 'EBS', 'SoD', 'EVM', 'KPI', 'BI', 'API', 'SSO', 'MFA', 'OCR', 'e-GP', 'muasamcong', 'PVN', 'PVFCCo', 'AI', 'PWA', 'ERP', 'dashboard', 'HHI', 'NPV', 'IRR', 'Excel', 'Oracle', 'Power', 'Lakehouse', 'Teams'];
  const known = new Set(table.terms.map((entry) => entry.term));
  for (const term of needed) assert.ok(known.has(term), term);
});

test('exact terms are case sensitive: the Vietnamese word "ai" (who) is not the abbreviation AI', () => {
  assert.equal(applyPhonetics('Ai biết? AI trả lời.', table), 'Ai biết? ây-ai trả lời.');
  assert.equal(applyPhonetics('BIỂU và BI', table), 'BIỂU và bi-ai');
});

test('a term is replaced as a whole word only and a replacement is never replaced again', () => {
  assert.equal(applyPhonetics('API và APIs', table), 'ây-pi-ai và APIs');
  assert.equal(applyPhonetics('e-GP và muasamcong', table), 'i-gi-pi và mua sắm công');
  const custom = { terms: [{ term: 'A', say: 'B' }, { term: 'B', say: 'C' }] };
  assert.equal(applyPhonetics('A', custom), 'B');
});

test('longer terms win over shorter ones', () => {
  const custom = { terms: [{ term: 'Power', say: 'pao' }, { term: 'Power BI', say: 'pao-bi-ai' }] };
  assert.equal(applyPhonetics('Power BI', custom), 'pao-bi-ai');
});

test('a spelling that cannot be a Vietnamese syllable is found; Vietnamese words and respellings pass', () => {
  assert.ok(isVietnameseSyllable('thống'));
  assert.ok(isVietnameseSyllable('nghiệp'));
  assert.ok(isVietnameseSyllable('quyền'));
  assert.ok(isVietnameseSyllable('Đạm'));
  assert.ok(!isVietnameseSyllable('dashboard'));
  assert.ok(!isVietnameseSyllable('file'));
  assert.ok(!isVietnameseSyllable('web'));
  assert.deepEqual(foreignTokens('Hệ thống quản lý đầu tư công'), []);
  assert.deepEqual(new Set(foreignTokens('Gửi file cho HPM và KPI')), new Set(['file', 'HPM', 'KPI']));
  assert.deepEqual(foreignTokens('mục 5 và 72,5'), []);
});

test('what the table does not cover is reported and what it covers is not', () => {
  assert.deepEqual(uncoveredTerms('Gửi cho HPM', table), []);
  assert.deepEqual(uncoveredTerms('Gửi file cho HPM', table), ['file']);
});

test('the text for the voice has figures and numbers as words, respelled terms, and no digit left', () => {
  const figures = { rate: { kind: 'percent', sample: 62.4, digits: 1 } };
  const spoken = speechText('AI tính {{figure:rate}} cho 19 báo cáo trên dashboard.', { figures, mode: 'sample' });
  assert.equal(spoken, 'ây-ai tính sáu mươi hai phẩy bốn phần trăm cho mười chín báo cáo trên đát-bo.');
  assert.doesNotMatch(spoken, /\d/u);
});
