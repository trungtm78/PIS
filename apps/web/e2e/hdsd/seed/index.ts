import { seedBase } from './base.ts';
import { seedCapital } from './capital.ts';
import type { SeedContext } from './context.ts';
import { seedFieldAssurance } from './field-assurance.ts';
import { seedIntelligence } from './intelligence.ts';
import { applyClipPlan } from './clip/plan.ts';
import { ensureDoaMatrix } from './clip/doa.ts';
import { seedClipFeed } from './clip/public-feed.ts';
import { seedClipEnterpriseReports } from './clip/enterprise-reports.ts';
import { seedClipBi } from './clip/public-bi.ts';
import { seedClipPayments } from './clip/public-payments.ts';
import { seedClipContracts } from './clip/public-contracts.ts';
import { seedClipAlerts } from './clip/public-alerts.ts';
import { seedClipEnterpriseAlertTriage, seedClipEnterpriseAlerts } from './clip/enterprise-alerts.ts';
import { seedClipContractorPortal } from './clip/contractor-portal.ts';
import { seedClipEnterpriseAppraisal } from './clip/enterprise-appraisal.ts';
import { seedClipEnterpriseNarrative, seedClipEnterpriseProjectDocs } from './clip/enterprise-records.ts';
import { seedClipEnterpriseEquipment } from './clip/enterprise-equipment.ts';
import { seedClipEnterpriseSnapshot } from './clip/enterprise-snapshot.ts';
import { seedClipEnterpriseCrosscheck } from './clip/enterprise-crosscheck.ts';
import { seedClipEnterpriseCapitalPrior } from './clip/enterprise-capital-prior.ts';
import { seedClipEnterpriseSnapshotPrior } from './clip/enterprise-snapshot-prior.ts';
import { seedClipEnterpriseBi, seedClipEnterpriseCapital, seedClipEnterpriseCapitalAdjust, seedClipEnterpriseDocuments } from './clip/enterprise-more.ts';
import { seedClipEnterpriseDirectives, seedMeetings, seedClipEnterpriseEbs, seedClipEnterpriseFunding, seedClipEnterpriseProjects } from './clip/enterprise.ts';
import { seedClipDisbursement } from './clip/public-dis.ts';
import { seedClipCommittee } from './clip/public-committee.ts';
import { seedClipExtras } from './clip/public-extras.ts';
import { seedClipEgp } from './clip/public-egp.ts';
import { seedClipProcurement, seedClipWorkflow } from './clip/public-procurement.ts';
import { seedDoc } from './platform-records/doc.ts';
import { seedProcurementFinance } from './procurement-finance.ts';

/**
 * The ordered registry of the groups of seed data. A group builds on the ones before it by QUERYING what exists (list endpoints), never by ids
 * written in the code. To add a group: write `<group>.ts` exporting `seed<Group>(ctx)`, import it here and append a line to GROUPS (keep the order
 * of dependencies: `base` and `capital` come first). The runner (run.ts) and the Playwright spec (04-du-lieu.hdsd.ts) both run the registry.
 */
export interface SeedGroup {
  name: string;
  seed: (ctx: SeedContext) => Promise<void>;
}

