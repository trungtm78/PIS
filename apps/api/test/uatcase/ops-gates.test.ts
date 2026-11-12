import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertEvaluator, CollectingTelemetry, SLO_FAST_BURN_ALERT, budgetReport, budgetStatus, minuteOf, reportSlo } from '@machvon/kernel';
import type { AlertRule, BudgetStatus, SliBucket } from '@machvon/kernel';
import { expectCheckFails } from '../uat/uat-kit';
import { REPO_ROOT, editJson, readJson, removeScratch, runChecker, scratchDirectory, scratchInfrastructure, writeText } from './ops-support';

/**
 * The operations cases that the gates of the pipeline decide: the legal gate report (`scripts/cxn-gate.mjs`), the entry gate of the infrastructure components and the data residency policy
 * (`scripts/infra-check.mjs`), the dependency audit with its time-boxed exceptions and the SBOM (`scripts/supply-chain-check.mjs`, `scripts/sbom.mjs`), and the error budget that stops feature releases
 * (`packages/kernel/src/slo.ts` read by `scripts/deploy-gate.mjs`). Each case makes the change it describes, runs the real checker, and reads what the checker says and how it ends.
 */

interface Outcome {
  code: number;
  lines: string[];
}

afterAll(removeScratch);

describe('the checks of this suite can go red (negative control)', () => {
  it('a gate that says it passed while a line still names a problem is refused', () => {
    expectCheckFails(() => assertGreen({ code: 0, lines: ['component powersync may not be used yet: missing restore test'] }));
    expectCheckFails(() => assertGreen({ code: 1, lines: ['1 problem(s)'] }));
  });
});

/** The checker ended with 0 and none of its lines names a violation or a component that may not be used. */
function assertGreen(outcome: Outcome): void {
  if (outcome.code !== 0) throw new Error(`the gate ended with ${String(outcome.code)}: ${outcome.lines.join(' | ')}`);
  const named = outcome.lines.find((line) => /may not be used yet|outside Vietnam|violation\(s\)|problem\(s\)/.test(line));
  if (named !== undefined) throw new Error(`the gate passed but says: ${named}`);
}

/** The checker ended with 1 and one of its lines matches `problem`. */
function assertRed(outcome: Outcome, problem: RegExp): void {
  if (outcome.code !== 1) throw new Error(`the gate ended with ${String(outcome.code)}, expected 1: ${outcome.lines.join(' | ')}`);
  if (!outcome.lines.some((line) => problem.test(line))) throw new Error(`no line matches ${String(problem)}: ${outcome.lines.join(' | ')}`);
}

