import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { ANALYTICS_OPERATIONS, ANALYTICS_SNAPSHOT_TABLES, ANALYTICS_SPECS, seedAnalytics } from './analytics';
import { ASSIST_OPERATIONS, ASSIST_SNAPSHOT_TABLES, ASSIST_SPECS, seedAssist } from './assist';
import { DIRECTIVE_OPERATIONS, DIRECTIVE_SNAPSHOT_TABLES, DIRECTIVE_SPECS, seedDirective } from './directive';
import { EGP_OPERATIONS, EGP_SNAPSHOT_TABLES, EGP_SPECS, seedEgp } from './egp';
import { FEED_OPERATIONS, FEED_SNAPSHOT_TABLES, FEED_SPECS, seedFeed } from './feed';
import { GOV10_OPERATIONS, GOV10_SNAPSHOT_TABLES, GOV10_SPECS, seedGov10 } from './gov10';
import { GOV11A_OPERATIONS, GOV11A_SNAPSHOT_TABLES, GOV11A_SPECS, seedGov11a } from './gov11a';
import { GOVRULE_OPERATIONS, GOVRULE_SNAPSHOT_TABLES, GOVRULE_SPECS, seedGovrule } from './govrule';
import { HOME_OPERATIONS, HOME_SNAPSHOT_TABLES, seedHome } from './home';
import { HUB_OPERATIONS, HUB_SNAPSHOT_TABLES, HUB_SPECS, seedHub } from './hub';
import { MR1_OPERATIONS, MR1_SNAPSHOT_TABLES, MR1_SPECS, seedMr1 } from './mr1';
import { PAYCTL_OPERATIONS, PAYCTL_SNAPSHOT_TABLES, PAYCTL_SPECS, seedPayctl } from './payctl';
import { RATING_OPERATIONS, RATING_SNAPSHOT_TABLES, RATING_SPECS, seedRating } from './rating';
import { RESERVE_OPERATIONS, RESERVE_SNAPSHOT_TABLES, RESERVE_SPECS, seedReserve } from './reserve';
import { LANE_RIGHTS_OPERATIONS } from './rights';
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
  ...RATING_SPECS,
  ...GOV11A_SPECS,
  ...ANALYTICS_SPECS,
  ...MR1_SPECS,
  ...ASSIST_SPECS,
  ...FEED_SPECS,
  ...GOV10_SPECS,
  ...HUB_SPECS,
];

/** Every operation of these controllers: the test role of the suite holds the permission of each. */
export const GOVERNANCE_OPERATIONS: readonly string[] = [
  ...RESERVE_OPERATIONS,
  ...DIRECTIVE_OPERATIONS,
  ...GOVRULE_OPERATIONS,
  ...PAYCTL_OPERATIONS,
  ...WORKFLOW_OPERATIONS,
  ...EGP_OPERATIONS,
  ...RATING_OPERATIONS,
  ...GOV11A_OPERATIONS,
  ...HOME_OPERATIONS,
  ...ANALYTICS_OPERATIONS,
  ...MR1_OPERATIONS,
  ...ASSIST_OPERATIONS,
  ...FEED_OPERATIONS,
  ...GOV10_OPERATIONS,
  ...HUB_OPERATIONS,
  ...LANE_RIGHTS_OPERATIONS,
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
    ...RATING_SNAPSHOT_TABLES,
    ...GOV11A_SNAPSHOT_TABLES,
    ...HOME_SNAPSHOT_TABLES,
    ...ANALYTICS_SNAPSHOT_TABLES,
    ...MR1_SNAPSHOT_TABLES,
    ...ASSIST_SNAPSHOT_TABLES,
    ...FEED_SNAPSHOT_TABLES,
    ...GOV10_SNAPSHOT_TABLES,
    ...HUB_SNAPSHOT_TABLES,
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
  await seedRating(client, context);
  await seedGov11a(client, context);
  await seedHome(client, context);
  await seedAnalytics(client, context);
  await seedMr1(client, context);
  await seedAssist(client, context);
  await seedFeed(client, context);
  await seedGov10(client, context);
  await seedHub(client, context);
}
