import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * What a conversation is linked to, and the issue it is turned into (ST-OMNI-007, OMNI.md 3.4, BR-OMNI-07): a conversation points to the projects, issues and contracts it is about, and an agent may turn it into an issue of a project they are
 * scoped to. Only a summary and a link are copied into the issue, never the words of the person. The rules below are pure.
 */
export const LINK_TYPES = ['project', 'issue', 'contract'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
/** A conversation is not a dossier: it points to a few records, not to everything. */
export const MAX_LINKS_PER_CONVERSATION = 20;
export const SUMMARY_MAX = 500;
export const ISSUE_TYPE_MAX = 60;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface ResourceLink {
  resourceType: LinkType;
  resourceId: string;
}

/** The record a link names: a type the contract knows and the id of a record. */
export function assertResourceLink(raw: { resource_type?: unknown; resource_id?: unknown }): ResourceLink {
  const resourceType = LINK_TYPES.find((candidate) => candidate === raw.resource_type);
  if (resourceType === undefined) throw invalid('resource_type');
  const resourceId = asUuid(raw.resource_id);
  if (resourceId === undefined) throw invalid('resource_id');
  return { resourceType, resourceId };
}

export interface Conversion {
  projectId: string;
  /** The code of the category of the issue, as the tenant defined it. */
  issueType: string;
  summary: string;
}

/**
 * What a conversion may carry: the project, the category of the issue by its code, and a summary of up to 500 characters. The date and the person the contract also names are not taken yet: the deadline of an issue is the one of the SLA policy
 * in force and who works on it is decided by the issue's own assignment, so a date or a person that is given is refused (422 on the field) and not ignored.
 */
export function assertConversion(raw: { project_id?: unknown; issue_type?: unknown; summary?: unknown; due_date?: unknown; assignee_membership_id?: unknown }): Conversion {
  const projectId = asUuid(raw.project_id);
  if (projectId === undefined) throw invalid('project_id');
  const issueType = typeof raw.issue_type === 'string' ? raw.issue_type.trim() : '';
  if (issueType === '' || issueType.length > ISSUE_TYPE_MAX) throw invalid('issue_type');
  const summary = typeof raw.summary === 'string' ? raw.summary.normalize('NFC').trim() : '';
  if (summary === '' || summary.length > SUMMARY_MAX) throw invalid('summary');
  if (raw.due_date !== undefined) throw invalid('due_date');
  if (raw.assignee_membership_id !== undefined) throw invalid('assignee_membership_id');
  return { projectId, issueType, summary };
}

/**
 * The operation id the issue module is given for a conversion (`omni:{conversation}:{version}`, OMNI.md 3.4): the same conversation at the same version is the same request, so a retry never makes a second issue. It is the id of a
 * request, written as a UUID.
 */
export function conversionOperationId(conversationId: string, version: number): string {
  const hash = createHash('sha256').update(`omni:${conversationId}:${version}`, 'utf8').digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** The text of the issue made from a conversation: the summary and the address of the conversation, nothing of what was said. */
export const issueDescriptionOf = (summary: string, conversationId: string): string => `${summary}\n\n/omni/omni-02?id=${conversationId}`;

/** The link of the conversation to a record, as it is kept on the conversation. */
export interface StoredLink {
  resource_type: LinkType;
  resource_id: string;
  linked_at: string;
  linked_by: string;
  /** Set on the issue a conversion made: an issue an agent linked by hand is not the result of one. */
  converted?: true;
}
