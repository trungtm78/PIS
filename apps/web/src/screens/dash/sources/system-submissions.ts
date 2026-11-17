import type { ApiClient } from '@machvon/api-client';
import { NotEnoughError, record, text } from './system';
import type { LooseClient } from './system';
import { OWED, SUBMISSIONS_FLOOR } from './submissions';
import type { SubmissionsRead, SystemApprovalTask, SystemExplanation, SystemSubmissionProject } from './submissions';
import type { SystemTaskUnit } from './tasks';

/**
 * Reads what the submissions bundle is built from: the explanation requests the reader may see that are still owed, and the approval tasks that wait for the reader's
 * own decision. The board calls those papers "waiting for the leader": `mine` keeps the tasks given to the reader, and leaves out the ones the reader only sees (as
 * who runs the workflows), sent, or may decide for someone else. With `mine` the server also says what each record is of, when the owning module says anything.
 *
 * The requests are asked for status by status, so the closed history of the tenant is never paged through. The answers are taken loosely typed, field by field, as
 * `system.ts` takes them. A read that fails fails the bundle: a part of the queue is not drawn as the whole.
 */
const PAGE = { limit: 200 } as const;

export async function readSubmissionsInput(apiClient: ApiClient, today: string): Promise<SubmissionsRead> {
  const client = apiClient as unknown as LooseClient;
  const [approvalsRaw, ...owedRaw] = await Promise.all([
    client.readAll('get_resources_approval_task', { query: { ...PAGE, status: 'Pending', mine: 'true' } }),
    ...[...OWED].map((status) => client.readAll('listExplanationRequests', { query: { ...PAGE, status } })),
  ]);
  const explanationsRaw = owedRaw.flat();

  const explanations: SystemExplanation[] = explanationsRaw.map(record).flatMap((row) => {
    const status = text(row.status);
    if (status === null) return [];
    const project = record(row.project), unit = record(row.unit);
    const projectId = text(project.id), unitId = text(unit.id);
    return [{
      status, project: projectId === null ? null : { id: projectId, code: text(project.code), name: text(project.name) }, unit: unitId === null ? null : { id: unitId, name: text(unit.name) },
      question: text(row.question), due_at: text(row.due_at),
    }];
  });
  const approvals: SystemApprovalTask[] = approvalsRaw.map(record).flatMap((row) => {
    const status = text(row.status), type = text(row.business_type);
    if (status === null || type === null) return [];
    const resource = record(row.resource), summary = record(row.summary);
    const resourceType = text(resource.type), resourceId = text(resource.id);
    return [{
      status, business_type: type, step_name: text(row.step_name), due_at: text(row.due_at), received_at: text(row.submitted_at) ?? text(row.created_at), unit_id: text(record(row.instance).unit_id),
      resource: resourceType === null || resourceId === null ? null : { type: resourceType, id: resourceId },
      subject_name: text(record(summary.subject).name), project_code: text(record(summary.project).code), unit_code: text(record(summary.unit).code),
    }];
  });

  // The two lists already say it: with nothing owed, or nothing that waits, the bundle cannot replace the template's, and the registers are not read for it.
  const owed = explanations.filter((request) => OWED.has(request.status)).length;
  const waiting = approvals.filter((task) => task.status === 'Pending').length;
  if (owed < SUBMISSIONS_FLOOR.ofEachKind || waiting < SUBMISSIONS_FLOOR.ofEachKind || owed + waiting < SUBMISSIONS_FLOOR.rows) {
    throw new NotEnoughError(`${waiting} papers wait for a decision and ${owed} explanations are owed (at least ${SUBMISSIONS_FLOOR.rows} in all and ${SUBMISSIONS_FLOOR.ofEachKind} of each are needed)`);
  }

  const [unitsRaw, projectsRaw] = await Promise.all([client.readAll('get_resources_organization_unit'), client.readAll('get_resources_project')]);
  const units: SystemTaskUnit[] = unitsRaw.map(record).flatMap((unit) => {
    const id = text(unit.id), code = text(unit.code);
    return id === null || code === null ? [] : [{ id, code }];
  });
  const projects: SystemSubmissionProject[] = projectsRaw.map(record).flatMap((project) => {
    const id = text(project.id), code = text(project.code);
    return id === null || code === null ? [] : [{ id, code, name: text(project.name), investor_unit_id: text(project.investor_unit_id) }];
  });

  return { today, explanations, approvals, projects, units };
}
