import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOpenApi } from '../isolation/test-app';
import { assertNotRefusedForPermission, assertRefusedForPermission, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { UatWorld } from './uat-world';

/**
 * The permission matrix of the enterprise areas (IND, RPT, DIR, HPM, EBS, HUB, INT and the enterprise-only routes), one case for each operation of the design that a person's token reaches: the holder of
 * exactly the permission the design names (`x-permission` of openapi.json) gets past the permission check, and a member who holds every other permission of these areas does not. The answer of the
 * holder may still be a refusal of the command itself (the empty body, an id that names nothing): the case is about the door, not the command. The whole enterprise edition is mounted over a real database
 * (the same application the stack serves), with the test stand-in for authentication only. The cases are named by the ids of docs/uat/<area>/uat.json.
 */
jest.setTimeout(600_000);

interface Op {
  id: string;
  module: string;
  operationId: string;
  method: string;
  path: string;
  permission: string;
}

const ops = JSON.parse(readFileSync(join(__dirname, 'enterprise-uat-ops.json'), 'utf8')) as Op[];
const permissions = [...new Set(ops.map((op) => op.permission))].sort();

/** The id every path parameter takes: a well-formed id that names nothing, so that a holder is answered by the command and not by the door. */
const urlOf = (op: Op): string => op.path.replace(/\{[A-Za-z]+\}/g, () => randomUUID());
/** Who holds exactly one permission, and who holds every other permission of the areas. */
const holderOf = (permission: string): string => `holder ${permission}`;
const everyoneElseOf = (permission: string): string => `everyone but ${permission}`;

describe('the permission matrix of the enterprise areas (UAT)', () => {
  const world = new UatWorld();

  beforeAll(async () => {
    const personas: Record<string, string[]> = {};
    for (const permission of permissions) {
      personas[holderOf(permission)] = [permission];
      personas[everyoneElseOf(permission)] = permissions.filter((other) => other !== permission);
    }
    await world.start(personas);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  const asked = (op: Op, persona: string): Promise<Reply> => world.as(persona, op.method, urlOf(op), { body: {} });

  it('completeness: every operation of the areas that the design names is in the table of the cases, so that a new operation cannot join without a case', () => {
    const doc = loadOpenApi();
    const found = new Map<string, string | null>();
    for (const methods of Object.values(doc.paths)) for (const operation of Object.values(methods as Record<string, { operationId?: string; 'x-permission'?: string }>)) if (operation.operationId !== undefined) found.set(operation.operationId, operation['x-permission'] ?? null);
    for (const op of ops) expect([op.operationId, found.get(op.operationId)]).toEqual([op.operationId, op.permission]);
    expect(new Set(ops.map((op) => op.id)).size).toBe(ops.length);
    // Every operation the areas mount in the enterprise edition (the design names it under the tag of the area) is in the table.
    const tagged = new Set(ops.map((op) => op.operationId));
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const operation of Object.values(methods as Record<string, { operationId?: string; tags?: string[] }>)) {
        if (operation.operationId === undefined || path.startsWith('/open/v1/')) continue;
        if (['IND', 'RPT', 'DIR', 'HPM', 'EBS', 'HUB', 'INT'].includes(operation.tags?.[0] ?? '')) expect([operation.operationId, tagged.has(operation.operationId)]).toEqual([operation.operationId, true]);
      }
    }
  });

  it('negative control: the checks of this suite can go red: a refusal that is not a permission refusal, a missing route and a wrong holder are all caught (negative control)', () => {
    expectCheckFails(() => assertRefusedForPermission({ status: 200, json: {} }));
    expectCheckFails(() => assertRefusedForPermission({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } }));
    expectCheckFails(() => assertNotRefusedForPermission({ status: 403, json: { code: 'PERMISSION_DENIED' } }, true));
    expectCheckFails(() => assertNotRefusedForPermission({ status: 404, json: {} }, true));
    expectCheckFails(() => assertNotRefusedForPermission({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } }, false));
    expectCheckFails(() => assertNotRefusedForPermission({ status: 500, json: {} }, true));
  });

  for (const op of ops) {
    it(`${op.id} ${op.operationId} (${op.method} ${op.path}): the holder of ${op.permission} gets past the door, a member with every other permission of the areas is refused with 403`, async () => {
      // A route that names no object in its path exists for the holder: a 404 there would be a dead route (an enterprise route that answers not found to everybody), never an object that is missing.
      assertNotRefusedForPermission(await asked(op, holderOf(op.permission)), /\{/.test(op.path));
      assertRefusedForPermission(await asked(op, everyoneElseOf(op.permission)));
    });
  }
});
