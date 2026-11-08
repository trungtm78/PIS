import { createHash } from 'node:crypto';
import { LAYOUT_VERSION, MAX_ROWS } from './layout.mjs';

export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The batches of one export: at most `maxRows` rows each. A batch is named by the hash of what it is made from (the layout version, the kind, the hash of the file and the index of the chunk), so the same file
 * always gives the same batches with the same names, and the platform, which keys the command by that name, applies each at most once however many times the collector sends it.
 */
export function batchesOf({ kind, rows, fileSha256, layoutVersion = LAYOUT_VERSION, maxRows = MAX_ROWS }) {
  const batches = [];
  for (let start = 0; start < rows.length; start += maxRows) {
    const index = batches.length;
    const hash = sha256Of(`${layoutVersion}|${kind}|${fileSha256}|${index}`);
    batches.push({ hash, kind, index, source_file_sha256: fileSha256, mapping_version: layoutVersion, rows: rows.slice(start, start + maxRows) });
  }
  return batches;
}
