// The read-back of `clip-seed verify`: every check reads through a real read operation of the API and names the figure it found. A figure the read
// did not give stays undefined and fails (nothing is invented). Persona keys are the people of the guide (apps/web/e2e/support/docs-people.json).

const BASE_STAGE_COUNTS = { IMPLEMENTATION: 3, BUDGETED: 2, SUSPENDED: 1, COMPLETED: 1, APPRAISAL: 2, PIPELINE: 2, REJECTED: 1, CONCEPT: 1 };

async function safe(read) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** Checks of the portfolio: the projects by stage, from the project register. */
export async function portfolioChecks(plan, reader) {
  const rows = await safe(() => reader.list('projectManager', '/resources/project'));
  const checks = [{ name: 'projects registered', value: rows?.length, min: plan.expect.projectsTotal }];
  for (const [stage, extra] of Object.entries(plan.expect.extraStageCounts)) {
    const wanted = (BASE_STAGE_COUNTS[stage] ?? 0) + extra;
    checks.push({ name: `projects in ${stage}`, value: rows === undefined ? undefined : rows.filter((row) => row.status === stage).length, min: wanted });
  }
  checks.push({ name: 'projects with a national code', value: rows === undefined ? undefined : rows.filter((row) => row.national_project_code !== null && row.national_project_code !== undefined).length, min: 1 });
  return checks;
}

/** Checks of procurement: the plans and packages of the plan, the contractors of the guide, and the workflows that exist. */
export async function procurementChecks(plan, reader) {
  const plans = await safe(() => reader.list('projectManager', '/procurement-plans'));
  const packages = await safe(() => reader.list('projectManager', '/resources/procurement_package'));
  const contractors = await safe(() => reader.list('projectManager', '/resources/contractor'));
  const wanted = plan.procurement.plans.length;
  return [
    { name: 'procurement plans', value: plans === undefined ? undefined : plans.filter((row) => row.status !== 'CANCELLED').length, min: wanted },
    { name: 'procurement packages', value: packages?.length, min: plan.expect.packages },
    { name: 'contractors registered', value: contractors?.length, min: 16 },
  ];
}

/** Checks of the national procurement network chapter: records imported, mappings decided, posting clocks (overdue, due soon, met) and the reconciliation. */
export async function egpChecks(plan, reader) {
  const read = async (path) => safe(async () => {
    const reply = await reader.get('projectManager', path);
    return reply.ok ? reply.json : undefined;
  });
  const [connection, obligations, mappings, items] = await Promise.all([read('/egp/connection'), read('/egp/obligations'), read('/egp/mappings'), read('/egp/reconciliation/items')]);
  return [
    { name: 'egp plan records imported', value: connection?.record_counts?.KHLCNT, min: plan.egp.fileRows },
    { name: 'egp notice records imported', value: connection?.record_counts?.TBMT, min: 1 },
    { name: 'egp mappings active', value: mappings?.counts?.ACTIVE, min: 1 },
    { name: 'egp mappings waiting', value: mappings?.counts?.PROPOSED, min: 1 },
    { name: 'egp obligations overdue', value: obligations?.counts?.overdue, min: 1 },
    { name: 'egp obligations due soon', value: obligations?.counts?.due_soon, min: 1 },
    { name: 'egp obligations met', value: obligations?.counts?.met, min: 1 },
    { name: 'egp differences open', value: items?.counts?.open, min: 1 },
    { name: 'egp differences resolved', value: items?.counts?.resolved, min: 1 },
  ];
}

