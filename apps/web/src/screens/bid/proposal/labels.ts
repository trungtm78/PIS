import type { useTranslation } from '../../../i18n';
import type { ConflictDecision, DeclareProblem, DecideProblem, DeclarationStanding, IntakeProblem, Problem, ProposalAccess, ProposalPart, ProposalStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: ProposalStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('bid.proposals.status.received');
    case 'SUPERSEDED':
      return t('bid.proposals.status.superseded');
    case 'WITHDRAWN':
      return t('bid.proposals.status.withdrawn');
  }
}

/** What the caller sees of a proposal and why: the full proposal, the receipt only (sealed until the opening, or for whoever only receives), or a proposal waiting for the declaration. */
export function accessLabel(t: Translate, access: ProposalAccess, locked: boolean): string {
  switch (access) {
    case 'FULL':
      return t('bid.proposals.access.full');
    case 'DECLARATION_REQUIRED':
      return t('bid.proposals.access.declaration');
    case 'METADATA':
      return locked ? t('bid.proposals.access.locked') : t('bid.proposals.access.metadata');
  }
}

export function partLabel(t: Translate, part: ProposalPart): string {
  switch (part) {
    case 'LEGAL':
      return t('bid.proposals.part.legal');
    case 'TECHNICAL':
      return t('bid.proposals.part.technical');
    case 'FINANCIAL':
      return t('bid.proposals.part.financial');
    case 'OTHER':
      return t('bid.proposals.part.other');
  }
}

export function decisionLabel(t: Translate, decision: ConflictDecision): string {
  switch (decision) {
    case 'ALLOWED':
      return t('bid.conflict.decision.allowed');
    case 'RECUSED':
      return t('bid.conflict.decision.recused');
    case 'BLOCKED':
      return t('bid.conflict.decision.blocked');
  }
}

export function standingLabel(t: Translate, standing: DeclarationStanding): string {
  switch (standing) {
    case 'CLEAR':
      return t('bid.conflict.standing.clear');
    case 'PENDING':
      return t('bid.conflict.standing.pending');
    case 'ALLOWED':
      return t('bid.conflict.standing.allowed');
    case 'RECUSED':
      return t('bid.conflict.standing.recused');
    case 'BLOCKED':
      return t('bid.conflict.standing.blocked');
  }
}

/** The sentence about the member's own declaration, shown above the proposals. */
export function ownStandingText(t: Translate, standing: DeclarationStanding): string {
  switch (standing) {
    case 'CLEAR':
      return t('bid.conflict.own.clear');
    case 'PENDING':
      return t('bid.conflict.own.pending');
    case 'ALLOWED':
      return t('bid.conflict.own.allowed');
    case 'RECUSED':
      return t('bid.conflict.own.recused');
    case 'BLOCKED':
      return t('bid.conflict.own.blocked');
  }
}

export function intakeProblemMessage(t: Translate, problem: IntakeProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.proposals.problem.required');
    case 'date':
      return t('bid.proposals.problem.date');
    case 'future':
      return t('bid.proposals.problem.future');
    case 'digits':
      return t('bid.proposals.problem.digits');
    case 'files':
      return t('bid.proposals.problem.files');
    case 'tooMany':
      return t('bid.proposals.problem.tooMany');
    case 'title':
      return t('bid.proposals.problem.title');
    case 'notUploaded':
      return t('bid.proposals.problem.notUploaded');
  }
}

export function declareProblemMessage(t: Translate, problem: DeclareProblem): string {
  switch (problem) {
    case 'answer':
      return t('bid.conflict.problem.answer');
    case 'relation':
      return t('bid.conflict.problem.relation');
    case 'tooLong':
      return t('bid.conflict.problem.tooLong');
  }
}

export function decideProblemMessage(t: Translate, problem: DecideProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.conflict.problem.decision');
    case 'short':
      return t('bid.conflict.problem.reasonShort');
    case 'tooLong':
      return t('bid.conflict.problem.tooLong');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'bidClosed':
      return t('bid.proposals.error.bidClosed');
    case 'openingUnset':
      return t('bid.proposals.error.openingUnset');
    case 'restricted':
      return t('bid.proposals.error.restricted');
    case 'notVerified':
      return t('bid.proposals.error.notVerified');
    case 'packageState':
      return t('bid.proposals.error.packageState');
    case 'alreadyDeclared':
      return t('bid.conflict.error.alreadyDeclared');
    case 'undeclared':
      return t('bid.proposals.error.undeclared');
    case 'selfApproval':
      return t('bid.conflict.error.selfApproval');
    case 'versionConflict':
      return t('bid.conflict.error.versionConflict');
    case 'noConflict':
      return t('bid.conflict.error.noConflict');
    case 'notPdf':
      return t('bid.proposals.error.notPdf');
    case 'notClean':
      return t('bid.proposals.error.notClean');
    case 'tooLarge':
      return t('bid.proposals.error.tooLarge');
    case 'fileUsed':
      return t('bid.proposals.error.fileUsed');
    case 'validation':
      return t('bid.proposals.error.validation');
    case 'notFound':
      return t('bid.proposals.error.notFound');
    case 'denied':
      return t('bid.proposals.error.denied');
    case 'session':
      return t('bid.proposals.error.session');
    case 'general':
      return t('bid.proposals.error.general');
  }
}
