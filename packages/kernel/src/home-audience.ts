import { permissionMatches } from './permission.ts';

/**
 * Who the home is laid out for (R53, PWF.md "Lane fix11"): a LEADER gets the figures of the scope and what waits for a decision; an OFFICER gets "today's work", the things that are theirs. The server judges it from what
 * the person holds, once, so that the phone and the web never judge it from a name of a role or from a reading right.
 */
export const HOME_AUDIENCES = ['LEADER', 'OFFICER'] as const;
export type HomeAudience = (typeof HOME_AUDIENCES)[number];

/** The authority that makes a person somebody who decides for a unit: deciding an approval. A right to READ (the workspace of the committee, a dashboard) never does. */
export const HOME_DECISION_PERMISSION = 'approval.decide';

/** The scopes that are a unit or wider. An authority over one project or one contract is the work of an officer of that project. */
export const HOME_UNIT_SCOPES: readonly string[] = ['TENANT', 'UNIT_SUBTREE', 'UNIT_ONLY'];

/** The places of the steering committee that lead it. A member and the secretariat read the workspace and work on their own tasks. */
export const HOME_LEADING_COMMITTEE_ROLES: readonly string[] = ['HEAD', 'DEPUTY'];

/** One authority in force today: the permissions of an active grant, or of an active delegation received, with the kind of its scope. */
export interface HomeAuthority {
  permissions: readonly string[];
  scopeKind: string;
}

export interface HomeAudienceInput {
  /** Only what counts NOW: a grant that ended or has not started, and a delegation that is scheduled, are left out by the caller. */
  authorities: readonly HomeAuthority[];
  /** The place the person holds in the steering committee today, or null. */
  committeeRole: string | null;
}

/** LEADER when the person decides approvals for a unit or wider, or leads the steering committee (head, deputy); OFFICER otherwise. */
export function homeAudienceOf(input: HomeAudienceInput): HomeAudience {
  if (input.committeeRole !== null && HOME_LEADING_COMMITTEE_ROLES.includes(input.committeeRole)) return 'LEADER';
  const decides = input.authorities.some(
    (authority) => HOME_UNIT_SCOPES.includes(authority.scopeKind) && authority.permissions.some((held) => permissionMatches(held, HOME_DECISION_PERMISSION)),
  );
  return decides ? 'LEADER' : 'OFFICER';
}