export const GROUPS: SeedGroup[] = [
  { name: 'base', seed: seedBase },
  { name: 'capital', seed: seedCapital },
  // -- append the groups of the other agents below this line, one line each --
  { name: 'field-assurance', seed: seedFieldAssurance },
  { name: 'procurement-finance', seed: seedProcurementFinance },
  { name: 'intelligence', seed: seedIntelligence },
  { name: 'clip-public-documents', seed: async (ctx) => { await ctx.step('ADM', 'delegation of authority matrix', () => ensureDoaMatrix(ctx)); try { await seedDoc(ctx); } catch (error) { ctx.warn(`the document seed of the guide stopped: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`); } } },
  { name: 'clip-public-procurement', seed: seedClipProcurement },
  { name: 'clip-public-contracts', seed: seedClipContracts },
  { name: 'clip-public-payments', seed: seedClipPayments },
  { name: 'clip-public-workflow', seed: seedClipWorkflow },
  { name: 'clip-public-alerts', seed: seedClipAlerts },
  { name: 'clip-public-egp', seed: seedClipEgp },
  { name: 'clip-public-disbursement', seed: seedClipDisbursement },
  { name: 'clip-public-feed', seed: seedClipFeed },
  { name: 'clip-public-bi', seed: seedClipBi },
  { name: 'clip-public-directives', seed: seedMeetings },
  { name: 'clip-public-committee', seed: seedClipCommittee },
  { name: 'clip-public-extras', seed: seedClipExtras },
  { name: 'clip-public-contractor-portal', seed: seedClipContractorPortal },
  { name: 'clip-ent-projects', seed: seedClipEnterpriseProjects },
  { name: 'clip-ent-capital', seed: seedClipEnterpriseCapital },
  { name: 'clip-ent-funding', seed: seedClipEnterpriseFunding },
  { name: 'clip-ent-directives', seed: seedClipEnterpriseDirectives },
  { name: 'clip-ent-ebs', seed: seedClipEnterpriseEbs },
  { name: 'clip-ent-reports', seed: seedClipEnterpriseReports },
  { name: 'clip-ent-documents', seed: seedClipEnterpriseDocuments },
  { name: 'clip-ent-procurement', seed: seedClipProcurement },
  { name: 'clip-ent-contracts', seed: seedClipContracts },
  { name: 'clip-ent-alerts', seed: seedClipEnterpriseAlerts },
  { name: 'clip-ent-equipment', seed: seedClipEnterpriseEquipment },
  { name: 'clip-ent-workflow', seed: seedClipWorkflow },
  { name: 'clip-ent-disbursement', seed: seedClipDisbursement },
  { name: 'clip-ent-snapshot', seed: seedClipEnterpriseSnapshot },
  { name: 'clip-ent-capital-prior', seed: seedClipEnterpriseCapitalPrior },
  { name: 'clip-ent-snapshot-prior', seed: seedClipEnterpriseSnapshotPrior },
  { name: 'clip-ent-crosscheck', seed: seedClipEnterpriseCrosscheck },
  { name: 'clip-ent-bi', seed: seedClipEnterpriseBi },
  { name: 'clip-ent-alert-triage', seed: seedClipEnterpriseAlertTriage },
  { name: 'clip-ent-capital-adjust', seed: seedClipEnterpriseCapitalAdjust },
  { name: 'clip-ent-appraisal', seed: seedClipEnterpriseAppraisal },
  { name: 'clip-ent-project-docs', seed: seedClipEnterpriseProjectDocs },
  { name: 'clip-ent-narrative', seed: seedClipEnterpriseNarrative },
  { name: 'clip-ent-contractor-portal', seed: seedClipContractorPortal },
];

export interface SeedSummary {
  groups: Array<{ name: string; ms: number; ledger: string }>;
  warnings: string[];
  calls: number;
  ms: number;
}

/**
 * Runs the named groups (all of them when `names` is undefined) in the order of the registry, whatever the order of the names.
 * The ledger of each group is written when the group ends, even when it failed (what it made up to there is on it).
 */
export async function runSeed(ctx: SeedContext, names?: readonly string[]): Promise<SeedSummary> {
  applyClipPlan();
  await ctx.syncClock();
  const known = GROUPS.map((group) => group.name);
  for (const name of names ?? []) if (!known.includes(name)) throw new Error(`unknown seed group "${name}" (known: ${known.join(', ')})`);
  const chosen = GROUPS.filter((group) => names === undefined || names.includes(group.name));
  const started = Date.now();
  const done: SeedSummary['groups'] = [];
  for (const group of chosen) {
    ctx.group = group.name;
    ctx.module = '';
    ctx.log(`seed group ${group.name}`);
    const groupStarted = Date.now();
    try {
      await group.seed(ctx);
    } finally {
      done.push({ name: group.name, ms: Date.now() - groupStarted, ledger: ctx.flushLedger(group.name) });
    }
  }
  return { groups: done, warnings: ctx.warnings, calls: ctx.callCount, ms: Date.now() - started };
}
