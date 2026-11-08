/**
 * The OpenAPI subset published for external readers (INT-1): the operations of the contract that carry `x-open-api: true`, the schemas they reach, and the one security scheme (OAuth 2 client credentials).
 * Nothing of the internal API leaks into it: an operation that is not marked is not listed, a schema that no listed operation reaches is not copied, and the internal permission and plane markers are removed.
 */

type Json = Record<string, unknown>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const REF = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/;
const INTERNAL_KEYS: readonly string[] = ['x-permission', 'x-plane', 'x-audit-action', 'x-step-up', 'x-state-guard', 'x-domain-events', 'x-read-model', 'x-exposure', 'x-error-codes'];

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function collectRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = REF.exec(value)?.[1];
        if (name !== undefined) found.add(name);
      } else collectRefs(value, found);
    }
  }
}

export interface OpenApiSubsetOptions {
  title: string;
  version: string;
  description: string;
}

export interface OpenApiSubset {
  document: Json;
  operations: Array<{ id: string; method: string; path: string; scope: string | null }>;
}

/** The scope an operation of the subset needs, from its `x-open-scope` marker. */
const scopeOf = (operation: Json): string | null => (typeof operation['x-open-scope'] === 'string' ? operation['x-open-scope'] : null);

/** Builds the subset from the full contract document. Reachable schemas are followed through `$ref` to a fixed point. */
export function openApiSubsetOf(full: Json, options: OpenApiSubsetOptions): OpenApiSubset {
  const sourcePaths = isObject(full.paths) ? full.paths : {};
  const sourceSchemas = isObject(full.components) && isObject(full.components.schemas) ? full.components.schemas : {};
  const paths: Json = {};
  const operations: OpenApiSubset['operations'] = [];
  const reached = new Set<string>();
  for (const [path, item] of Object.entries(sourcePaths).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isObject(item)) continue;
    const kept: Json = {};
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation) || operation['x-open-api'] !== true) continue;
      const published: Json = {};
      for (const [key, value] of Object.entries(operation)) {
        if (INTERNAL_KEYS.includes(key) || key === 'x-open-api') continue;
        published[key] = value;
      }
      published.security = path.endsWith('/token') ? [] : [{ clientCredentials: scopeOf(operation) === null ? [] : [scopeOf(operation)] }];
      collectRefs(published, reached);
      kept[method] = published;
      operations.push({ id: String(operation.operationId ?? ''), method, path, scope: scopeOf(operation) });
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  const queue = [...reached];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    const schema = sourceSchemas[name];
    if (schema === undefined) continue;
    const inner = new Set<string>();
    collectRefs(schema, inner);
    for (const next of inner) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  const schemas: Json = {};
  for (const name of [...reached].sort()) if (sourceSchemas[name] !== undefined) schemas[name] = sourceSchemas[name];
  const scopes: Json = {};
  for (const operation of operations) if (operation.scope !== null) scopes[operation.scope] = operation.scope;
  return {
    operations,
    document: {
      openapi: typeof full.openapi === 'string' ? full.openapi : '3.0.3',
      info: { title: options.title, version: options.version, description: options.description },
      paths,
      components: {
        schemas,
        securitySchemes: { clientCredentials: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/open/v1/token', scopes } } } },
      },
    },
  };
}