describe('TC-UAT-PLAN-13 the legal gate report', () => {
  const OWNER = 'Legal owner';
  const confirmed = { id: 'CXN-01', owner: OWNER, status: 'CONFIRMED', confirmed_by: 'Legal reviewer', confirmed_at: '2026-10-01T00:00:00Z', evidence: 'Official letter 12/PC' };
  const open = { id: 'CXN-02', owner: 'Tax owner', status: 'AWAITING_CONFIRMATION', confirmed_by: null, confirmed_at: null, evidence: null };
  const waived = { id: 'CXN-03', owner: OWNER, status: 'WAIVED', waived_by: OWNER, waived_at: '2026-10-02T00:00:00Z', waiver_reason: 'Risk accepted until the decree is issued' };
  const plan = {
    stories: [
      { id: 'ST-A', release: 'R1', cxn: ['CXN-01', 'CXN-03'], acceptance: [] },
      { id: 'ST-B', release: 'R1', cxn: ['CXN-02'], acceptance: [] },
      { id: 'ST-LATER', release: 'R3', cxn: ['CXN-04'], acceptance: [] },
    ],
  };
  const later = { id: 'CXN-04', owner: 'Later owner', status: 'AWAITING_CONFIRMATION', confirmed_by: null, confirmed_at: null, evidence: null };

  function ledgerRoot(ledger: object[], statuses: Record<string, string>): string {
    const root = scratchDirectory('cxn');
    writeText(root, 'plan.json', JSON.stringify(plan));
    writeText(root, 'ledger.json', JSON.stringify(ledger));
    writeText(root, 'status.json', JSON.stringify({ stories: statuses }));
    return root;
  }

  /** The command line of the gate: `report` prints the legal gate report, otherwise it judges the status of the stories. */
  function gate(root: string, report: boolean): Outcome {
    return runChecker<Outcome>(
      `const { main } = await load('cxn-gate.mjs');
       const lines = [];
       const args = ['--plan', join(input.root, 'plan.json'), '--ledger', join(input.root, 'ledger.json'), '--status', join(input.root, 'status.json'), '--locale', 'en', ...(input.report ? ['--report'] : [])];
       return { code: main(args, { log: (line) => lines.push(line) }), lines };`,
      { root, report },
    );
  }

  it('lists every item with owner, evidence and status, refuses DONE for a story with an open item, and closes the window only when every R1 and R2 item is confirmed or waived by its owner', () => {
    const root = ledgerRoot([confirmed, open, waived, later], { 'ST-A': 'DONE', 'ST-B': 'DONE' });
    const report = gate(root, true);
    assertRed(report, /the legal confirmation window stays open: 1 item\(s\).*\(CXN-02\)/);
    expect(report.lines).toContain('CXN-01: owner Legal owner; status CONFIRMED; evidence Official letter 12/PC; gates stories ST-A');
    expect(report.lines).toContain('CXN-02: owner Tax owner; status AWAITING_CONFIRMATION; evidence -; gates stories ST-B');
    expect(report.lines).toContain('CXN-03: owner Legal owner; status WAIVED; evidence Risk accepted until the decree is issued; gates stories ST-A');
    expect(report.lines).toContain('CXN-04: owner Later owner; status AWAITING_CONFIRMATION; evidence -; gates stories -');

    // The story ST-B is DONE while CXN-02 is open: the gate refuses it, naming the story and the item, and does not name the story that rests on settled items.
    const refused = gate(root, false);
    assertRed(refused, /story ST-B is DONE but still rests on legal items nobody confirmed \(CXN-02\)/);
    expect(refused.lines.some((line) => line.includes('ST-A'))).toBe(false);

    // The honest status lets the gate pass, but the window stays open for the item that still gates an R1 story.
    const honest = ledgerRoot([confirmed, open, waived, later], { 'ST-A': 'DONE', 'ST-B': 'DONE_UNCONFIRMED' });
    expect(gate(honest, false).code).toBe(0);
    expect(gate(honest, true).code).toBe(1);

    // A waiver is the named owner's: one made by somebody else is not a waiver, and the window stays open.
    const foreignWaiver = ledgerRoot([confirmed, { ...open, status: 'WAIVED', waived_by: 'Somebody else', waived_at: '2026-10-03T00:00:00Z', waiver_reason: 'Not the owner' }, waived, later], { 'ST-A': 'DONE' });
    assertRed(gate(foreignWaiver, true), /the legal confirmation window stays open: 1 item\(s\).*\(CXN-02\)/);

    // Once the named owner waives the item, the window closes and ST-B may be DONE.
    const settled = ledgerRoot([confirmed, { ...open, status: 'WAIVED', waived_by: 'Tax owner', waived_at: '2026-10-03T00:00:00Z', waiver_reason: 'Risk accepted by the owner' }, waived, later], { 'ST-A': 'DONE', 'ST-B': 'DONE' });
    const closed = gate(settled, true);
    expect(closed.code).toBe(0);
    expect(closed.lines.at(-1)).toBe('the legal confirmation window can close: every item that gates an R1 or R2 story is confirmed or waived by its owner');
    expect(gate(settled, false).code).toBe(0);
  });
});

