import { generateDart } from '../src/generate-dart';
import type { DartFiles } from '../src/generate-dart';
import { listOperations } from '../src/openapi-document';
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
    // A body that is not offered as JSON (a file upload) has no typed method: the table says which operations those are.
    const uploads = listOperations(loadRealDocument()).filter((entry) => {
      const body = (entry.operation as { requestBody?: { content?: Record<string, unknown> } }).requestBody;
      return body !== undefined && body.content?.['application/json'] === undefined;
    });
    expect(uploads.length).toBeGreaterThan(0);
    expect(methods).toHaveLength(Object.keys(OPERATIONS).length - uploads.length);
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

describe('generateDart: the response classes and the sample responses (AC-ST-KERNEL-030-2)', () => {
  const ITEM = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'version'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      version: { type: 'integer', minimum: 1 },
      label: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
      tags: { type: 'array', items: { type: 'string' } },
      scores: { type: 'object', additionalProperties: { type: 'integer' } },
      note: { type: 'string', nullable: true },
      owner: { $ref: '#/components/schemas/Owner' },
      history: { type: 'array', items: { $ref: '#/components/schemas/Owner' } },
      detail: { type: 'object', required: ['street'], properties: { street: { type: 'string' }, 'zip-code': { type: 'string' } } },
      choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      free: { type: 'object' },
      when: { type: 'string', format: 'date-time' },
      class: { type: 'string' },
      extra: { type: 'string' },
      parent: { $ref: '#/components/schemas/Item' },
    },
  };
  const PAGE = { type: 'object', required: ['items', 'next_cursor'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Item' } }, next_cursor: { type: ['string', 'null'] } } };
  const MERGED = { allOf: [{ $ref: '#/components/schemas/Owner' }, { type: 'object', required: ['since'], properties: { since: { type: 'string', format: 'date' } } }] };
  const OWNER = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, label: { type: 'string' } } };

  function responses(): DartFiles {
    return generateDart(
      documentWith(
        {
          '/items': {
            get: { operationId: 'listItems', 'x-permission': 'item.read', responses: jsonResponse({ $ref: '#/components/schemas/Page' }) },
            post: { operationId: 'createItem', 'x-permission': 'item.write', responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } },
          },
          '/items/{id}/owner': { get: { operationId: 'getOwner', 'x-permission': 'item.read', responses: jsonResponse({ $ref: '#/components/schemas/Merged' }) } },
          '/items/names': { get: { operationId: 'listNames', 'x-permission': 'item.read', responses: jsonResponse({ type: 'array', items: { type: 'string' } }) } },
          '/items/inline': { get: { operationId: 'getInline', 'x-permission': 'item.read', responses: jsonResponse({ type: 'object', required: ['count'], properties: { count: { type: 'integer' } } }) } },
          '/items/nothing': { delete: { operationId: 'deleteItem', 'x-permission': 'item.write', responses: { '204': { description: 'gone' } } } },
          '/items/text': { get: { operationId: 'getText', 'x-permission': 'item.read', responses: { '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } } } } },
        },
        { Item: ITEM, Page: PAGE, Merged: MERGED, Owner: OWNER },
      ),
    );
  }

  it('reads each response strictly: required members, nullable and optional members, lists and maps, and closes an object that the contract closes', () => {
    const text = responses().responses;
    expect(text).toContain('final class ItemResponse implements ResponseModel');
    expect(text).toContain("id: requiredField(map, path, 'id', asString),");
    expect(text).toContain("version: requiredField(map, path, 'version', asInt),");
    expect(text).toContain("label: optionalField(map, path, 'label', nullable(asString)),");
    expect(text).toContain("tags: optionalField(map, path, 'tags', asList(asString)),");
    expect(text).toContain("scores: optionalField(map, path, 'scores', asMap(asInt)),");
    expect(text).toContain("owner: optionalField(map, path, 'owner', OwnerResponse.fromJson),");
    expect(text).toContain("history: optionalField(map, path, 'history', asList(OwnerResponse.fromJson)),");
    expect(text).toContain("choice: optionalField(map, path, 'choice', asAny),");
    expect(text).toContain("free: optionalField(map, path, 'free', asObject),");
    expect(text).toContain("parent: optionalField(map, path, 'parent', ItemResponse.fromJson),");
    expect(text).toContain("strict: true),");
    expect(text).toContain("strict: false),");
  });

  it('names a nested object after its owner, avoids reserved words and a member called extra, and keeps the wire names when writing back', () => {
    const text = responses().responses;
    expect(text).toContain('final class ItemResponseDetail implements ResponseModel');
    expect(text).toContain("'zip-code'");
    expect(text).toContain('final String? class_;');
    expect(text).toContain('final String? extra_;');
    expect(text).toContain("if (class_ != null) 'class': class_,");
    expect(text).toContain("'id': id,");
    expect(text).toContain("if (owner != null) 'owner': owner!.toJson(),");
    expect(text).toContain("if (history != null) 'history': history!.map((e0) => e0.toJson()).toList(),");
    expect(text).toContain('...extra,');
  });

  it('gives each operation with a JSON answer a decoder, whichever 2xx it answers with, and none to the others', () => {
    const text = responses().responses;
    expect(text).toContain("'listItems': PageResponse.fromJson,");
    expect(text).toContain("'createItem': ItemResponse.fromJson,");
    expect(text).toContain("'getOwner': MergedResponse.fromJson,");
    expect(text).toContain("'listNames': asList(asString),");
    expect(text).toContain("'getInline': GetInlineResponse.fromJson,");
    expect(text).not.toContain("'deleteItem'");
    expect(text).not.toContain("'getText'");
  });

  it('merges the parts of an allOf into one class', () => {
    const text = responses().responses;
    expect(text).toMatch(/final class MergedResponse implements ResponseModel \{\s*const MergedResponse\(\{\s*required this\.id,\s*required this\.since,/);
  });

  it('writes one sample response for each operation that satisfies the contract, with every member and the simplest value of its type', () => {
    const fixtures = JSON.parse(responses().responseFixtures) as Record<string, Record<string, unknown>>;
    expect(Object.keys(fixtures)).toEqual(['createItem', 'getInline', 'getOwner', 'listItems', 'listNames']);
    expect(fixtures.getInline).toEqual({ count: 100 });
    expect(fixtures.listNames).toEqual(['sample']);
    expect(fixtures.getOwner).toEqual({ id: 'sample', label: 'sample', since: '2026-01-01' });
    const item = fixtures.createItem as Record<string, unknown>;
    expect(item).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      version: 1,
      label: 'sample',
      status: 'OPEN',
      tags: ['sample'],
      scores: { key: 100 },
      choice: 'sample',
      free: {},
      when: '2026-01-01T00:00:00Z',
      detail: { street: 'sample', 'zip-code': 'sample' },
    });
    expect((fixtures.listItems as { items: unknown[] }).items).toHaveLength(1);
  });

  it('stops a schema that contains itself, and refuses a response class that would reuse a request class', () => {
    const item = (responses().responseFixtures && JSON.parse(responses().responseFixtures)) as Record<string, { parent?: { parent?: unknown } }>;
    let depth = 0;
    for (let node: { parent?: unknown } | undefined = item.createItem; node !== undefined; node = node.parent as { parent?: unknown } | undefined) depth += 1;
    expect(depth).toBeGreaterThan(1);
    expect(depth).toBeLessThan(20);
    const clash = documentWith(
      {
        '/units': {
          post: {
            operationId: 'createUnit',
            'x-permission': 'unit.write',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/UnitResponse' } } } },
            responses: jsonResponse({ $ref: '#/components/schemas/Unit' }),
          },
        },
      },
      { Unit: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, UnitResponse: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } },
    );
    expect(() => generateDart(clash)).toThrow('a response class would reuse the request class UnitResponse');
  });

  it('refuses two members that would get the same Dart name in a response', () => {
    const clash = documentWith(
      { '/units': { get: { operationId: 'getUnit', 'x-permission': 'unit.read', responses: jsonResponse({ $ref: '#/components/schemas/Unit' }) } } },
      { Unit: { type: 'object', properties: { 'unit-id': { type: 'string' }, unit_id: { type: 'string' } } } },
    );
    expect(() => generateDart(clash)).toThrow('would both be named');
  });

  it('generates the real contract: a decoder and a sample for every operation that answers with JSON', () => {
    const real = generateDart(loadRealDocument());
    const fixtures = JSON.parse(real.responseFixtures) as Record<string, unknown>;
    const decoders = [...real.responses.matchAll(/^ {2}'([^']+)': .+,$/gm)].map((match) => match[1]);
    expect(Object.keys(fixtures).length).toBeGreaterThan(800);
    expect(decoders.sort()).toEqual(Object.keys(fixtures).sort());
  });
});
