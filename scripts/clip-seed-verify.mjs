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

/** The checks of a dataset, in the order they are printed. */
export async function verifyChecks(plan, reader) {
  if (plan.dataset === 'public') return [...(await portfolioChecks(plan, reader))];
  return [];
}
