import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centre, factsOfNodes, findNode, nodesOfDump } from './mobile.mjs';

const dump = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.view.View" content-desc="Danh sách dự án" clickable="false" bounds="[0,152][720,216]" />
<node index="1" text="" class="android.widget.Button" content-desc="Bản đồ hiện trường" clickable="false" bounds="[0,712][720,808]" />
<node index="2" text="" class="android.widget.Button" content-desc="Làm mới" clickable="true" bounds="[616,248][712,344]" />
<node index="3" text="" class="android.view.View" content-desc="Hiển thị 3 trên 3 dự án" clickable="false" bounds="[0,352][720,712]" />
<node index="4" text="" class="android.widget.Button" content-desc="Dự án&#10;Tab 2 trong tổng số 5" clickable="true" bounds="[144,1352][288,1512]" />
<node index="5" text="A &amp; B" class="android.view.View" content-desc="" clickable="false" bounds="[0,900][720,960]" />
</hierarchy>`;

test('the nodes of a dump keep what a person hears, where it is and whether it takes a touch; a Button counts even when it is not flagged', () => {
  const nodes = nodesOfDump(dump);
  assert.equal(nodes.length, 6);
  assert.deepEqual(nodes[1], { label: 'Bản đồ hiện trường', clickable: true, bounds: { left: 0, top: 712, right: 720, bottom: 808 } });
  assert.equal(nodes[4].label, 'Dự án\nTab 2 trong tổng số 5');
  assert.equal(nodes[5].label, 'A & B');
  assert.deepEqual(centre(nodes[1]), [360, 760]);
  assert.deepEqual(nodesOfDump('<hierarchy></hierarchy>'), []);
});

test('the facts of a screen leave out the tab bar and the buttons that every screen has', () => {
  const facts = factsOfNodes(nodesOfDump(dump));
  assert.deepEqual(facts.labels, ['Danh sách dự án', 'Hiển thị 3 trên 3 dự án', 'A & B']);
  assert.deepEqual(facts.buttons, ['Bản đồ hiện trường']);
  assert.equal(facts.empty, false);
  assert.equal(factsOfNodes(nodesOfDump(`<node text="" content-desc="Chưa có dữ liệu. Điều chỉnh" class="x" clickable="false" bounds="[0,700][720,800]"/>`)).empty, true);
});

test('a node is found by its name in the content, not in the tab bar', () => {
  const nodes = nodesOfDump(dump);
  assert.equal(findNode(nodes, /^Bản đồ/u)?.bounds.top, 712);
  assert.equal(findNode(nodes, /^Dự án\n/u), undefined);
});
