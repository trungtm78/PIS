import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { HpmFileSink } from '@machvon/edition-enterprise/src/server.ts';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * The default sink of the file writer that stands for HPM: a folder of the server, one sub-folder per tenant, the package under its own name. It answers the path relative to the folder (never the absolute path of the
 * server). A name or a tenant that is not a plain file name, or that would leave the folder, is refused: the sink writes inside its folder and nowhere else. Nothing is sent anywhere.
 */
export function directoryFileSink(root: string): HpmFileSink {
  const base = resolve(root);
  return async (tenantId, name, bytes) => {
    if (!SAFE_SEGMENT.test(tenantId) || !SAFE_SEGMENT.test(name)) throw new Error('the package name is not a plain file name');
    const folder = join(base, tenantId);
    const target = resolve(folder, name);
    if (!target.startsWith(`${base}${sep}`)) throw new Error('the package would leave its folder');
    await mkdir(folder, { recursive: true });
    await writeFile(target, bytes);
    return `${tenantId}/${name}`;
  };
}
