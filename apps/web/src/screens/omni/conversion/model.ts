import { ApiError } from '@machvon/api-client';
import { toConversation } from '../conversation/model';
import type { Conversation } from '../conversation/model';

/** Permissions of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'conversation.read';
export const CONVERT_PERMISSION = 'omni.conversation.convert';

export const SUMMARY_MAX = 500;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

export interface IssueTypeOption {
  code: string;
  label: string;
}

export interface ConversionOptions {
  projects: ProjectOption[];
  issueTypes: IssueTypeOption[];
}

/** The choices of the conversion: only the projects the agent is scoped to and the categories of issues the tenant defined. */
export function toOptions(raw: unknown): ConversionOptions {
  const view: Raw = isRecord(raw) ? raw : {};
  const projects = Array.isArray(view.projects) ? view.projects.flatMap((item) => (isRecord(item) && typeof item.id === 'string' ? [{ id: item.id, code: text(item.code), name: text(item.name) }] : [])) : [];
  const issueTypes = Array.isArray(view.issue_types) ? view.issue_types.flatMap((item) => (isRecord(item) && typeof item.code === 'string' && item.code !== '' ? [{ code: item.code, label: text(item.label) || item.code }] : [])) : [];
  return { projects, issueTypes };
}

/** The conversation as OMNI-09 needs it: the one of the thread, with the issue it was turned into when it was. */
export interface ConvertibleConversation extends Conversation {
  issueId: string | undefined;
}

export function toConvertible(raw: unknown): ConvertibleConversation | undefined {
  const conversation = toConversation(raw);
  if (conversation === undefined) return undefined;
  const links = isRecord(raw) && Array.isArray(raw.resource_links) ? raw.resource_links : [];
  const issue = links.find((link) => isRecord(link) && link.resource_type === 'issue' && link.converted === true && typeof link.resource_id === 'string');
  return { ...conversation, issueId: isRecord(issue) ? text(issue.resource_id) : undefined };
}

/** An issue is made from a conversation that is open and not turned into one before. */
export const mayConvert = (conversation: Pick<ConvertibleConversation, 'status' | 'issueId'>): boolean => conversation.status !== 'Closed' && conversation.issueId === undefined;

export interface Draft {
  projectId: string;
  issueType: string;
  summary: string;
}

export const emptyDraft = (): Draft => ({ projectId: '', issueType: '', summary: '' });

export type Field = 'projectId' | 'issueType' | 'summary';

/** What is wrong with the form before it is sent; the server judges the rest. */
export function draftProblems(draft: Draft): Field[] {
  const problems: Field[] = [];
  if (draft.projectId === '') problems.push('projectId');
  if (draft.issueType === '') problems.push('issueType');
  const summary = draft.summary.trim();
  if (summary === '' || summary.length > SUMMARY_MAX) problems.push('summary');
  return problems;
}

export const conversionBody = (draft: Draft): Record<string, unknown> => ({ project_id: draft.projectId, issue_type: draft.issueType, summary: draft.summary.trim() });

export type ProblemReason = 'invalid' | 'state' | 'already' | 'conflict' | 'denied' | 'notFound' | 'rejected' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  CONVERSATION_STATE_INVALID: 'state',
  CONVERSATION_ALREADY_CONVERTED: 'already',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  ISSUE_COMMAND_REJECTED: 'rejected',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  return { reason: error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general' };
}
