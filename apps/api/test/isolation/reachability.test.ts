import { randomBytes } from 'node:crypto';
import { ControlDatabase, EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache, TenantDatabase } from '@machvon/db';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { loadErrorRegistry, objectKey } from '@machvon/kernel';
import { listOperations } from '@machvon/contracts';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { DOCUMENT_FILE_PORT } from '../../src/modules/doc/file-port';
import type { DocumentFilePort } from '../../src/modules/doc/file-port';
import { FileService } from '../../src/modules/files';
import type { ObjectStoragePort } from '@machvon/kernel';
import { FOREIGN_ATTEMPT_SPECS, attempt, createApiChannel, tokenFor } from './channels/api';
import { GOVRULE_FIXTURES } from './channels/gov/govrule.fixtures';
import type { ForeignAttemptSpec } from './channels/api';
import { DOCUMENT_FIXTURES, HOUSEHOLD_FIXTURES, MASTER_IMPORT_FIXTURES, PROJECT_FIXTURES, REPO_FIXTURES, REPORT_EXPORT_FIXTURES, SCORECARD_FIXTURES, TENANT_IDS, TENANT_NAMES, UNIT_FIXTURES, exportManifestObjectId, exportManifestOf, runIsolationSuite } from './suite';
import type { ForeignAttempt, IsolationChannel } from './suite';
import { TENANT_HEADER } from './test-auth.guard';
import { ERROR_CODES_PATH, loadOpenApi, startIsolationDatabase, startTestApp } from './test-app';
import type { RunningApp } from './test-app';

const SIGNING_KEY = randomBytes(32);

/**
 * The isolation suite wants a 404 from every foreign-id case. A 404 proves nothing when the object the case names does not exist at
 * all (a fixture that was never seeded, an id of the wrong kind, a route that is not the one of the operation): the handler would
 * answer 404 whoever asks. This control sends the same request as the OWNER of the object. It must reach a handler that finds the
 * object, so the answer is anything but 404 (200, 409, 422, 403 on a rule are all fine) and never a server error.
 */
