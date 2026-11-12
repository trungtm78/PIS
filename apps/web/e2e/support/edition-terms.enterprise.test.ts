import assert from 'node:assert/strict';
import { test } from 'node:test';
import enterpriseOverlay from '../../src/editions/enterprise/overlay.vi.json' with { type: 'json' };
import vi from '../../src/i18n/vi.json' with { type: 'json' };
import { catalogueOf, editionOf, terms } from './edition-terms.ts';

const base = { 'pay.payment.status.sentTreasury': 'Đã gửi Kho bạc', 'pay.payment.status.verified': 'Đã kiểm tra' };
const overlay = { 'pay.payment.status.sentTreasury': 'Đã gửi thanh toán' };

test('the public edition reads the base catalogue as it is', () => {
  assert.equal(catalogueOf('public', base, overlay)['pay.payment.status.sentTreasury'], 'Đã gửi Kho bạc');
});

test('the enterprise edition reads the word its overlay says and every other word of the base', () => {
  const read = catalogueOf('enterprise', base, overlay);
  assert.equal(read['pay.payment.status.sentTreasury'], 'Đã gửi thanh toán');
  assert.equal(read['pay.payment.status.verified'], 'Đã kiểm tra');
});

test('the edition is read from MACHVON_EDITION, then VITE_EDITION, and is public when neither names the enterprise edition', () => {
  assert.equal(editionOf({}), 'public');
  assert.equal(editionOf({ VITE_EDITION: 'enterprise' }), 'enterprise');
  assert.equal(editionOf({ MACHVON_EDITION: 'enterprise' }), 'enterprise');
  assert.equal(editionOf({ MACHVON_EDITION: 'public', VITE_EDITION: 'enterprise' }), 'public');
  assert.equal(editionOf({ MACHVON_EDITION: 'other' }), 'public');
});

test('the catalogue of the run answers for the edition it serves, and holds the real status word', () => {
  assert.equal(typeof terms['pay.payment.status.sentTreasury'], 'string');
  assert.equal(terms['pay.payment.status.sentTreasury'], catalogueOf(editionOf(), vi, enterpriseOverlay)['pay.payment.status.sentTreasury']);
});

test('the real catalogues: the status word of a request sent to the Treasury differs between the editions, and the enterprise one is what its overlay says', () => {
  const key = 'pay.payment.status.sentTreasury';
  assert.equal(catalogueOf('public', vi, enterpriseOverlay)[key], vi[key]);
  assert.equal(catalogueOf('enterprise', vi, enterpriseOverlay)[key], enterpriseOverlay[key]);
  assert.notEqual(vi[key], enterpriseOverlay[key]);
});
