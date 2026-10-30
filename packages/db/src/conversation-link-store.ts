import { DomainError, MAX_LINKS_PER_CONVERSATION, conversionOperationId, issueDescriptionOf, versionConflict } from '@machvon/kernel';
import type { Conversion, LinkType, ResourceLink, StoredLink } from '@machvon/kernel';
import { ConversationStore } from './conversation-store.ts';
import type { ConversationRecord, ScopeOf } from './conversation-store.ts';
import { ISSUE_CATEGORY_TYPE } from './iss-sla-policy-store.ts';
import { IssIssueStore } from './iss-issue-store.ts';
import type { CreatedIssue, IssuePlace } from './iss-issue-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const CONVERT_PERMISSION = 'omni.conversation.convert';
const REPLY_PERMISSION = 'omni.conversation.reply';
/** The severity an issue made from a conversation starts with: the contract of the conversion names none, and whoever works the issue raises or lowers it. */
const CONVERTED_SEVERITY = 'MEDIUM';
const PROJECT_LIST_MAX = 500;
/** A tenant has no more projects than this; a scan for the ones the agent may convert at stops here. */
const PROJECT_SCAN_MAX = 20_000;
const PROJECT_PAGE = 500;
const TYPE_LIST_MAX = 200;

export interface ConversionOptions {
  projects: Array<{ id: string; code: string; name: string }>;
  issueTypes: Array<{ code: string; label: string }>;
}

/**
 * The records a conversation points to, and the issue it becomes (ST-OMNI-007, OMNI.md 3.4). The links are kept on the conversation, one entry for each record. The authority over a record is decided by the caller through `authorize`, which is
 * given the place of the record (its unit, its project): a record the person may not read is refused (403 `SCOPE_DENIED`) and one that is not there is 404. Every query runs in the caller's tenant transaction.
 */
export class ConversationLinkStore {
  private readonly conversations = new ConversationStore();

  /** The place of a record: its unit and path, and the project and contract it belongs to; nothing when it is not in the tenant. */
  async placeOf(tx: TenantTx, type: LinkType, id: string): Promise<IssuePlace | undefined> {
    if (type === 'project') {
      const [row] = await tx.query<{ owner_unit_id: string; path: string }>('select p.owner_unit_id, u.path from machvon.project p join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id where p.id = $1::uuid', [id]);
      return row === undefined ? undefined : { ownerUnitId: row.owner_unit_id, ownerUnitPath: row.path, projectId: id };
    }
    if (type === 'issue') {
      const [row] = await tx.query<{ owner_unit_id: string; path: string; project_id: string; contract_id: string | null }>(
        'select i.owner_unit_id, u.path, i.project_id, i.contract_id from machvon.issue i join machvon.organization_unit u on u.tenant_id = i.tenant_id and u.id = i.owner_unit_id where i.id = $1::uuid',
        [id],
      );
      return row === undefined ? undefined : { ownerUnitId: row.owner_unit_id, ownerUnitPath: row.path, projectId: row.project_id, ...(row.contract_id === null ? {} : { contractId: row.contract_id }) };
    }
    const [row] = await tx.query<{ owner_unit_id: string; path: string; project_id: string }>(
      'select p.owner_unit_id, u.path, c.project_id from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id where c.id = $1::uuid',
      [id],
    );
    return row === undefined ? undefined : { ownerUnitId: row.owner_unit_id, ownerUnitPath: row.path, projectId: row.project_id, contractId: id };
  }

