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
  ];
}

/** The checks of a dataset, in the order they are printed. */
export async function verifyChecks(plan, reader) {
  if (plan.dataset === 'public') return [...(await portfolioChecks(plan, reader)), ...(await procurementChecks(plan, reader))];
  if (plan.dataset === 'enterprise') return enterpriseChecks(plan, reader);
  return [];
}
