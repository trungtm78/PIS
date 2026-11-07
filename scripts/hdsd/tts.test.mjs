import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLimit } from './tts.mjs';

test('the work is done on every item, never more than the limit at once, and the answers keep the order of the items', async () => {
  let running = 0;
  let most = 0;
  const answers = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, index) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((done) => setTimeout(done, ms));
    running -= 1;
    return `${index}:${ms}`;
  });
  assert.deepEqual(answers, ['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
  assert.equal(most, 3);
});

test('an empty list is answered with an empty list', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