describe('TC-UAT-NFR-OPERABILITY-01 the entry gate of a component that needs a restore test', () => {
  /** The command line of the infrastructure check, asked to require the component to be entered. */
  function entry(root: string, component: string): Outcome {
    return runChecker<Outcome>(
      `const { main } = await load('infra-check.mjs');
       const lines = [];
       const code = main(['--root', input.root, '--locale', 'en', '--require-entered', input.component], { log: (line) => lines.push(line) });
       return { code, lines };`,
      { root, component },
    );
  }

  /** The state of the first offline slice that needs PowerSync: the component is in use. */
  function inUse(root: string): void {
    editJson<{ state: string }>(root, 'infra/components/powersync.json', (component) => {
      component.state = 'IN_USE';
    });
  }

  it('is red naming the missing "restore test" while the slice is marked done without a record of the restore, and green once the record exists', () => {
    const root = scratchInfrastructure();
    inUse(root);
    const first = entry(root, 'powersync');
    assertRed(first, /component powersync may not be used yet: missing restore test/);
    expect(first.lines).toContain('infra/components/powersync.json: component powersync is in use but has no restore evidence');
    expect(first.lines.some((line) => /missing runbook|missing alert/.test(line))).toBe(false);

    // The record of rebuilding the bucket from the restore, a file of the repository, with the version it was made for.
    writeText(root, 'docs/runbooks/infra/evidence/powersync.md', '# Restore evidence: the storage bucket was rebuilt from the backup\n');
    editJson<{ version: string; restoreEvidence: unknown }>(root, 'infra/components/powersync.json', (component) => {
      component.restoreEvidence = { path: 'docs/runbooks/infra/evidence/powersync.md', verifiedVersion: component.version, restoredAt: '2026-11-12' };
    });
    const second = entry(root, 'powersync');
    expect(second.code).toBe(0);
    expect(second.lines.some((line) => /powersync/.test(line))).toBe(false);
    expect(second.lines.at(-1)).toBe('declarative infrastructure passes every check');
  });

  it('names the runbook and the sync lag alert as well when they are missing, and a restore record for another version is stale', () => {
    const root = scratchInfrastructure();
    inUse(root);
    writeText(root, 'docs/runbooks/infra/powersync.md', '');
    editJson<unknown[]>(root, 'infra/alerts/powersync.json', (rules) => {
      rules.length = 0;
    });
    const lines = entry(root, 'powersync');
    assertRed(lines, /component powersync may not be used yet: missing .*restore test/);
    assertRed(lines, /missing .*alert/);
    const stale = scratchInfrastructure();
    inUse(stale);
    writeText(stale, 'docs/runbooks/infra/evidence/powersync.md', '# Restore evidence\n');
    editJson<{ restoreEvidence: unknown }>(stale, 'infra/components/powersync.json', (component) => {
      component.restoreEvidence = { path: 'docs/runbooks/infra/evidence/powersync.md', verifiedVersion: '0.x', restoredAt: '2026-11-12' };
    });
    assertRed(entry(stale, 'powersync'), /evidence for 0\.x, component 1\.x/);
  });
});

