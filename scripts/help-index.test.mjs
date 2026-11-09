import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { OUTPUT, REPO_ROOT, buildIndex, check, generate, render } from './help-index.mjs';

const INPUTS = [
  join('apps', 'web', 'src', 'routes', 'routes.generated.json'),
  join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'),
  join('scripts', 'help'),
  join('scripts', 'hdsd', 'narration.json'),
  join('scripts', 'hdsd', 'flows'),
  join('scripts', 'hdsd', 'chapters.json'),
];

/** A scratch copy of the inputs, so a test can break one of them without touching the repository. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'help-index-'));
  for (const path of INPUTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  return root;
}

const edit = (root, path, change) => {
  const file = join(root, path);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, JSON.stringify(value));
};

describe('help index', () => {
  it('is current in the repository and covers every web screen', () => {
    assert.deepEqual(check(REPO_ROOT), []);
  });

  it('describes a screen from the catalogue and names the chapter of the guide', () => {
    const entry = buildIndex(REPO_ROOT).screens['ADM-06'];
    assert.equal(entry.title.length > 0, true);
    assert.equal(entry.kind, 'workflow');
    assert.equal(entry.fields.includes('Vai trò'), true);
    assert.equal(entry.chapter.id, 'tour-adm-quy-trinh-cau-hinh');
    assert.equal(entry.chapter.step, 'adm-06');
  });

  it('keeps one set of steps for each kind, never one for each screen', () => {
    const index = buildIndex(REPO_ROOT);
    for (const entry of Object.values(index.screens)) {
      assert.equal(entry.steps, undefined);
      assert.ok(index.kinds[entry.kind].steps.length > 0);
    }
  });

  it('writes the same text twice (generation is deterministic)', () => {
    const root = scratch();
    try {
      generate(root);
      const first = readFileSync(join(root, OUTPUT), 'utf8');
      generate(root);
      assert.equal(readFileSync(join(root, OUTPUT), 'utf8'), first);
      assert.equal(first, render(buildIndex(root)));
      assert.deepEqual(check(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a missing file, a drifted file and a screen without a guide', () => {
    const root = scratch();
    try {
      assert.match(check(root)[0], /is missing/u);
      generate(root);
      const file = join(root, OUTPUT);
      writeFileSync(file, readFileSync(file, 'utf8').replace('"schema": 1', '"schema": 2'));
      assert.match(check(root).join('\n'), /out of date/u);
      generate(root);
      // Drop a screen from the catalogue: the route has no entry and no reason.
      edit(root, join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'), (catalogue) => {
        const at = catalogue.findIndex((screen) => screen.id === 'ADM-06');
        catalogue.splice(at, 1);
      });
      const problems = check(root).join('\n');
      assert.match(problems, /ADM-06: no help entry and no reason/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an explicit reason and rejects empty and unknown reasons', () => {
    const root = scratch();
    try {
      edit(root, join('scripts', 'help', 'no-help.json'), (value) => {
        value.reasons['ADM-06'] = 'The screen is shown only inside the wizard of another screen.';
      });
      generate(root);
      assert.equal(buildIndex(root).screens['ADM-06'], undefined);
      assert.deepEqual(check(root), []);
      edit(root, join('scripts', 'help', 'no-help.json'), (value) => {
        value.reasons['ADM-06'] = '  ';
        value.reasons['NOPE-99'] = 'There is no such screen.';
      });
      const problems = check(root).join('\n');
      assert.match(problems, /ADM-06: the no-help reason is empty/u);
      assert.match(problems, /NOPE-99: no-help reason for a screen that is not in the route table/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the default steps for a kind without its own guide', () => {
    const root = scratch();
    try {
      edit(root, join('scripts', 'help', 'kind-guides.json'), (guides) => {
        delete guides.kinds.workflow;
      });
      const index = buildIndex(root);
      assert.deepEqual(index.kinds.workflow.steps.length > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
