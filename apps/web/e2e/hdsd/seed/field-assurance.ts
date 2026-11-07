import type { SeedContext } from './context.ts';
import { seedAst } from './field-assurance/ast.ts';
import { seedAud } from './field-assurance/aud.ts';
import { seedIss } from './field-assurance/iss.ts';
import { seedLnd } from './field-assurance/lnd.ts';
import { seedPmt } from './field-assurance/pmt.ts';
import { seedQms } from './field-assurance/qms.ts';

/**
 * Group `field-assurance`: what happens on the ground and what the inspectors say about it, for the three projects of the guide (and what the earlier
 * groups added): permits (PMT), land clearance (LND), site diaries and quality (QMS), issues with their SLAs (ISS), handovers, assets and warranties (AST), and
 * inspections and audits with their recommendations (AUD). Builds on `base` (projects) and the delivery chain (contracts) by querying what exists.
 * The order follows the business: permits first (the gates they set must already be satisfied when a handover or an acceptance comes), then land, quality,
 * handover, issues and the audit of it all.
 */
export async function seedFieldAssurance(ctx: SeedContext): Promise<void> {
  await seedPmt(ctx);
  await seedLnd(ctx);
  await seedQms(ctx);
  await seedAst(ctx);
  await seedIss(ctx);
  await seedAud(ctx);
}
