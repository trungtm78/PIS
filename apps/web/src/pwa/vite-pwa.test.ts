// @vitest-environment node
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { bundleServiceWorker, buildIdOf, pwaPlugin, shellFiles } from '../../vite.pwa';
import type { BundleItem } from '../../vite.pwa';
import { main as iconsMain } from './icons-cli';

describe('the build of the worker', () => {
  it('has icons that are the ones the tokens of the design generate (npm run pwa:icons)', () => {
    expect(iconsMain(['check'])).toBe(0);
    // It draws four rasters with 16 samples a pixel: seconds alone, more on a busy machine.
  }, 60_000);

  const bundle: Record<string, BundleItem> = {
    'index.html': { type: 'asset', fileName: 'index.html', source: '<html>' },
    'assets/index-a1.js': { type: 'chunk', fileName: 'assets/index-a1.js', isEntry: true, imports: ['assets/vendor-b2.js'], viteMetadata: { importedCss: new Set(['assets/index-a1.css']), importedAssets: new Set(['assets/logo-c3.svg']) } },
    'assets/vendor-b2.js': { type: 'chunk', fileName: 'assets/vendor-b2.js', imports: [] },
    'assets/ApprovalQueueScreen-d4.js': { type: 'chunk', fileName: 'assets/ApprovalQueueScreen-d4.js', imports: ['assets/vendor-b2.js'] },
  };

  it('lists the page, the entry and what it imports, and not the lazy screens', () => {
    const files = shellFiles(bundle, ['be-vietnam-pro-latin-400.woff2']);
    expect(files).toEqual(['/assets/index-a1.css', '/assets/index-a1.js', '/assets/logo-c3.svg', '/assets/vendor-b2.js', '/fonts/be-vietnam-pro-latin-400.woff2', '/icons/icon-192.png', '/index.html']);
    expect(files.some((file) => file.includes('ApprovalQueueScreen'))).toBe(false);
  });

  it('gives a build id that changes with the files and with the page', () => {
    const files = shellFiles(bundle, []);
    expect(buildIdOf(files, '<html>')).toMatch(/^[0-9a-f]{12}$/);
    expect(buildIdOf(files, '<html>')).toBe(buildIdOf(files, '<html>'));
    expect(buildIdOf(files, '<html>')).not.toBe(buildIdOf(files, '<html lang="en">'));
    expect(buildIdOf([...files, '/assets/new.js'], '<html>')).not.toBe(buildIdOf(files, '<html>'));
  });

  it('bundles to one script that registers the six handlers and knows nothing of the API', async () => {
    const code = await bundleServiceWorker({ buildId: 'abc123def456', precache: ['/index.html', '/assets/index-a1.js'], appName: 'Hệ thống quản lý đầu tư công' });
    expect(code).toContain('mv-shell-');
    expect(code).toContain('abc123def456');
    expect(code).not.toMatch(/\bimport\s*\(|\brequire\(/);
    const handlers: string[] = [];
    const scope = {
      addEventListener: (type: string) => handlers.push(type),
      location: { origin: 'https://pis.example.vn' },
      navigator: { language: 'vi-VN' },
    };
    vm.runInNewContext(code, { self: scope, Request, Response, URL, Promise });
    expect(handlers.sort()).toEqual(['activate', 'fetch', 'install', 'message', 'notificationclick', 'push']);
  });

  it('emits the manifest and the worker at the root of the build, named for the public edition', async () => {
    const emitted: Array<{ fileName: string; source: string }> = [];
    const plugin = pwaPlugin();
    const hook = plugin.generateBundle as unknown as { handler: (this: unknown, options: unknown, bundle: unknown) => Promise<void> };
    await hook.handler.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file), warn: vi.fn() }, {}, bundle);
    const names = emitted.map((file) => file.fileName).sort();
    expect(names).toEqual(['manifest.webmanifest', 'sw.js']);
    const emittedManifest = JSON.parse(emitted.find((file) => file.fileName === 'manifest.webmanifest')?.source ?? '{}') as { name: string; theme_color: string; short_name: string };
    expect(emittedManifest.name).toBe('Hệ thống quản lý đầu tư công');
    expect(emittedManifest.theme_color).toBe('#102E3B');
    expect(emittedManifest.short_name).toBe('Đầu tư công');
    const worker = emitted.find((file) => file.fileName === 'sw.js')?.source ?? '';
    expect(worker).toContain('/assets/index-a1.js');
    expect(worker).toContain('Hệ thống quản lý đầu tư công');
  });

  it('names the manifest and the worker for the enterprise edition when it is the one being built, with the colour of its bar', async () => {
    const before = process.env.VITE_EDITION;
    process.env.VITE_EDITION = 'enterprise';
    try {
      const emitted: Array<{ fileName: string; source: string }> = [];
      const hook = pwaPlugin().generateBundle as unknown as { handler: (this: unknown, options: unknown, bundle: unknown) => Promise<void> };
      await hook.handler.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file), warn: vi.fn() }, {}, { 'index.html': { type: 'asset', fileName: 'index.html', source: '<html>' } });
      const manifest = JSON.parse(emitted.find((file) => file.fileName === 'manifest.webmanifest')?.source ?? '{}') as { name: string; theme_color: string; short_name: string };
      expect(manifest.name).toBe('Phần mềm quản lý đầu tư xây dựng');
      expect(manifest.theme_color).toBe('#0F3B57');
      expect(manifest.short_name.length).toBeLessThanOrEqual(12);
      expect(emitted.find((file) => file.fileName === 'sw.js')?.source).toContain('Phần mềm quản lý đầu tư xây dựng');
    } finally {
      if (before === undefined) delete process.env.VITE_EDITION;
      else process.env.VITE_EDITION = before;
    }
  });

  it('falls back to the shell brand key, with a warning, when the edition is not one the build knows', async () => {
    const before = process.env.VITE_EDITION;
    process.env.VITE_EDITION = 'unknown-edition';
    try {
      const warn = vi.fn();
      const emitted: Array<{ fileName: string; source: string }> = [];
      const hook = pwaPlugin().generateBundle as unknown as { handler: (this: unknown, options: unknown, bundle: unknown) => Promise<void> };
      await hook.handler.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file), warn }, {}, { 'index.html': { type: 'asset', fileName: 'index.html', source: '<html>' } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the shell brand key names the application'));
      expect((JSON.parse(emitted[0]?.source ?? '{}') as { name: string }).name).toBe('Hệ thống quản lý đầu tư công');
    } finally {
      if (before === undefined) delete process.env.VITE_EDITION;
      else process.env.VITE_EDITION = before;
    }
  });
});
