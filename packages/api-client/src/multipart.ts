import type { ApiClient } from './client.ts';
import type { CommandAttempt } from './idempotency.ts';
import type { SuccessBody, UploadInput, UploadOperation } from './operations.ts';

/** The form field the file travels in unless the caller names another. */
const DEFAULT_FIELD = 'file';
const DEFAULT_FILE_NAME = 'upload';

type PathOf<K extends UploadOperation> = UploadInput<K> extends { path: infer P } ? { path: P } : { path?: undefined };
type QueryOf<K extends UploadOperation> = UploadInput<K> extends { query?: infer Q } ? { query?: Q } : { query?: undefined };

export type UploadFileInput<K extends UploadOperation> = PathOf<K> & QueryOf<K> & {
  file: Blob;
  /** The form field; `file` by default. */
  field?: string;
  /** The file name sent with the part; the name of a `File`, otherwise `upload`. */
  filename?: string;
  /** Lets a retry of the same intention reuse its idempotency key. */
  attempt?: CommandAttempt;
};

/**
 * Uploads one file as `multipart/form-data` (the typed command surface is JSON only). The request has no JSON content
 * type, so the runtime sets the multipart one with its boundary; the idempotency key, the bearer token, the retries
 * while the server is still working and the Problem+JSON errors are those of every other command.
 */
export function uploadFile<K extends UploadOperation>(client: ApiClient, operation: K, input: UploadFileInput<K>): Promise<SuccessBody<K>> {
  const form = new FormData();
  const name = input.filename ?? (input.file instanceof File ? input.file.name : DEFAULT_FILE_NAME);
  form.append(input.field ?? DEFAULT_FIELD, input.file, name);
  const { path, query, attempt } = input as { path?: unknown; query?: unknown; attempt?: CommandAttempt };
  return client.upload(operation, { path, query, form, attempt } as unknown as UploadInput<K>);
}
