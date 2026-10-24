import { generateDart } from '../src/generate-dart';
import type { OpenApiDocument } from '../src/openapi-document';
import { OPERATIONS } from '../src/operations.generated';
import { documentWith, jsonResponse, loadRealDocument } from './fixtures';

const UNIT_CREATE = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'parent_id'],
  properties: {
    code: { type: 'string', pattern: '^[A-Z]+$' },
    parent_id: { type: 'string', format: 'uuid' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    active: { type: 'boolean' },
    kind: { type: 'string', enum: ['A', 'B'] },
    tags: { type: 'array', items: { type: 'string' } },
    owner: { $ref: '#/components/schemas/Owner' },
    owners: { type: 'array', items: { $ref: '#/components/schemas/Owner' } },
    extra: { type: 'object', additionalProperties: true },
    scores: { type: 'object', additionalProperties: { type: 'integer' } },
    address: { type: 'object', required: ['street'], properties: { street: { type: 'string' }, 'zip-code': { type: 'string' } } },
    class: { type: 'string' },
    note: { type: 'string', nullable: true },
  },
};

const OWNER = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, label: { type: 'string' } } };

function document(): OpenApiDocument {
  return documentWith(
    {
      '/units': {
        post: {
          operationId: 'createUnit',
          'x-permission': 'unit.write',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/UnitCreate' } } } },
          responses: jsonResponse({ type: 'object' }),
        },
        get: { operationId: 'get_resources_unit', 'x-permission': 'unit.read', responses: jsonResponse({ type: 'object' }) },
      },
      '/units/{unitId}/move': {
        post: {
          operationId: 'moveUnit',
          'x-permission': 'unit.write',
          parameters: [
            { name: 'unitId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['to'], properties: { to: { type: 'string' } } } } } },
          responses: jsonResponse({ type: 'object' }),
        },
      },
      '/units/{unitId}/submit': {
        post: { operationId: 'submitUnit', 'x-permission': 'unit.write', parameters: [{ name: 'unitId', in: 'path', required: true, schema: { type: 'string' } }], responses: jsonResponse({ type: 'object' }) },
      },
      '/assets': {
        post: {
          operationId: 'uploadAsset',
          'x-permission': 'asset.write',
          requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: jsonResponse({ type: 'object' }),
        },
      },
    },
    { UnitCreate: UNIT_CREATE, Owner: OWNER },
  );
}

describe('generateDart', () => {
  const files = generateDart(document());

  it('describes every operation for the client', () => {
    expect(files.operations).toContain("'createUnit': OperationDescriptor(method: 'POST', path: '/units', versioned: false, stepUp: null, permission: 'unit.write')");
    expect(files.operations).toContain("'moveUnit': OperationDescriptor(method: 'POST', path: '/units/{unitId}/move', versioned: true, stepUp: null, permission: 'unit.write')");
    expect(files.operations).toContain("'get_resources_unit': OperationDescriptor(method: 'GET'");
  });

  it('generates a request class with typed fields, required constructor parameters and nullable optional fields', () => {
    const text = files.requests;
    expect(text).toContain('final class UnitCreate implements RequestModel');
    expect(text).toMatch(/const UnitCreate\(\{\s*required this\.code,\s*required this\.parentId,/);
    expect(text).toContain('final String code;');
    expect(text).toContain('final String parentId;');
    expect(text).toContain('final int? count;');
    expect(text).toContain('final num? ratio;');
    expect(text).toContain('final bool? active;');
    expect(text).toContain('final String? kind;');
    expect(text).toContain('final List<String>? tags;');
    expect(text).toContain('final Owner? owner;');
    expect(text).toContain('final List<Owner>? owners;');
    expect(text).toContain('final Map<String, Object?>? extra;');
    expect(text).toContain('final Map<String, int>? scores;');
    expect(text).toContain('final String? note;');
  });

  it('keeps the wire names in toJson and omits optional fields that are null', () => {
    const text = files.requests;
    expect(text).toContain("'code': code,");
    expect(text).toContain("'parent_id': parentId,");
    expect(text).toContain("if (count != null) 'count': count,");
    expect(text).toContain("if (address != null) 'address': address,");
  });

  it('turns an inline object property into its own class and avoids Dart reserved words', () => {
    const text = files.requests;
    expect(text).toContain('final class UnitCreateAddress implements RequestModel');
    expect(text).toContain("'zip-code'");
    expect(text).toContain('final UnitCreateAddress? address;');
    expect(text).toContain('final String? class_;');
    expect(text).toContain("if (class_ != null) 'class': class_,");
  });

  it('names an inline body class after its operation', () => {
    expect(files.requests).toContain('final class MoveUnitRequest implements RequestModel');
  });

  it('generates one typed method per operation: body, path parameters, version and attempt for commands', () => {
    const text = files.commands;
    expect(text).toContain('extension MachvonOperations on MachvonApiClient {');
    expect(text).toContain('Future<Object?> createUnit(UnitCreate body, {CommandAttempt? attempt})');
    expect(text).toContain('Future<Object?> moveUnit(MoveUnitRequest body, {required String unitId, required int ifMatchVersion, CommandAttempt? attempt})');
    expect(text).toContain('Future<Object?> submitUnit({required String unitId, CommandAttempt? attempt})');
    expect(text).toContain('Future<Object?> getResourcesUnit({Map<String, Object?>? query})');
  });

  it('leaves out operations whose body is not JSON, as the TypeScript client does', () => {
    expect(files.commands).not.toContain('uploadAsset');
    expect(files.operations).toContain("'uploadAsset'");
  });

  it('is deterministic and ASCII only', () => {
    const again = generateDart(document());
    expect(again).toEqual(files);
    for (const text of Object.values(files)) expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
  });

  it('refuses two properties that would get the same Dart name', () => {
    const clash = documentWith(
      {
        '/x': { post: { operationId: 'x', 'x-permission': 'p', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Clash' } } } }, responses: jsonResponse({ type: 'object' }) } },
      },
      { Clash: { type: 'object', properties: { parent_id: { type: 'string' }, parentId: { type: 'string' } } } },
    );
    expect(() => generateDart(clash)).toThrow(/parentId/);
  });
});

describe('generateDart on the real contract', () => {
  const real = generateDart(loadRealDocument());

  it('has a descriptor for every operation and one method for every operation with a JSON or no body', () => {
    const descriptors = real.operations.match(/OperationDescriptor\(method:/g) ?? [];
    expect(descriptors).toHaveLength(Object.keys(OPERATIONS).length);
    const methods = real.commands.match(/^ {2}Future<Object\?> /gm) ?? [];
    expect(methods.length).toBeGreaterThan(Object.keys(OPERATIONS).length - 7);
    expect(methods.length).toBeLessThan(Object.keys(OPERATIONS).length);
  });

  it('maps a known request body to a typed class', () => {
    expect(real.requests).toContain('final class OrgUnitCreate implements RequestModel');
    expect(real.requests).toContain('final String parentId;');
    expect(real.commands).toContain('createOrganizationUnit(OrgUnitCreate body');
  });

  it('never produces the same class name twice', () => {
    const names = [...real.requests.matchAll(/^final class (\w+) implements RequestModel/gm)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(300);
  });
});