describe('the foreign-id cases of the isolation suite reach an object that exists (ST-KERNEL-026 control)', () => {
  const doc = loadOpenApi();
  const registry = loadErrorRegistry(ERROR_CODES_PATH);
  const pools: Pool[] = [];
  let database: TestDatabase;
  let app: RunningApp;
  let ownerUrl: string;

  beforeAll(async () => {
    database = await startIsolationDatabase();
    ownerUrl = database.urlFor('machvon_owner');
    const pool = (url: string): Pool => {
      const created = new Pool({ connectionString: url, max: 3 });
      pools.push(created);
      return created;
    };
    const tenantDatabase = new TenantDatabase(pool(database.urlFor('machvon_app')));
    const entitlements = {
      store: new EntitlementStore(tenantDatabase, new InMemoryEntitlementCache()),
      control: new ControlDatabase(pool(database.urlFor('machvon_control'))),
    };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: tenantDatabase,
          registry,
          policy: { database: tenantDatabase, access: new EffectiveAccessStore(tenantDatabase, new InMemoryAuthzCache()) },
          entitlements,
        }),
      ],
    });
    const channel = createApiChannel({ baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc });
    for (const tenant of TENANT_NAMES) await channel.seed(tenant);
    // The fixture rows name stored files; the commands that read the file after finding the row answer 404 to anyone while the file is missing.
    await app.get<DocumentFilePort>(DOCUMENT_FILE_PORT).put(DOCUMENT_FIXTURES['TNT-B'].objectKey, Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf');
    const files = app.get<FileService>(FileService);
    const storage = (files as unknown as { storage: ObjectStoragePort }).storage;
    const owner = { tenantId: TENANT_IDS['TNT-B'], membershipId: '00000000-0000-4000-8000-000000000001', scopeVersion: 1 };
    await storage.put(owner, MASTER_IMPORT_FIXTURES['TNT-B'].fileObjectKey, Buffer.from('code,name\nB1,Beta\n'), { contentType: 'text/csv' });
    await files.scan(owner, MASTER_IMPORT_FIXTURES['TNT-B'].fileObjectKey);
    // The manifest of the export of TNT-B: the export is found, and then its manifest is read from the store.
    await storage.put(owner, objectKey(TENANT_IDS['TNT-B'], 'tenant_export', exportManifestObjectId('TNT-B')), Buffer.from(exportManifestOf('TNT-B')), { contentType: 'application/json' });
    const exportKey = objectKey(TENANT_IDS['TNT-B'], 'report_export', REPORT_EXPORT_FIXTURES['TNT-B'].id);
    await storage.put(owner, exportKey, Buffer.from('key,label,value\r\n'), { contentType: 'text/csv' });
    await files.scan(owner, exportKey);
    // The file of a document of the project repository of TNT-B: its download, its re-reading and a new version made of it open the file after the row is found.
    await storage.put(owner, REPO_FIXTURES['TNT-B'].fileObjectKey, Buffer.from('%PDF-1.4\n%%EOF\n'), { contentType: 'application/pdf' });
    await files.scan(owner, REPO_FIXTURES['TNT-B'].fileObjectKey);
    // The file of the batch of the export of the records of the contractors.
    const recordsKey = objectKey(TENANT_IDS['TNT-B'], 'contractor_export', SCORECARD_FIXTURES['TNT-B'].exportSha256);
    await storage.put(owner, recordsKey, Buffer.from('record_type,contractor_name\r\n'), { contentType: 'text/csv' });
    await files.scan(owner, recordsKey);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    await Promise.all(pools.map((pool) => pool.end()));
    if (database) await database.stop();
  }, 60_000);

  // The case aims at TNT-B, and names a unit of TNT-A as the new parent (which is what makes it a real attempt for the TNT-A user). Its owner moves it under its own unit.
  const ownersVersion = (spec: ForeignAttemptSpec): ForeignAttemptSpec =>
    spec.operation === 'moveOrganizationUnit'
      ? { ...spec, body: { ...(spec.body as Record<string, unknown>), new_parent_id: UNIT_FIXTURES['TNT-B'][1]?.id } }
      : spec;

  // A case that expects 403 or 404 for a control-plane operation is refused by plane whoever asks: it has nothing to reach.
  const reachable = FOREIGN_ATTEMPT_SPECS.filter((spec) => spec.expectedStatuses === undefined);

  it('has cases to run', () => {
    expect(reachable.length).toBeGreaterThan(50);
  });

  // Reads that are not a list of rows of the tenant: the published theme answers 403 to a tenant that has none, and the global search needs a text (its own channel
  // of the isolation suite reads it).
  // The reads of the caller's own access, entitlements and notification preferences answer one object, not a page of rows: they are read for leaks like the others. The preferences hold an `items` list that is empty for a person who never saved. The two rates answer one aggregate over a snapshot (its groups are asked for), not a page of rows.
  // The runs and the findings of the AI analysis are listed only for the proposals the caller has in full (an evaluator of the project who declared no conflict), which the generic reader of this test is not: their isolation is tested with the rows of the runs, the findings and the evidence in the isolation suite, and with the cases of the analysis itself.
  // listResettlementCandidates reads the items of approved plans that give resettlement and have no unit yet: the fixtures hold no such plan (its isolation is tested with the rows of the allocations, and by the test of the command).
  // The reads of the governance deepening that answer one object or one aggregate (the summary of the directives, the board and the statistics of the workflows, the register of the figures, the readings of the colours, the matrix of the exceptions, the connection to e-GP, the tree of the packages, the counts of the work, the changes of the week, the policies of the clocks, the certifications of the figures, the exports as a file) have no `items` page to count: they are read for leaks like the others, and what they hold of the tenant comes from the rows the fixtures seed.
  const LISTS_WITHOUT_ROWS: string[] = ['exportHomeFigures', 'exportPackageWorkflowReport', 'getAuditOverview', 'getCommandCenter', 'getContractScheduleSCurve', 'getConversionOptions', 'getDirectiveSummary', 'getDisbursementForecast', 'getDisbursementRates', 'getDocumentOverview', 'getEgpConnection', 'getFundingFigureBoard', 'getFundingFigureHistory', 'getFundingTaxonomy', 'getHomeChanges', 'getHomeChannelHealth', 'getKpiRegister', 'getMyEffectiveAccess', 'getMyEntitlements', 'getMyNotificationPreferences', 'getMyProfile', 'getMyUsage', 'getMyWorkCounts', 'getPackageProcessTree', 'getPackageProcessTreeNode', 'getPackageWorkflowBoard', 'getPackageWorkflowStatistics', 'getPackageWorkflowSummary', 'getRagReading', 'getSodMatrix', 'getWorkClockPolicies', 'listAnalyticsCertifications', 'listExpiringWarranties', 'listMaterialContracts', 'listOverdueAdvances', 'listReportDeliveries', 'listResettlementCandidates'];
