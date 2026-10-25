import type { OpenApiDocument } from '@machvon/contracts';
import { enumerateIdBearingOperations, fillPath, operationPath } from './endpoint-enumerator';
import { loadOpenApi } from './test-app';

function doc(paths: Record<string, Record<string, unknown>>): OpenApiDocument {
  return { openapi: '3.1.0', paths } as OpenApiDocument;
}

const SYNTHETIC = doc({
  '/things': { get: { operationId: 'listThings' }, post: { operationId: 'createThing' } },
  '/things/{id}': { get: { operationId: 'getThing' }, delete: { operationId: 'deleteThing' } },
  '/things/{id}/parts/{partId}': { get: { operationId: 'getPart' } },
  '/health': { get: {} },
  '/years/{year}/close': { post: { operationId: 'closeYear', parameters: [{ name: 'year', in: 'path', schema: { type: 'integer' } }] } },
  '/years/{year}/{id}': { post: { operationId: 'markYear', parameters: [{ name: 'year', in: 'path', schema: { type: 'integer' } }, { name: 'id', in: 'path', schema: { type: 'string' } }] } },
});

describe('enumerateIdBearingOperations', () => {
  it('returns only implemented operations whose path has a path parameter, sorted', () => {
    const implemented = new Set(['getPart', 'listThings', 'getThing', 'createThing']);
    expect(enumerateIdBearingOperations(SYNTHETIC, implemented)).toEqual(['getPart', 'getThing']);
  });

  it('does not take a calendar value in the path for the id of an object: an integer parameter names no object of another tenant', () => {
    expect(enumerateIdBearingOperations(SYNTHETIC, new Set(['closeYear']))).toEqual([]);
    expect(enumerateIdBearingOperations(SYNTHETIC, new Set(['closeYear', 'markYear']))).toEqual(['markYear']);
    const real = loadOpenApi();
    expect(enumerateIdBearingOperations(real, new Set(['closeFiscalYear', 'reopenFiscalYear', 'listFiscalYears']))).toEqual([]);
  });

  it('ignores id-bearing operations that are not implemented', () => {
    expect(enumerateIdBearingOperations(SYNTHETIC, new Set(['listThings']))).toEqual([]);
    expect(enumerateIdBearingOperations(SYNTHETIC, new Set())).toEqual([]);
  });

  it('refuses an implemented operation that the document does not define', () => {
    expect(() => enumerateIdBearingOperations(SYNTHETIC, new Set(['getUnicorn']))).toThrow('getUnicorn');
  });

  it('finds the real organization unit read operations', () => {
    const real = loadOpenApi();
    const implemented = new Set(['get_resources_organization_unit', 'get_resources_organization_unit_id']);
    expect(enumerateIdBearingOperations(real, implemented)).toEqual(['get_resources_organization_unit_id']);
    expect(operationPath(real, 'get_resources_organization_unit')).toBe('/resources/organization_unit');
    expect(operationPath(real, 'get_resources_organization_unit_id')).toBe('/resources/organization_unit/{id}');
  });
});

describe('operationPath and fillPath', () => {
  it('names a missing operation', () => {
    expect(() => operationPath(SYNTHETIC, 'getUnicorn')).toThrow('getUnicorn');
  });

  it('falls back to "METHOD /path" for operations without an operationId', () => {
    expect(operationPath(SYNTHETIC, 'GET /health')).toBe('/health');
  });

  it('fills the path parameter with an encoded id', () => {
    expect(fillPath('/things/{id}', 'a b/c')).toBe('/things/a%20b%2Fc');
  });
});
