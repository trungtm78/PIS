import { createHash } from 'node:crypto';
import { DomainError } from '@machvon/kernel';

/**
 * Where the bundle of a metric sync comes from: the pipeline of the repository stores the file in the object store and names it (`bundle_object_key` with its
 * `bundle_sha256`); a deploy that has no such pipeline (a demo tenant, a seed) gives the document itself (`bundle`). The server then keeps the canonical bytes of the document and computes
 * the hash itself, so the run record names the bytes it really read (`inline:<sha256>`) and the same document again is the same deploy. Exactly one of the two ways.
 */
export interface MetricBundleSource {
  objectKey: string;
  sha256: string;
  /** The bytes, when the document came inline; undefined when they must be read from the object store. */
  bytes?: Uint8Array;
}

interface Body {
  bundle?: Record<string, unknown> | undefined;
  bundle_object_key?: string | undefined;
  bundle_sha256?: string | undefined;
}

export function metricBundleSource(body: Body): MetricBundleSource {
  const inline = body.bundle !== undefined;
  const byKey = body.bundle_object_key !== undefined || body.bundle_sha256 !== undefined;
  if (inline === byKey) throw new DomainError('VALIDATION_FAILED', 422, 'bundle');
  if (inline) {
    const bytes = new TextEncoder().encode(JSON.stringify(body.bundle));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { objectKey: `inline:${sha256}`, sha256, bytes };
  }
  if (body.bundle_object_key === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'bundle_object_key');
  if (body.bundle_sha256 === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'bundle_sha256');
  return { objectKey: body.bundle_object_key, sha256: body.bundle_sha256 };
}