=======
  const LISTS_WITHOUT_ROWS: string[] = ['exportHomeFigures', 'exportPackageWorkflowReport', 'getAuditOverview', 'getCommandCenter', 'getContractScheduleSCurve', 'getConversionOptions', 'getDirectiveSummary', 'getDisbursementForecast', 'getDisbursementRates', 'getDocumentOverview', 'getEgpConnection', 'getHomeChanges', 'getHomeChannelHealth', 'getKpiRegister', 'getMyEffectiveAccess', 'getMyEntitlements', 'getMyNotificationPreferences', 'getMyProfile', 'getMyUsage', 'getMyWorkCounts', 'getPackageProcessTree', 'getPackageProcessTreeNode', 'getPackageWorkflowBoard', 'getPackageWorkflowStatistics', 'getPackageWorkflowSummary', 'getRagReading', 'getSodMatrix', 'getWorkClockPolicies', 'listAnalyticsCertifications', 'listExpiringWarranties', 'listIndicatorFigures', 'listIndicatorImports', 'listMaterialContracts', 'listOverdueAdvances', 'listResettlementCandidates'];
=======
  const LISTS_WITHOUT_ROWS: string[] = ['exportHomeFigures', 'exportPackageWorkflowReport', 'getAuditOverview', 'getCommandCenter', 'getContractScheduleSCurve', 'getConversionOptions', 'getDirectiveSummary', 'getDisbursementForecast', 'getDisbursementRates', 'getDocumentOverview', 'getEgpConnection', 'getHomeChanges', 'getHomeChannelHealth', 'getKpiRegister', 'getMyEffectiveAccess', 'getMyEntitlements', 'getMyNotificationPreferences', 'getMyProfile', 'getMyUsage', 'getMyWorkCounts', 'getPackageProcessTree', 'getPackageProcessTreeNode', 'getPackageWorkflowBoard', 'getPackageWorkflowStatistics', 'getPackageWorkflowSummary', 'getRagReading', 'getSodMatrix', 'getWorkClockPolicies', 'listAnalyticsCertifications', 'listContractRatingProposals', 'listExpiringWarranties', 'listMaterialContracts', 'listOverdueAdvances', 'listResettlementCandidates'];
  // The capital available on a line or an appropriation names what it reads in its query (the line or the appropriation): it is not a list.
  // The drill of a figure names what it reads in a signed token of the member (another member's or another tenant's token is a 400 of its own, tested with the drill): it is not a list either.
  const NOT_PLAIN_LISTS: ReadonlySet<string> = new Set(['getDeliveryOverview', 'getMyPublishedTheme', 'searchGlobal', 'getCapitalAvailability', 'getPaymentChain', 'explainHomeMetric', 'getDisbursementRankings', 'explainBiMetric', 'listNotificationTestRecipients', 'getIssueWeeklyMatrix', 'getLineageGraph', 'getEffectiveGovernanceRule', 'getIndicator', 'getIndicatorImportMapping', 'listIndicatorFigureHistory', 'listIndicatorImportRows']);

  // The effective governance rule names the rule type and the code it reads: a code the tenant has no rule for is a 404 of its own (tested below), so it is not a list either.
  // The reads below need a query of their own to answer at all: the period of the directives of a report, the rule type and code of the versions of a rule, and the node of the tree of the procurement packages.
  const LIST_QUERIES: Readonly<Record<string, string>> = {
    getDirectivesForReport: 'from=2026-01-01&to=2026-12-31',
    listGovernanceRuleVersions: `rule_type=RAG_THRESHOLDS&code=${GOVRULE_FIXTURES['TNT-B'].rules.read.code}`,
    getFundingFigureHistory: `project_id=${PROJECT_FIXTURES['TNT-B'].id}&class_code=CURRENT_YEAR&tier_code=CENTRAL&measure=DISBURSED&period_grain=MONTH&plan_year=2026&period_ordinal=4`,
    getPackageProcessTreeNode: 'node_id=ROOT',
    listPackageProcessTreeNodePackages: 'node_id=ROOT',
    getPackageProcessTreeNodeFeed: 'node_id=ROOT',
  };

  // The isolation suite reads one list (the organization units) as the other tenant. Every other list read is a place where a missing tenant
  // predicate would show the rows of another tenant, so each one is read here as TNT-A, and what comes back is judged by the markers of TNT-B.
  const listReads = (): string[] => {
    const plain = listOperations(doc).filter((entry) => entry.method === 'get' && !entry.path.includes('{') && app.implementedOperations.has(entry.id) && !NOT_PLAIN_LISTS.has(entry.id));
    return plain.map((entry) => entry.id).sort();
  };
  const pathOf = (operationId: string): string => listOperations(doc).find((entry) => entry.id === operationId)?.path ?? '';
  // The lists of a project name the project they read: both tenants read the project of TNT-B, so TNT-A must meet none of its rows and TNT-B all of them.
  const PROJECT_LISTS: ReadonlySet<string> = new Set(['listLandParcels', 'listLandSections', 'listAffectedHouseholds', 'listCompensationPlans', 'listUpcomingLandDeadlines', 'listLandComplaints', 'listResettlementAllocations', 'listResettlementCandidates', 'listEnforcementCases']);
  // The list of the records of a household names the household it reads.
  const HOUSEHOLD_LISTS: ReadonlySet<string> = new Set(['listInventoryRecords']);
  // A read of a project names the project: another tenant gets 404 for a project it cannot see, which is the isolation answer, and an empty 200 is accepted too.
  const FOREIGN_STATUSES: Readonly<Record<string, number[]>> = { getFundingFigureHistory: [200, 404] };
  const READS_AT_ONCE = 24;
  // The list of the investment appraisals declares a page of at most 100 rows in the contract, not 200.
  const LIST_LIMITS: Readonly<Record<string, number>> = { listInvestmentAppraisals: 100 };
  const readAs = async (tenant: 'TNT-A' | 'TNT-B', operationId: string): Promise<{ status: number; body: string }> => {
    const project = PROJECT_LISTS.has(operationId) ? `&project_id=${PROJECT_FIXTURES['TNT-B'].id}` : HOUSEHOLD_LISTS.has(operationId) ? `&household_id=${HOUSEHOLD_FIXTURES['TNT-B'].id}` : '';
    const query = LIST_QUERIES[operationId] === undefined ? '' : `&${LIST_QUERIES[operationId]}`;
    const response = await fetch(`${app.baseUrl}${pathOf(operationId)}?limit=${LIST_LIMITS[operationId] ?? 200}${project}${query}`, { headers: { [TENANT_HEADER]: tokenFor(tenant, SIGNING_KEY) } });
    return { status: response.status, body: await response.text() };
  };

  it('reads every list of the application as the other tenant without meeting a row of TNT-B (and the lists have rows to meet)', async () => {
    const operations = listReads();
    expect(operations.length).toBeGreaterThan(30);
    // A batch at a time: a hundred and more connections at once are refused by the listener of a loaded machine, which is not what this test is about.
    const foreignAttempts = async (): Promise<ForeignAttempt[]> => {
      const answers: ForeignAttempt[] = [];
      for (let from = 0; from < operations.length; from += READS_AT_ONCE) {
        const batch = operations.slice(from, from + READS_AT_ONCE);
        answers.push(...(await Promise.all(batch.map(async (operation) => ({ operation, ...(await readAs('TNT-A', operation)), expectedStatuses: FOREIGN_STATUSES[operation] ?? [200] })))));
      }
      return answers;
    };
    const channel: IsolationChannel = {
      name: 'lists',
      seed: () => Promise.resolve(),
      readAs: () => Promise.resolve({ status: 404, body: '{}' }),
      foreignAttempts,
    };
    const report = await runIsolationSuite({ channels: [channel], idBearingOperations: [], foreignIdCases: new Set() });
    expect(report).toEqual({ ok: true, leaks: [], uncoveredOperations: [] });

    // The same reads as the owner of the rows: a list that is empty for everyone proves nothing, so the lists that answer rows are counted
    // and must be most of them (the rest are lists of things the fixtures do not hold, named here so that a new one is noticed).
    const empty: string[] = [];
    for (const operation of operations) {
      const answer = await readAs('TNT-B', operation);
      expect([operation, answer.status]).toEqual([operation, 200]);
      const items = (JSON.parse(answer.body) as { items?: unknown[] }).items;
      if (!Array.isArray(items) || items.length === 0) empty.push(operation);
    }
    expect(empty).toEqual(LISTS_WITHOUT_ROWS);
  }, 120_000);

  it('answers the effective rule of TNT-B to its owner and 404 to another tenant', async () => {
    const query = `rule_type=RAG_THRESHOLDS&code=${GOVRULE_FIXTURES['TNT-B'].rules.read.code}`;
    const read = async (tenant: 'TNT-A' | 'TNT-B'): Promise<{ status: number; body: string }> => {
      const response = await fetch(`${app.baseUrl}${pathOf('getEffectiveGovernanceRule')}?${query}`, { headers: { [TENANT_HEADER]: tokenFor(tenant, SIGNING_KEY) } });
      return { status: response.status, body: await response.text() };
    };
    expect((await read('TNT-B')).status).toBe(200);
    const foreign = await read('TNT-A');
    expect(foreign.status).toBe(404);
    expect(foreign.body).not.toContain(GOVRULE_FIXTURES['TNT-B'].rules.read.code);
  }, 60_000);

  // These cases find a row and then read a stored file. The isolation suite seeds the rows only: with no file behind them the answer is 404
  // whoever asks, so a lookup that leaked would go unseen. With the files in place the 404 can only come from the lookup.
  const FILE_BACKED = ['getProjectDocumentVersionDownload', 'addProjectDocumentVersion', 'rerunDocumentExtraction', 'getDocumentVersionDownload', 'verifyDocumentSignatures', 'getDocumentSignatureReport', 'applyMasterImport', 'getReportExportDownload', 'getContractorExportDownload', 'getTenantExportManifest', 'downloadTenantExportFile'];

  it('still answers 404 to another tenant for the cases that read a stored file, when the file of the object exists', async () => {
    const options = { baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc };
    const specs = FOREIGN_ATTEMPT_SPECS.filter((spec) => FILE_BACKED.includes(spec.operation));
    expect(specs.map((spec) => spec.operation).sort()).toEqual([...FILE_BACKED].sort());
    for (const spec of specs) {
      const answer = await attempt(options, spec, 'TNT-A');
      expect({ operation: spec.operation, status: answer.status }).toEqual({ operation: spec.operation, status: 404 });
      expect(answer.body).not.toContain(DOCUMENT_FIXTURES['TNT-B'].objectKey);
    }
  }, 60_000);

  it('finds, for the owner of the object, the object that every foreign-id case names', async () => {
    const options = { baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc };
    const unreachable: string[] = [];
    // One after the other: a command of the owner may change the object the next case names.
    for (const spec of reachable) {
      const answer = await attempt(options, ownersVersion(spec), 'TNT-B');
      if (answer.status === 404) unreachable.push(`${spec.operation} answered ${answer.status} to the owner of ${spec.id}: ${answer.body.slice(0, 160)}`);
    }
    expect(unreachable).toEqual([]);
  }, 120_000);
});