/** Checks of the enterprise dataset: the projects, the funding batches of the year (equity and loan), the directives and the accounting differences. */
export async function enterpriseChecks(plan, reader) {
  const codes = new Set(plan.projects.map((project) => project.code));
  const projects = await safe(() => reader.list('projectManager', '/resources/project'));
  const batches = await safe(() => reader.list('projectManager', '/funding-figures/batches', { plan_year: plan.planYear }));
  const directives = await safe(() => reader.list('projectManager', '/directives'));
  const differences = await safe(() => reader.list('projectManager', '/ebs/differences'));
  // One accepted year plan per planned project and class: a batch of another project, kind or state cannot stand in for a missing one.
  const ids = new Map((projects ?? []).filter((row) => codes.has(row.code)).map((row) => [row.id, row.code]));
  const covered = (classCode) => new Set((batches ?? []).filter((row) => row.class_code === classCode && row.figure_kind === 'PLAN_YEAR' && ids.has(row.project_id) && (row.status === 'ACCEPTED' || row.status === 'SUPERSEDED')).map((row) => row.project_id)).size;
  return [
    { name: 'enterprise projects', value: projects === undefined ? undefined : projects.filter((row) => codes.has(row.code)).length, min: plan.expect.projectsTotal },
    { name: 'equity batches accepted', value: batches === undefined ? undefined : covered('EQUITY'), min: plan.projects.length },
    { name: 'loan batches accepted', value: batches === undefined ? undefined : covered('LOAN'), min: plan.projects.length },
    { name: 'directives of the meetings', value: directives?.length, min: plan.expect.directives },
    { name: 'accounting differences opened', value: differences?.length, min: 1 },
    ...(await enterpriseReportChecks(plan, reader)),
  ];
}

async function readJson(reader, person, path, query) {
  return safe(async () => {
    const reply = await reader.get(person, path, query);
    return reply.ok ? reply.json : undefined;
  });
}

const tileValue = (center, code) => {
  const tiles = Array.isArray(center) ? center : center?.tiles;
  const value = tiles?.find((row) => row.metric_code === code)?.value;
  return value === undefined || value === null ? undefined : Number(value);
};

/** Checks of the contracts: the five awarded packages of the guide projects have an active contract. */
export async function contractChecks(plan, reader) {
  const contracts = await safe(() => reader.list('projectManager', '/resources/contract'));
  return [{ name: 'contracts active', value: contracts === undefined ? undefined : contracts.filter((row) => row.status === 'ACTIVE').length, min: 5 }];
}

/** Checks of the money of the contracts: payment requests settled and waiting at the Treasury, the advance, and the advance that is over its recovery deadline. */
export async function paymentChecks(plan, reader) {
  const requests = await safe(() => reader.list('treasuryMaker', '/resources/payment_request'));
  const advances = await safe(() => reader.list('treasuryMaker', '/advances'));
  const overdue = await safe(() => reader.list('treasuryMaker', '/advances/overdue'));
  const count = (status) => (requests === undefined ? undefined : requests.filter((row) => row.status === status).length);
  return [
    { name: 'payment requests settled', value: count('SETTLED'), min: 1 },
    { name: 'payment requests waiting at the Treasury', value: count('SENT_TREASURY'), min: 1 },
    { name: 'advances', value: advances?.length, min: 1 },
    { name: 'advances over the recovery deadline', value: overdue?.length, min: 1 },
  ];
}

/** Checks of BI: the metrics of the platform (certified, synced from the bundle of the repository) and the dashboards the leader published. */
export async function biChecks(plan, reader) {
  const metrics = await safe(() => reader.list('capApprover', '/resources/metric_definition'));
  // The leader's scope may not list the dashboards on every stack: the owner of the tenant reads them then.
  const dashboards = (await safe(() => reader.list('capApprover', '/bi/dashboards'))) ?? (await safe(() => reader.list('owner', '/bi/dashboards')));
  const wanted = new Set(plan.bi.dashboards.map((entry) => entry.code));
  return [
    { name: 'metrics certified', value: metrics === undefined ? undefined : metrics.filter((row) => row.status === 'CERTIFIED').length, min: 1 },
    { name: 'dashboards published', value: dashboards === undefined ? undefined : dashboards.filter((row) => wanted.has(row.code) && row.status === 'PUBLISHED').length, min: wanted.size },
  ];
}

