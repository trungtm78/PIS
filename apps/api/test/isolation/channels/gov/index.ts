import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { DIRECTIVE_OPERATIONS, DIRECTIVE_SNAPSHOT_TABLES, DIRECTIVE_SPECS, seedDirective } from './directive';
import { EGP_OPERATIONS, EGP_SNAPSHOT_TABLES, EGP_SPECS, seedEgp } from './egp';
import { GOVRULE_OPERATIONS, GOVRULE_SNAPSHOT_TABLES, GOVRULE_SPECS, seedGovrule } from './govrule';
import { HOME_OPERATIONS, HOME_SNAPSHOT_TABLES, seedHome } from './home';
import { PAYCTL_OPERATIONS, PAYCTL_SNAPSHOT_TABLES, PAYCTL_SPECS, seedPayctl } from './payctl';
import { RESERVE_OPERATIONS, RESERVE_SNAPSHOT_TABLES, RESERVE_SPECS, seedReserve } from './reserve';
import type { SeedContext } from './support';
import { WORKFLOW_OPERATIONS, WORKFLOW_SNAPSHOT_TABLES, WORKFLOW_SPECS, seedWorkflow } from './workflow';

/** The foreign-id cases of the operations the governance deepening added. */
export const GOVERNANCE_SPECS: readonly ForeignAttemptSpec[] = [
  ...RESERVE_SPECS,
  ...DIRECTIVE_SPECS,
  ...GOVRULE_SPECS,
  ...PAYCTL_SPECS,
  ...WORKFLOW_SPECS,
  ...EGP_SPECS,
];

/** Every operation of these controllers: the test role of the suite holds the permission of each. */
export const GOVERNANCE_OPERATIONS: readonly string[] = [
  ...RESERVE_OPERATIONS,
  ...DIRECTIVE_OPERATIONS,
  ...GOVRULE_OPERATIONS,
  ...PAYCTL_OPERATIONS,
  ...WORKFLOW_OPERATIONS,
  ...EGP_OPERATIONS,
  ...HOME_OPERATIONS,
];

/** The tables the seeds fill that the snapshot reads, so a foreign command that changed one of them is seen. */
export const GOVERNANCE_SNAPSHOT_TABLES: readonly string[] = [
  ...new Set([
    ...RESERVE_SNAPSHOT_TABLES,
    ...DIRECTIVE_SNAPSHOT_TABLES,
    ...GOVRULE_SNAPSHOT_TABLES,
    ...PAYCTL_SNAPSHOT_TABLES,
    ...WORKFLOW_SNAPSHOT_TABLES,
    ...EGP_SNAPSHOT_TABLES,
    ...HOME_SNAPSHOT_TABLES,
  ]),
];

/** Seeds the rows of every fragment for the tenant of the context, in the transaction of the seed of the suite. */
export async function seedGovernance(client: Client, context: SeedContext): Promise<void> {
  await seedReserve(client, context);
  await seedDirective(client, context);
  await seedGovrule(client, context);
  await seedPayctl(client, context);
  await seedWorkflow(client, context);
  await seedEgp(client, context);
  await seedHome(client, context);
}
