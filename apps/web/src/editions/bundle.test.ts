// @vitest-environment node
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import type { Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { DESIGN_ROOT } from '../../vite.config';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// What only the enterprise edition says: its product name and its rule pack. Neither may appear in a public bundle.
const ENTERPRISE_MARKERS = ['Phần mềm quản lý đầu tư xây dựng', 'Construction Investment Management Software', 'enterprise-investment'];

async function bundleOf(edition: string | undefined): Promise<string> {
  const env = process.env as Record<string, string | undefined>;
  const before = { node: env.NODE_ENV, edition: env.VITE_EDITION };
  // Vitest sets NODE_ENV=test, which Vite reads as a development build; the edition is read from the environment, as a real build reads it.
  env.NODE_ENV = 'production';
  if (edition === undefined) delete env.VITE_EDITION;
  else env.VITE_EDITION = edition;
  try {
    const result = await build({
      root: WEB_ROOT,
      configFile: false,
      mode: 'production',
      logLevel: 'silent',
      plugins: [react()],
      resolve: { alias: { '@design': DESIGN_ROOT } },
      build: { write: false, minify: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => ('output' in entry ? entry.output : []));
    return outputs
      .filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
  } finally {
    for (const [key, value] of [['NODE_ENV', before.node], ['VITE_EDITION', before.edition]] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

describe('the production bundle by edition', () => {
  it('carries nothing of the enterprise edition when it is built as public, and carries it when it is built as enterprise', async () => {
    const publicCode = await bundleOf(undefined);
    for (const marker of ENTERPRISE_MARKERS) expect(publicCode).not.toContain(marker);
    // The public bundle still says its own name: the markers are absent because the code is, not because the check is blind.
    expect(publicCode).toContain('Hệ thống quản lý đầu tư công');

    const enterpriseCode = await bundleOf('enterprise');
    for (const marker of ENTERPRISE_MARKERS) expect(enterpriseCode).toContain(marker);
  }, 300_000);
});