describe('TC-UAT-NFR-LEGAL-01 data residency of the infrastructure', () => {
  const INFRA_CHECK = `const { main } = await load('infra-check.mjs');
    const lines = [];
    const code = main(['--root', input.root, '--locale', 'en'], { log: (line) => lines.push(line) });
    return { code, lines };`;

  const policy = readJson<{ allowedRegions: string[]; secondSiteEnvironments: string[] }>(REPO_ROOT, 'infra/policies/residency.json');
  interface Resource {
    id: string;
    component: string;
    role: string;
    region: string;
    replicaRegion?: string;
  }
  const inventoryOf = (root: string, environment: string): Resource[] => readJson<{ resources: Resource[] }>(root, `infra/environments/${environment}.json`).resources;

  it('is red naming a bucket outside Vietnam that a branch adds, and green on the tree as it is', () => {
    const clean = runChecker<Outcome>(INFRA_CHECK, { root: REPO_ROOT });
    assertGreen(clean);

    const root = scratchInfrastructure();
    editJson<{ resources: Resource[] }>(root, 'infra/environments/production.json', (environment) => {
      environment.resources.push({ id: 'exports-bucket', component: 'object-storage', role: 'primary', region: 'SG-1' });
    });
    const red = runChecker<Outcome>(INFRA_CHECK, { root });
    assertRed(red, /^infra\/environments\/production\.json: resource is outside Vietnam: exports-bucket: region SG-1$/);

    // A replica of a bucket in a foreign region is the same violation, named the same way.
    const replica = scratchInfrastructure();
    editJson<{ resources: Resource[] }>(replica, 'infra/environments/production.json', (environment) => {
      const objects = environment.resources.find((resource) => resource.id === 'objects') as Resource;
      objects.replicaRegion = 'US-EAST-1';
    });
    assertRed(runChecker<Outcome>(INFRA_CHECK, { root: replica }), /outside Vietnam: objects: replicaRegion US-EAST-1/);
  });

  it('puts every resource of the production, staging and dr inventory in a Vietnamese location, and the backup target at a second Vietnamese site', () => {
    for (const environment of policy.secondSiteEnvironments) {
      const inventory = inventoryOf(REPO_ROOT, environment);
      expect(inventory.length).toBeGreaterThan(0);
      const locations = inventory.flatMap((resource) => [resource.region, ...(resource.replicaRegion === undefined ? [] : [resource.replicaRegion])]);
      expect(locations.filter((location) => !policy.allowedRegions.includes(location))).toEqual([]);
      const primary = inventory.find((resource) => resource.component === 'postgres' && resource.role === 'primary') as Resource;
      const targets = inventory.filter((resource) => resource.role === 'backup-target');
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(policy.allowedRegions).toContain(target.region);
        expect(target.region).not.toBe(primary.region);
      }
    }
    // The WAL archive of the database goes to the resources of that role.
    expect(readJson<{ walArchive: { targetRole: string } }>(REPO_ROOT, 'infra/postgres/backup.json').walArchive.targetRole).toBe('backup-target');
  });

  it('is red when the backup target sits at the site of the primary database, or outside Vietnam', () => {
    const sameSite = scratchInfrastructure();
    editJson<{ resources: Resource[] }>(sameSite, 'infra/environments/production.json', (environment) => {
      (environment.resources.find((resource) => resource.id === 'pg-wal-archive') as Resource).region = 'VN-HAN-1';
    });
    assertRed(runChecker<Outcome>(INFRA_CHECK, { root: sameSite }), /environment production has no second backup site in a different region from the primary database/);

    const abroad = scratchInfrastructure();
    editJson<{ resources: Resource[] }>(abroad, 'infra/environments/production.json', (environment) => {
      (environment.resources.find((resource) => resource.id === 'pg-wal-archive') as Resource).region = 'SG-1';
    });
    assertRed(runChecker<Outcome>(INFRA_CHECK, { root: abroad }), /outside Vietnam: pg-wal-archive: region SG-1/);
  });
});

