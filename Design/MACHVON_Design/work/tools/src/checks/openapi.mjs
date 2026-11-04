import { finding } from './finding.mjs';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
export const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export function listOperations(openapi) {
  return Object.entries(openapi.paths ?? {}).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => ({ path, method, operation: item[method] })),
  );
}

function hasHeader(operation, name) {
  return (operation.parameters ?? []).some((p) => p.in === 'header' && p.name === name);
}

/** A write that returns a secret keeps nothing for a replay, so it may say so with its reason instead of taking the header. */
function isNotStored(operation) {
  return operation['x-idempotency'] === 'not-stored' && typeof operation['x-idempotency-reason'] === 'string' && operation['x-idempotency-reason'].trim() !== '';
}

function isAuthorized(operation) {
  return Boolean(operation['x-permission'] || operation['x-required-role'] || operation['x-public'] === true);
}

export function checkOpenApi(model) {
  const findings = [];
  const seen = new Set();

  for (const { path, method, operation } of listOperations(model.openapi)) {
    const id = operation.operationId;
    if (seen.has(id)) findings.push(finding('OPERATION_DUPLICATE_ID', { id, path, method }));
    seen.add(id);
    if (!isAuthorized(operation)) findings.push(finding('OPERATION_WITHOUT_PERMISSION', { id, path, method }));
    if (WRITE_METHODS.has(method) && !hasHeader(operation, 'Idempotency-Key') && !isNotStored(operation)) {
      findings.push(finding('WRITE_WITHOUT_IDEMPOTENCY', { id, path, method }));
    }
  }
  return findings;
}