/** Checks of the process tree of the packages: how many run, are late, are on hold, have not started (the plan names the targets). */
export async function workflowChecks(plan, reader) {
  const targets = plan.procurement.plans.flatMap((entry) => entry.packages.map((item) => item.target));
  const summary = await readJson(reader, 'projectManager', '/package-workflows/summary');
  const tree = await readJson(reader, 'projectManager', '/package-workflows/process-tree');
  const wantHold = targets.filter((target) => target.startsWith('HOLD:')).length;
  const wantIdle = targets.filter((target) => target === 'NOT_STARTED').length;
  return [
    { name: 'workflows started', value: summary === undefined ? undefined : summary.total - summary.not_started, min: targets.length - wantIdle },
    { name: 'workflows late', value: summary?.late, min: 1 },
    { name: 'workflows on hold', value: summary?.on_hold, min: wantHold > 0 ? 1 : 0 },
    { name: 'workflows not started', value: summary?.not_started, min: wantIdle > 0 ? 1 : 0 },
    { name: 'process tree nodes', value: tree?.nodes?.length, min: 10 },
    { name: 'process tree packages', value: tree?.total?.count, min: targets.length },
  ];
}

/** Checks of the alerts: the rules in force and the warnings the platform made from them, one of each severity. */
export async function alertChecks(plan, reader) {
  const rules = await safe(() => reader.list('capApprover', '/early-warning-rules'));
  const warnings = await safe(() => reader.list('capApprover', '/home/warnings'));
  const codes = new Set(plan.alerts.rules.map((rule) => rule.rule_code));
  const inForce = rules === undefined ? undefined : new Set(rules.filter((row) => codes.has(row.rule_code) && String(row.status).toUpperCase() === 'PUBLISHED').map((row) => row.rule_code)).size;
  const bySeverity = (severity) => (warnings === undefined ? undefined : warnings.filter((row) => row.severity === severity).length);
  return [
    { name: 'alert rules published', value: inForce, min: codes.size },
    { name: 'warnings INFO', value: bySeverity('INFO'), min: 1 },
    { name: 'warnings WARNING', value: bySeverity('WARNING'), min: 1 },
    { name: 'warnings CRITICAL', value: bySeverity('CRITICAL'), min: 1 },
  ];
}

/** Checks of the money side: frozen snapshots, the figures of the command center, and the feed of the Department of Finance. */
export async function moneyChecks(plan, reader) {
  const snapshots = await safe(() => reader.list('capApprover', '/period-snapshots'));
  const center = await readJson(reader, 'capApprover', '/home/command-center');
  const feed = await readJson(reader, 'projectManager', '/finance-feed/connection');
  const feedRecords = feed?.record_counts === undefined ? undefined : Object.values(feed.record_counts).reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
  return [
    { name: 'period snapshots frozen', value: snapshots === undefined ? undefined : snapshots.filter((row) => row.status === 'FROZEN').length, min: 2 },
    { name: 'treasury disbursed shown', value: tileValue(center, 'DISBURSED_TREASURY'), min: 1 },
    { name: 'disbursement rate of the plan shown', value: tileValue(center, 'DISBURSEMENT_RATE_TOTAL'), min: 0 },
    { name: 'finance feed records', value: feedRecords, min: Object.keys(plan.disbursement.shares).length },
  ];
}

/** Checks of the province committee: the head reads a workspace that is not empty, the roster is filled, the directives are tracked and some are overdue. */
export async function committeeChecks(plan, reader) {
  const workspace = await readJson(reader, 'docHead', '/committee/workspace');
  const roster = await readJson(reader, 'projectManager', '/committee/roster');
  const directives = await safe(() => reader.list('projectManager', '/directives'));
  const summary = await readJson(reader, 'projectManager', '/directives/summary');
  const wanted = plan.meetings.reduce((sum, meeting) => sum + meeting.directives.length, 0);
  return [
    { name: 'committee workspace has data', value: workspace === undefined ? undefined : workspace.feed?.empty === false ? 1 : 0, min: 1 },
    { name: 'committee workspace projects', value: workspace?.feed?.projects, min: 10 },
    { name: 'committee members appointed', value: roster === undefined ? undefined : (JSON.stringify(roster).match(/"committee_role"/gu) ?? []).length, min: 4 },
    { name: 'directives recorded', value: directives?.length, min: wanted },
    { name: 'directives overdue', value: summary?.by_status?.OVERDUE, min: 1 },
  ];
}

