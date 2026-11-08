import { ApiError } from '@machvon/api-client';

/** The kinds of record a conversation can be tied to (the operation `linkConversationResource`). */
export const LINK_KINDS = ['project', 'issue', 'contract'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LinkDraft {
  kind: LinkKind;
  resourceId: string;
}

export const emptyLink: LinkDraft = { kind: 'project', resourceId: '' };

export type LinkProblem = 'required' | 'uuid';

/** The record is needed and is the id of one; the server judges whether the person reaches it (403 SCOPE_DENIED, the same as for a record that does not exist for them). */
export function linkProblem(draft: LinkDraft): LinkProblem | undefined {
  if (draft.resourceId.trim() === '') return 'required';
  return UUID.test(draft.resourceId.trim()) ? undefined : 'uuid';
}

export function linkBody(draft: LinkDraft): { resource_type: LinkKind; resource_id: string } {
  return { resource_type: draft.kind, resource_id: draft.resourceId.trim().toLowerCase() };
}

export type LinkRefusal = 'scope' | 'conversationState' | 'conflict' | 'validation' | 'general';

/** The refusal of the server in the words of this panel. */
export function describeLinkRefusal(error: unknown): LinkRefusal {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SCOPE_DENIED':
      return 'scope';
    case 'CONVERSATION_STATE_INVALID':
      return 'conversationState';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'VALIDATION_FAILED':
      return 'validation';
    default:
      return 'general';
  }
}
