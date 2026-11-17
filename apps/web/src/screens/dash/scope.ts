import type { SessionTenant } from '../../session/SessionContext';

/** The name of a tenant without tone marks, case or punctuation: 'UBND tỉnh Cà Mau' and 'Ủy ban nhân dân tỉnh Cà Mau' both hold 'ca mau'. */
function plain(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The dashboard is the leader home of the province of Cà Mau: its projects, units and tasks are that province's. The session knows a
 * tenant by its id and its name only, so the name decides; every other tenant keeps the executive overview it had.
 */
export function isCaMauTenant(tenant: Pick<SessionTenant, 'name'> | undefined): boolean {
  return tenant !== undefined && /(^| )ca mau( |$)/.test(plain(tenant.name));
}
