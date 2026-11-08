import { createHash } from 'node:crypto';
import { metricBundleSource } from '../../src/modules/bi/metric-bundle-source';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const refusal = (work: () => unknown): { code?: string; status?: number; detail?: string } => {
  try {
    work();
  } catch (error) {
    return error as { code?: string; status?: number; detail?: string };
  }
  throw new Error('expected a refusal');
};

describe('where the bundle of a metric sync comes from', () => {
  it('takes the bytes of an inline document and computes the hash itself, naming the run by it', () => {
    const bundle = { version: 1, metrics: [{ code: 'rate' }] };
    const source = metricBundleSource({ bundle });
    expect(source.sha256).toBe(sha(JSON.stringify(bundle)));
    expect(source.objectKey).toBe(`inline:${source.sha256}`);
    expect(new TextDecoder().decode(source.bytes)).toBe(JSON.stringify(bundle));
  });

  it('gives the same hash for the same document and another for another', () => {
    expect(metricBundleSource({ bundle: { version: 1, metrics: [] } }).sha256).toBe(metricBundleSource({ bundle: { version: 1, metrics: [] } }).sha256);
    expect(metricBundleSource({ bundle: { version: 1, metrics: [] } }).sha256).not.toBe(metricBundleSource({ bundle: { version: 1, metrics: [{}] } }).sha256);
  });

  it('keeps the key and the hash of a stored bundle as they are and reads no bytes', () => {
    const source = metricBundleSource({ bundle_object_key: 'tenants/t/import/abc', bundle_sha256: 'a'.repeat(64) });
    expect(source).toEqual({ objectKey: 'tenants/t/import/abc', sha256: 'a'.repeat(64) });
  });

  it('refuses both ways at once, neither, and a stored bundle that lacks its key or its hash', () => {
    expect(refusal(() => metricBundleSource({ bundle: {}, bundle_object_key: 'tenants/t/import/abc', bundle_sha256: 'a'.repeat(64) }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'bundle' });
    expect(refusal(() => metricBundleSource({}))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bundle' });
    expect(refusal(() => metricBundleSource({ bundle_object_key: 'tenants/t/import/abc' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bundle_sha256' });
    expect(refusal(() => metricBundleSource({ bundle_sha256: 'a'.repeat(64) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bundle_object_key' });
  });
});
