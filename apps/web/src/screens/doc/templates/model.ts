import type { Template } from './types';

/** What the library may offer a person on one revision. Each step is its own permission and never the person's own work. */
export interface TemplateActions {
  publish: boolean;
  /** The revision waits for a publisher, and this person drafted it: someone else has to publish it. */
  publishNeedsOther: boolean;
  confirm: boolean;
  /** The revision waits for the legal confirmation, and this person drafted or published it. */
  confirmNeedsOther: boolean;
  retire: boolean;
}

export interface ActionContext {
  membershipId: string | undefined;
  /** `undefined` while the grants are not known (the server decides); otherwise the permissions of the person. */
  permissions: readonly string[] | undefined;
  frozen: boolean;
  manage: string;
  approve: string;
  confirmLegal: string;
}

const holds = (context: ActionContext, permission: string): boolean => context.permissions === undefined || context.permissions.includes(permission);

/**
 * The steps open to the person on a revision (the server checks them again): a draft is published by someone other than its
 * drafter, a published revision that waits for its confirmation is confirmed by someone who neither drafted nor published it,
 * and a draft or published revision is retired by whoever manages templates. A suspended tenant offers nothing.
 */
export function actionsFor(template: Template, context: ActionContext): TemplateActions {
  const none: TemplateActions = { publish: false, publishNeedsOther: false, confirm: false, confirmNeedsOther: false, retire: false };
  if (context.frozen) return none;
  const me = context.membershipId?.toLowerCase();
  const sameAs = (id: string | null): boolean => me !== undefined && id !== null && id.toLowerCase() === me;
  const waitingForPublisher = template.status === 'DRAFT' && holds(context, context.approve);
  const waitingForLegal = template.status === 'PUBLISHED' && template.confirmationStatus === 'PENDING_CONFIRMATION' && holds(context, context.confirmLegal);
  const ownWork = sameAs(template.createdBy) || sameAs(template.approvedBy);
  return {
    publish: waitingForPublisher && !sameAs(template.createdBy),
    publishNeedsOther: waitingForPublisher && sameAs(template.createdBy),
    confirm: waitingForLegal && !ownWork,
    confirmNeedsOther: waitingForLegal && ownWork,
    retire: (template.status === 'DRAFT' || template.status === 'PUBLISHED') && holds(context, context.manage),
  };
}

/** The `[CXN-10]` tags the label of a revision that waits for its confirmation shows; `[CXN]` when its text names none. */
export function cxnTags(template: Template): string {
  return template.cxnRefs.length === 0 ? '[CXN]' : template.cxnRefs.map((reference) => `[${reference}]`).join(' ');
}

/** The filter on the page: text over the code, title, form and legal basis. */
export function matchesText(template: Template, filter: string): boolean {
  if (filter.trim() === '') return true;
  const haystack = `${template.templateCode} ${template.title} ${template.formCode ?? ''} ${template.legalBasis} ${template.sourceModule ?? ''}`.toLowerCase();
  return haystack.includes(filter.trim().toLowerCase());
}
