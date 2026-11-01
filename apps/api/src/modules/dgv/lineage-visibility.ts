import { PERMISSIONS } from '@machvon/contracts';
import { BiDashboardStore, BiPolicyStore, BiQueryStore, DgvDatasetStore, SCOPE_FROM, projectScope } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, activeGrants, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, GraphNode } from '@machvon/kernel';

const METRIC_READ = PERMISSIONS.get_resources_metric_definition;
const PROJECT_READ = PERMISSIONS.get_resources_project;
const DASHBOARD_READ = PERMISSIONS.getDashboard;
const CATALOGUE_READ = PERMISSIONS.searchCatalog;
const BI_DATASET_READ = PERMISSIONS.listBiDatasets;

/** Whether the person holds the permission through any grant in force now. */
const holds = (access: EffectiveAccess, permission: string, now: Date): boolean =>
  access.membershipActive && activeGrants(access, now).some((grant) => holdsPermission(new Set(grant.permissions), permission));

/** Whether the person holds the permission over the whole tenant. */
const holdsOnWholeTenant = (access: EffectiveAccess, permission: string, now: Date): boolean =>
  access.membershipActive && activeGrants(access, now).some((grant) => grant.scope.kind === 'TENANT' && holdsPermission(new Set(grant.permissions), permission));

/**
 * Who may see a node of the lineage graph (ST-DGV-006, BR-DGV-11): the right to the object the node stands for, as the person has it now. A dashboard version is seen by whoever sees the dashboard; a metric by whoever
 * reads the catalogue of metrics; a dataset or a version of one by whoever an access policy opens it to; a record by whoever reads the project it is of; a source system, an import batch, a table and an export name no data of
 * their own and are seen by whoever reads the lineage, unless they are classified above internal use. A node classified as personal data or as core data is seen only by whoever holds the right over the whole tenant.
 * Whatever cannot be told is hidden: a node is shown only when a rule shows it.
 */
export class LineageVisibility {
  private readonly dashboards = new BiDashboardStore();
  private readonly policies = new BiPolicyStore();
  private readonly queries = new BiQueryStore();
  private readonly catalogue = new DgvDatasetStore();

  constructor(
    private readonly tx: TenantTx,
    private readonly viewer: { membershipId: string; access: EffectiveAccess; now: Date },
  ) {}

  /** The ids of the nodes the person may see. Sequential: the queries of a transaction share a connection. */
  async visible(nodes: readonly GraphNode[]): Promise<Set<string>> {
    const shown = new Set<string>();
    const requester = await this.queries.requesterOf(this.tx, this.viewer.membershipId);
    for (const node of nodes) if (await this.sees(node, requester)) shown.add(node.id);
    return shown;
  }

  /** The dataset a node stands for: the dataset itself, or the dataset a version belongs to, whatever state the version is in. */
  private async datasetOf(kind: 'DATASET' | 'DATASET_VERSION', refId: string): Promise<string | undefined> {
    const rows = await this.tx.query<{ id: string }>(
      kind === 'DATASET' ? 'select id from machvon.bi_dataset where id = $1::uuid' : 'select dataset_id as id from machvon.bi_dataset_version where id = $1::uuid',
      [refId],
    );
    return rows[0]?.id;
  }

  private async sees(node: GraphNode, requester: { roleIds: string[]; unitIds: string[] }): Promise<boolean> {
    const { access, now, membershipId } = this.viewer;
    const whole = holdsOnWholeTenant(access, PERMISSIONS.getLineageGraph, now);
    if ((node.classification === 'PERSONAL' || node.classification === 'IMPORTANT_CORE') && !whole) return false;
    switch (node.nodeKind) {
      case 'METRIC_VERSION':
        return holds(access, METRIC_READ, now);
      case 'DASHBOARD_VERSION':
        return holds(access, DASHBOARD_READ, now) && node.refId !== null && (await this.dashboards.findVersion(this.tx, node.refId, membershipId)) !== undefined;
      case 'DATASET':
      case 'DATASET_VERSION': {
        // A dataset of the catalogue of DGV is seen as the catalogue shows it (its roles and its classification); any other is a dataset of BI, seen by the policy that opens it.
        if (node.nodeKind === 'DATASET' && node.refModule === 'DGV')
          return (
            holds(access, CATALOGUE_READ, now) &&
            node.refId !== null &&
            (await this.catalogue.find(this.tx, node.refId, { membershipId, roleCodes: [...new Set(activeGrants(access, now).map((grant) => grant.roleCode))] })) !== undefined
          );
        // A dataset is told only by the policy that opens it, and a reference that cannot be resolved to a dataset of the tenant is hidden: nothing is shown for lack of an answer.
        if (node.refId === null || !holds(access, BI_DATASET_READ, now)) return false;
        const datasetId = await this.datasetOf(node.nodeKind, node.refId);
        if (datasetId === undefined) return false;
        return this.policies.applicable(this.tx, datasetId, { membershipId, ...requester }).then(
          () => true,
          (error: unknown) => {
            if (error instanceof DomainError && error.code === 'ACCESS_POLICY_MISSING') return false;
            throw error;
          },
        );
      }
      case 'RECORD': {
        // A record is told only to whoever may read the project it is of (the right of the project, over the projects they read), as well as the lineage: the lineage never tells what the source would refuse.
        if (node.refId === null || !holds(access, PERMISSIONS.getLineageGraph, now)) return false;
        const scope = projectScope(access, PROJECT_READ, now)(2);
        // A record of the disbursement dataset is a line of a snapshot: it is of the project of the line; any other record is named by the project itself.
        const project = node.refModule === 'DIS' ? '(select project_id from machvon.period_snapshot_line where id = $1::uuid)' : '$1::uuid';
        const rows = await this.tx.query(`select 1 from ${SCOPE_FROM} where p.id = ${project} and ${scope.sql}`, [node.refId, ...scope.params]);
        return rows.length > 0;
      }
      default:
        return holds(access, PERMISSIONS.getLineageGraph, now) && (node.classification === 'PUBLIC' || node.classification === 'INTERNAL');
    }
  }
}
