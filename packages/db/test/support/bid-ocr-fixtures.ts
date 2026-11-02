import { randomUUID } from 'node:crypto';
import { TENANT_A } from './authz-fixtures';
import type { AuthzHarness } from './authz-fixtures';

export interface SeededOcrPage {
  id: string;
  pageIndex: number;
}

/**
 * A page of OCR as the pipeline would leave it, written as the owner of the schema so a test can start from any status. The text is a key and a digest the test chose; the files are not written here.
 */
export async function seedOcrPage(
  harness: AuthzHarness,
  versionId: string,
  options: { pageIndex: number; confidence?: string; status?: string; tables?: unknown; tableMismatch?: boolean; textKey?: string; textSha?: string; tenantId?: string },
): Promise<SeededOcrPage> {
  const pageId = randomUUID();
  const tenantId = options.tenantId ?? TENANT_A;
  await harness.owner(tenantId, [
    [
      `insert into machvon.document_page_ocr (tenant_id, id, document_version_id, page_index, ocr_confidence, text_sha256, text_object_key, tables_json, engine_version, review_status, table_mismatch)
       values ($1, $2, $3, $4, $5::numeric, $6, $7, $8::jsonb, 'engine-1.0', $9, $10)`,
      [
        tenantId,
        pageId,
        versionId,
        options.pageIndex,
        options.confidence ?? '0.9900',
        options.textSha ?? 'a'.repeat(64),
        options.textKey ?? `tenants/${tenantId}/ocr-text/${randomUUID()}`,
        JSON.stringify(options.tables ?? []),
        options.status ?? 'AUTO_ACCEPTED',
        options.tableMismatch ?? false,
      ],
    ],
  ]);
  return { id: pageId, pageIndex: options.pageIndex };
}
