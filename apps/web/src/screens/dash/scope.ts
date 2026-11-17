import type { SessionTenant } from '../../session/SessionContext';

/** The name of a tenant without tone marks, case or punctuation: 'UBND tỉnh Cà Mau' becomes 'ubnd tinh ca mau'. */
function plain(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The names the People's Committee of the province goes by; a department, a commune or a company that only has "Cà Mau" in its name is another tenant. */
const PROVINCE_NAMES: ReadonlySet<string> = new Set(['ca mau', 'tinh ca mau', 'ubnd tinh ca mau', 'uy ban nhan dan tinh ca mau']);

/**
 * The dashboard is the leader home of the province of Cà Mau: its projects, units and tasks are that province's. The session knows a tenant by its id and its name
 * only, and the id differs from one installation to the next, so the whole name decides; every other tenant keeps the executive overview it had.
 */
export function isCaMauTenant(tenant: Pick<SessionTenant, 'name'> | undefined): boolean {
  return tenant !== undefined && PROVINCE_NAMES.has(plain(tenant.name));
}
