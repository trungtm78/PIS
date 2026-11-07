import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold } from './fold-i18n-parts.mjs';

test('the keys of the parts are added, and a key of the catalogue keeps its text', () => {
  const { merged, added } = fold({ a: '1', b: '2' }, [{ b: 'changed', c: '3' }, { d: '4' }]);
  assert.deepEqual(merged, { a: '1', b: '2', c: '3', d: '4' });
  assert.deepEqual(added, ['c', 'd']);
});