  private async lockedConversation(tx: TenantTx, scope: ScopeOf, id: string, permission: string, expectedVersion: number): Promise<ConversationRecord> {
    await tx.query('select 1 from machvon.conversation where id = $1::uuid for update', [id]);
    const found = await this.conversations.find(tx, scope, id, permission);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.status === 'Closed') throw new DomainError('CONVERSATION_STATE_INVALID', 409, 'status');
    if (found.version !== expectedVersion) throw versionConflict(found.version);
    return found;
  }

  private async linksOf(tx: TenantTx, id: string): Promise<StoredLink[]> {
    const [row] = await tx.query<{ resource_links: StoredLink[] }>('select resource_links from machvon.conversation where id = $1::uuid', [id]);
    return row?.resource_links ?? [];
  }

  private async append(tx: TenantTx, id: string, added: StoredLink[]): Promise<void> {
    await tx.query('update machvon.conversation set resource_links = resource_links || $2::jsonb, version = version + 1 where id = $1::uuid', [id, JSON.stringify(added)]);
  }

  /**
   * Links the conversation to a record at the version read. The conversation is in the scope of the agent for the permission to answer; the record must be one the person may read (`authorize` throws 403 `SCOPE_DENIED` with its place), and one that
   * is not in the tenant is 404. A record that is linked already is left as it is (nothing changes, not even the version); a conversation points to at most 20 records (422).
   */
  async link(
    tx: TenantTx,
    scope: ScopeOf,
    id: string,
    expectedVersion: number,
    link: ResourceLink,
    authorize: (type: LinkType, place: IssuePlace) => void,
  ): Promise<{ before: ConversationRecord; after: ConversationRecord }> {
    const before = await this.lockedConversation(tx, scope, id, REPLY_PERMISSION, expectedVersion);
    const place = await this.placeOf(tx, link.resourceType, link.resourceId);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    authorize(link.resourceType, place);
    const links = await this.linksOf(tx, id);
    if (links.some((existing) => existing.resource_type === link.resourceType && existing.resource_id === link.resourceId)) return { before, after: before };
    if (links.length >= MAX_LINKS_PER_CONVERSATION) throw new DomainError('VALIDATION_FAILED', 422, 'resource_id');
    await this.append(tx, id, [{ resource_type: link.resourceType, resource_id: link.resourceId, linked_at: scope.now.toISOString(), linked_by: scope.membershipId }]);
    const after = await this.conversations.find(tx, scope, id, REPLY_PERMISSION);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  /** The projects the agent may convert a conversation into an issue of (the ones their permission covers) and the categories the tenant defined for issues: what OMNI-09 offers, and nothing else. */
  async options(tx: TenantTx, mayConvert: (place: IssuePlace) => boolean): Promise<ConversionOptions> {
    // The scope is applied before the list is cut: the projects are read a page at a time by (code, id) and only the ones the agent may convert at are kept, so one scoped to a project far down the list still finds it.
    const projects: ConversionOptions['projects'] = [];
    let after: { code: string; id: string } | undefined;
    for (let scanned = 0; scanned < PROJECT_SCAN_MAX && projects.length < PROJECT_LIST_MAX; scanned += PROJECT_PAGE) {
      const page = await tx.query<{ id: string; code: string; name: string; owner_unit_id: string; path: string }>(
        `select p.id, p.code, p.name, p.owner_unit_id, u.path from machvon.project p join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id
          where $1::text is null or (p.code, p.id) > ($1::text, $2::uuid) order by p.code, p.id limit ${PROJECT_PAGE}`,
        [after?.code ?? null, after?.id ?? null],
      );
      for (const row of page) if (projects.length < PROJECT_LIST_MAX && mayConvert({ ownerUnitId: row.owner_unit_id, ownerUnitPath: row.path, projectId: row.id })) projects.push({ id: row.id, code: row.code, name: row.name });
      const last = page[page.length - 1];
      if (page.length < PROJECT_PAGE || last === undefined) break;
      after = { code: last.code, id: last.id };
    }
    const types = await tx.query<{ business_key: string; label: string }>(
      `select r.business_key, v.label from machvon.master_record r join machvon.master_record_version v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
        where r.master_type = $1 and r.status = 'EFFECTIVE' order by r.business_key limit ${TYPE_LIST_MAX}`,
      [ISSUE_CATEGORY_TYPE],
    );
    return {
      projects,
      issueTypes: types.map((row) => ({ code: row.business_key, label: row.label })),
    };
  }

  /**
   * Turns the conversation into an issue of a project (OMNI.md 3.4): the conversation is in the scope of the agent for the permission to convert, not closed, at the version read, and not turned into an issue before (409
   * `CONVERSATION_ALREADY_CONVERTED`); the project must be one the agent is scoped to (403 `SCOPE_DENIED`, 404 if it is not there); the category is one the tenant defined (422 on `issue_type`). The issue is made by the issue module in this transaction, under the
   * operation id of the conversation and its version, with a summary and the address of the conversation only; whatever the issue module refuses is 422 `ISSUE_COMMAND_REJECTED` with its own code. The conversation then points to the issue and the project.
   */
  async convert(
    tx: TenantTx,
    scope: ScopeOf,
    id: string,
    expectedVersion: number,
    conversion: Conversion,
    authorize: (place: IssuePlace) => void,
    issues: Pick<IssIssueStore, 'create'> = new IssIssueStore(),
  ): Promise<{ before: ConversationRecord; after: ConversationRecord; issue: CreatedIssue }> {
    const before = await this.lockedConversation(tx, scope, id, CONVERT_PERMISSION, expectedVersion);
    const links = await this.linksOf(tx, id);
    // Only an issue a conversion made counts: one linked by hand is a record the conversation is about.
    if (links.some((existing) => existing.converted === true)) throw new DomainError('CONVERSATION_ALREADY_CONVERTED', 409);
    const place = await this.placeOf(tx, 'project', conversion.projectId);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    authorize(place);
    const projectLinked = links.some((existing) => existing.resource_type === 'project' && existing.resource_id === conversion.projectId);
    // The links the conversion adds (the issue, and the project when it is not linked yet) keep the conversation within its limit, as a link made by hand does.
    if (links.length + (projectLinked ? 1 : 2) > MAX_LINKS_PER_CONVERSATION) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const [category] = await tx.query<{ current_version_id: string }>(
      "select current_version_id from machvon.master_record where master_type = $1 and business_key = $2 and status = 'EFFECTIVE' and current_version_id is not null",
      [ISSUE_CATEGORY_TYPE, conversion.issueType],
    );
    if (category === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'issue_type');
    let issue: CreatedIssue;
    try {
      issue = await issues.create(
        tx,
        {
          projectId: conversion.projectId,
          categoryVersionId: category.current_version_id,
          severity: CONVERTED_SEVERITY,
          title: conversion.summary,
          description: issueDescriptionOf(conversion.summary, id),
          ownerUnitId: place.ownerUnitId,
          clientOperationId: conversionOperationId(id, before.version),
        },
        scope.membershipId,
        scope.now,
        authorize,
      );
    } catch (error) {
      // The authority is this module's to refuse; anything else the issue module refuses is told with its own code.
      if (!(error instanceof DomainError) || error.code === 'SCOPE_DENIED') throw error;
      throw new DomainError('ISSUE_COMMAND_REJECTED', 422, undefined, { extensions: { issue_error_code: error.code } });
    }
    const stamp = { linked_at: scope.now.toISOString(), linked_by: scope.membershipId };
    const added: StoredLink[] = [{ resource_type: 'issue', resource_id: issue.id, ...stamp, converted: true }];
    if (!projectLinked) added.push({ resource_type: 'project', resource_id: conversion.projectId, ...stamp });
    await this.append(tx, id, added);
    const after = await this.conversations.find(tx, scope, id, CONVERT_PERMISSION);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after, issue };
  }
}