/** The PVN and HPM forms of the enterprise edition: issued copies, pushes written and answered. */
export async function enterpriseReportChecks(plan, reader) {
  const issues = await safe(() => reader.list('projectManager', '/report-engine/issues'));
  const hpm = await readJson(reader, 'projectManager', '/hpm/connection');
  const demo = issues === undefined ? undefined : issues.filter((row) => row.form_status === 'DEMO').length;
  return [
    { name: 'report copies issued', value: issues?.length, min: plan.expect.reportIssues },
    { name: 'issued copies marked as demo forms', value: demo, min: plan.expect.reportIssues },
    { name: 'hpm pushes in the log', value: hpm?.counts?.pushes, min: 2 },
    { name: 'hpm pushes answered', value: hpm === undefined ? undefined : Number(hpm.counts?.rejected ?? 0) + Number(hpm.counts?.accepted ?? 0), min: 1 },
  ];
}

/**
 * Checks of the chapters the enterprise clip shares with the public one: the documents of the office, the funded projects, procurement, contracts, the process tree and
 * the dashboards, all on the data of the enterprise (nothing of the public dataset is read).
 */
export async function enterpriseSharedChecks(plan, reader) {
  const outgoing = await safe(() => reader.list('projectManager', '/outgoing-documents'));
  const projects = await safe(() => reader.list('projectManager', '/resources/project'));
  const codes = new Set(plan.projects.map((project) => project.code));
  const funded = projects === undefined ? undefined : projects.filter((row) => codes.has(row.code) && ['BUDGETED', 'IMPLEMENTATION'].includes(String(row.status))).length;
  return [
    { name: 'enterprise projects budgeted or started', value: funded, min: plan.expect.fundedProjects },
    { name: 'outgoing documents issued', value: outgoing === undefined ? undefined : outgoing.filter((row) => row.status === 'ISSUED').length, min: 3 },
    ...(await procurementChecks(plan, reader)),
    ...(await contractChecks(plan, reader)),
    ...(await workflowChecks(plan, reader)),
    ...(await enterpriseBiChecks(plan, reader)),
  ];
}

/** Dashboards of the enterprise plan: made over certified metrics (publication needs a role grant that asks for a second factor, so a draft counts). */
export async function enterpriseBiChecks(plan, reader) {
  const metrics = await safe(() => reader.list('capApprover', '/resources/metric_definition'));
  const dashboards = (await safe(() => reader.list('projectManager', '/bi/dashboards'))) ?? (await safe(() => reader.list('capApprover', '/bi/dashboards')));
  const wanted = new Set(plan.bi.dashboards.map((entry) => entry.code));
  return [
    { name: 'metrics certified', value: metrics === undefined ? undefined : metrics.filter((row) => row.status === 'CERTIFIED').length, min: 1 },
    { name: 'dashboards made', value: dashboards === undefined ? undefined : dashboards.filter((row) => wanted.has(row.code)).length, min: wanted.size },
  ];
}

/** The checks of a dataset, in the order they are printed. */
export async function verifyChecks(plan, reader) {
  if (plan.dataset === 'public') return [...(await portfolioChecks(plan, reader)), ...(await procurementChecks(plan, reader)), ...(await contractChecks(plan, reader)), ...(await paymentChecks(plan, reader)), ...(await workflowChecks(plan, reader)), ...(await biChecks(plan, reader)), ...(await alertChecks(plan, reader)), ...(await egpChecks(plan, reader)), ...(await moneyChecks(plan, reader)), ...(await committeeChecks(plan, reader))];
  if (plan.dataset === 'public') return [...(await portfolioChecks(plan, reader)), ...(await procurementChecks(plan, reader)), ...(await contractChecks(plan, reader)), ...(await paymentChecks(plan, reader)), ...(await workflowChecks(plan, reader)), ...(await alertChecks(plan, reader)), ...(await egpChecks(plan, reader)), ...(await moneyChecks(plan, reader)), ...(await committeeChecks(plan, reader))];
  if (plan.dataset === 'enterprise') return [...(await enterpriseChecks(plan, reader)), ...(await enterpriseSharedChecks(plan, reader))];
  return [];
}