describe('TC-UAT-NFR-SECURITY-07 the dependency audit, its exceptions and the SBOM', () => {
  const ADVISORY = 'GHSA-aaaa-bbbb-cccc';
  /** What `npm audit --json` answers when a dependency of the lockfile has a published high advisory. */
  const auditReport = {
    vulnerabilities: {
      'bad-package': {
        name: 'bad-package',
        severity: 'high',
        via: [{ source: 1099999, name: 'bad-package', title: 'Prototype pollution', url: `https://github.com/advisories/${ADVISORY}`, severity: 'high', range: '<2.0.0' }],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  };

  /** A repository whose lockfile holds the dependency of the branch: `bad-package` at an exact version. */
  function branchWithDependency(): string {
    const root = scratchDirectory('supply');
    writeText(root, 'package.json', JSON.stringify({ name: 'scratch', version: '1.0.0', private: true, dependencies: { 'bad-package': '1.0.0' } }, null, 2));
    writeText(
      root,
      'package-lock.json',
      JSON.stringify(
        {
          name: 'scratch',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'scratch', version: '1.0.0', dependencies: { 'bad-package': '1.0.0' } },
            'node_modules/bad-package': { version: '1.0.0', resolved: 'https://registry.npmjs.org/bad-package/-/bad-package-1.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==` },
          },
        },
        null,
        2,
      ),
    );
    return root;
  }

  /** The audit step of the pull request pipeline, run against the answer of the advisory database. */
  function auditStep(root: string): Outcome {
    return runChecker<Outcome>(
      `const { main } = await load('supply-chain-check.mjs');
       const lines = [];
       const run = () => ({ status: 1, stdout: JSON.stringify(input.report), stderr: '' });
       const code = main(['--root', input.root, '--skip-sbom', '--audit', '--locale', 'en'], { log: (line) => lines.push(line), run });
       return { code, lines };`,
      { root, report: auditReport },
    );
  }

  it('is red naming the package and the advisory, green with an exception of 30 days that has an owner and shows in the report, and the SBOM lists the package', () => {
    const root = branchWithDependency();
    const first = auditStep(root);
    assertRed(first, new RegExp(`bad-package ${ADVISORY} \\(high\\)`));

    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    writeText(root, 'supply-chain.json', JSON.stringify({ rangePolicy: 'exact', auditExceptions: [{ package: 'bad-package', advisory: ADVISORY, owner: 'security@example.org', reason: 'No fixed release yet; the call path is not reachable', expires }] }, null, 2));
    const second = auditStep(root);
    expect(second.code).toBe(0);
    expect(second.lines.some((line) => line.startsWith(`EXCEPTED: bad-package ${ADVISORY} (high) until ${expires}, owner security@example.org`))).toBe(true);

    // The SBOM of the build is generated from the lockfile by npm and lists the dependency, with the hash and the package URL the gate asks for.
    const sbom = runChecker<{ ok: boolean; problems: unknown[]; names: string[]; purls: string[] }>(
      `const { generateSbom } = await load('sbom.mjs');
       const { readFileSync } = await import('node:fs');
       const out = join(input.root, 'dist', 'sbom.cdx.json');
       const result = generateSbom({ root: input.root, out });
       const document = result.ok ? JSON.parse(readFileSync(out, 'utf8')) : { components: [] };
       return { ok: result.ok, problems: result.problems, names: document.components.map((component) => component.name + '@' + component.version), purls: document.components.map((component) => component.purl) };`,
      { root },
    );
    expect(sbom.problems).toEqual([]);
    expect(sbom.names).toContain('bad-package@1.0.0');
    expect(sbom.purls).toContain('pkg:npm/bad-package@1.0.0');
    const supply = runChecker<Outcome>(
      `const { main } = await load('supply-chain-check.mjs');
       const lines = [];
       const code = main(['--root', input.root, '--locale', 'en'], { log: (line) => lines.push(line) });
       return { code, lines };`,
      { root },
    );
    assertGreen(supply);
  }, 120_000);

  it('does not let an exception that is longer than a quarter, past or without an owner turn the audit green', () => {
    const root = branchWithDependency();
    const reason = 'No fixed release yet; the call path is not reachable';
    const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    for (const exception of [
      { package: 'bad-package', advisory: ADVISORY, owner: 'security@example.org', reason, expires: day(120) },
      { package: 'bad-package', advisory: ADVISORY, owner: 'security@example.org', reason, expires: day(-2) },
      { package: 'bad-package', advisory: ADVISORY, owner: '', reason, expires: day(30) },
    ]) {
      writeText(root, 'supply-chain.json', JSON.stringify({ rangePolicy: 'exact', auditExceptions: [exception] }));
      assertRed(auditStep(root), new RegExp(`bad-package ${ADVISORY} \\(high\\)`));
    }
  });
});

describe('TC-UAT-NFR-AVAILABILITY-01 the burn rate alert, the budget on the dashboard and the release gate', () => {
  const NOW = minuteOf(new Date());
  const DAY = 1440;
  /** The load of the profile of the BRD on the payment service: 200 requests a second. */
  const PER_MINUTE = 200 * 60;
  const traffic = (from: number, to: number, bad: (minute: number) => number = () => 0): SliBucket[] => {
    const buckets: SliBucket[] = [];
    for (let minute = from; minute <= to; minute += 1) buckets.push({ minute, total: PER_MINUTE, bad: bad(minute) });
    return buckets;
  };
  const fastBurnRule = readJson<AlertRule>(REPO_ROOT, 'alerts/rules/SLO_FAST_BURN.json');

  function budgetReportFile(status: BudgetStatus): string {
    const directory = mkdtempSync(join(tmpdir(), 'machvon-budget-'));
    const path = join(directory, 'budget-report.json');
    writeFileSync(path, JSON.stringify(budgetReport([{ service: 'PAY', status }], new Date())));
    return path;
  }

  /** The release gate of the production pipeline for a release of `kind`; GitHub answers a green CI run and a green staging deployment, so only the budget can stop it. */
  function releaseGate(report: string, kind: string): Outcome {
    return runChecker<Outcome>(
      `const { main, STAGING_CONTEXT } = await load('deploy-gate.mjs');
       const sha = 'a'.repeat(40);
       const fetchImpl = async (url, init) => {
         const body = url.includes('/actions/workflows/') ? { workflow_runs: [{ head_sha: sha, status: 'completed', conclusion: 'success' }] } : url.includes('/statuses') && init.method === 'GET' ? [{ context: STAGING_CONTEXT, state: 'success', created_at: new Date(Date.now() - 600 * 60000).toISOString() }] : {};
         return { ok: true, status: 200, json: async () => body };
       };
       const lines = [];
       const code = await main(['check', '--locale', 'en', '--repo', 'o/r', '--sha', sha, '--cohort', 'pilot', '--kind', input.kind, '--budget-report', input.report], { log: (line) => lines.push(line), fetchImpl, env: { GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.example.test' } });
       return { code, lines };`,
      { report, kind },
    );
  }

  it('fires the fast burn alert within 5 minutes of a 30 percent 5xx fault on PAY, shows about 3 minutes of budget spent after 10 minutes, and stops feature releases when the budget is negative', () => {
    const telemetry = new CollectingTelemetry();
    const rules = new AlertEvaluator([fastBurnRule]);
    const start = NOW - 9;
    const history = traffic(NOW - 30 * DAY + 1, start - 1);
    let firedAt: number | undefined;
    let shown: BudgetStatus | undefined;
    for (let minute = start; minute <= NOW; minute += 1) {
      const fault = traffic(start, minute, () => PER_MINUTE * 0.3);
      const { status } = reportSlo({ service: 'PAY', buckets: [...history, ...fault], nowMinute: minute, metrics: telemetry, alerts: telemetry });
      shown = status;
      if (firedAt === undefined && rules.evaluate(telemetry.snapshot()).fired.some((alert) => alert.ruleId === SLO_FAST_BURN_ALERT)) firedAt = minute;
    }
    expect(firedAt).toBeDefined();
    expect((firedAt as number) - start).toBeLessThan(5);
    expect(fastBurnRule.channel).toBe('operations');
    // Ten minutes at 30 percent is three minutes of full outage; the budget of 30 days at 99.9 percent is 43.2 minutes.
    expect(shown?.consumedMinutes).toBe(3);
    expect(shown?.remainingMinutes).toBeCloseTo(40.2, 6);
    expect(shown?.exhausted).toBe(false);

    // With the budget spent (a simulated negative budget: 90 minutes of declared outage), the pipeline stops the feature release and lets the fixes of reliability and security through.
    const spent = budgetStatus({ buckets: history, outages: [{ startMinute: NOW - 90, minutes: 90, reason: 'simulated outage' }], nowMinute: NOW });
    expect(spent.remainingMinutes).toBeLessThan(0);
    const spentReport = budgetReportFile(spent);
    assertRed(releaseGate(spentReport, 'feature'), /the 30 day error budget is spent, so feature releases are stopped/);
    expect(releaseGate(spentReport, 'security').code).toBe(0);
    expect(releaseGate(spentReport, 'reliability').code).toBe(0);
    // The same feature release goes out while the budget holds.
    expect(releaseGate(budgetReportFile(shown as BudgetStatus), 'feature').code).toBe(0);
    rmSync(join(spentReport, '..'), { recursive: true, force: true });
  }, 120_000);
});
