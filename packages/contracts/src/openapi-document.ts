// Minimal structural view of the OpenAPI 3.1 document: only what lint and generation read.
export interface OpenApiOperation {
  operationId?: string;
  tags?: unknown;
  'x-permission'?: unknown;
  'x-exposure'?: unknown;
  responses?: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    [section: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OperationEntry {
  /** operationId, or "METHOD /path" when the operation declares none. */
  id: string;
  method: string;
  path: string;
  operation: OpenApiOperation;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function listOperations(doc: OpenApiDocument): OperationEntry[] {
  const entries: OperationEntry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method] as OpenApiOperation | undefined;
      if (operation === undefined) continue;
      entries.push({ id: operation.operationId ?? `${method.toUpperCase()} ${path}`, method, path, operation });
    }
  }
  return entries;
}
