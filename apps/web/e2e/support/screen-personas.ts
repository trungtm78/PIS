import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The persona of the screen-contract check that holds every right to read and none to change (UAT cases UI-<SCREEN>: "no action outside the permission").
 * It is a user of the browser only: it signs the API requests as the owner of the stack (the same membership, so every screen has its data), while the
 * session of the web application lists only the reading rights. A screen that shows a control for an action the person has no right to is then a defect of the
 * screen, and the server has nothing to do with the verdict (the server side of the same rule is the authorization suites).
 */
export const READER_KEY = 'uiReader';
/** The right to search, which every member holds; the rights named `*.self` (session, profile, notification) are held for himself or herself and are read from the contract. */
export const PERSONAL_PERMISSIONS: readonly string[] = ['search.use'];

const OPENAPI = fileURLToPath(new URL('../../../../Design/MACHVON_Design/03_Engineering/openapi.json', import.meta.url));

interface OpenApiDocument {
  paths: Record<string, Record<string, { 'x-permission'?: string }>>;
}

/** Every right that the contract names with the suffix `.read`, plus the personal ones (`*.self`, search) that every member holds: what a person who may look at everything and change nothing of the tenant holds. */
export function readerPermissions(openapiText: string = readFileSync(OPENAPI, 'utf8')): string[] {
  const document = JSON.parse(openapiText) as OpenApiDocument;
  const rights = new Set<string>(PERSONAL_PERMISSIONS);
  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(operations)) {
      const permission = operation['x-permission'];
      if (typeof permission === 'string' && (permission.endsWith('.read') || permission.endsWith('.self'))) rights.add(permission);
    }
  }
  return [...rights].sort();
}

/** The development users of the browser: the fixture users of the stack and the reader persona, which borrows the membership of the owner. */
export function withReaderPersona<T extends { key: string; membershipId: string; displayName: string }>(users: readonly T[], permissions: readonly string[] = readerPermissions()): Array<T | { key: string; displayName: string; membershipId: string; permissions: readonly string[] }> {
  const owner = users.find((user) => user.key === 'owner');
  if (owner === undefined) throw new Error('the fixture users have no owner: the reader persona needs its membership');
  return [...users, { key: READER_KEY, displayName: 'Người chỉ xem', membershipId: owner.membershipId, permissions }];
}
