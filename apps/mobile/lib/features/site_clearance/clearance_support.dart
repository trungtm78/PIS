import 'package:flutter/material.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'clearance_commands.dart';
import 'clearance_models.dart';
import 'inventory_rules.dart';

export '../read_support/offline.dart' show isOffline;

/// Why a record cannot be sent, or the answer of a household recorded, now. The reason is written beside the disabled button.
enum ClearanceGate { open, offline, readOnly }

/// Sending a kept record needs the network and a session that may change things. The answer of a household needs the same and, since it
/// is made on the server under the version of the record, never on a copy kept on the device ([fromCopy]).
ClearanceGate gateOf({required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return ClearanceGate.offline;
  if (session.isReadOnly) return ClearanceGate.readOnly;
  return ClearanceGate.open;
}

String gateText(BuildContext context, ClearanceGate gate) {
  switch (gate) {
    case ClearanceGate.open:
      return '';
    case ClearanceGate.offline:
      return context.t('mob.clearance.gate.offline');
    case ClearanceGate.readOnly:
      return context.t('mob.clearance.gate.readOnly');
  }
}

/// Whether the officer may record the answer of the household to a record: it is a draft, and somebody else counted it (the server
/// judges the same: 403 `SELF_APPROVAL_DENIED`).
bool mayAnswer(InventoryRecord record, String? membershipId) => record.isDraft && membershipId != null && record.surveyedBy.toLowerCase() != membershipId.toLowerCase();

String itemKindLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'LAND':
      return context.t('mob.clearance.kind.land');
    case 'HOUSE':
      return context.t('mob.clearance.kind.house');
    case 'STRUCTURE':
      return context.t('mob.clearance.kind.structure');
    case 'CROP':
      return context.t('mob.clearance.kind.crop');
    case 'TREE':
      return context.t('mob.clearance.kind.tree');
    case 'GRAVE':
      return context.t('mob.clearance.kind.grave');
    case 'BUSINESS_LOSS':
      return context.t('mob.clearance.kind.businessLoss');
    default:
      return context.t('mob.clearance.kind.other');
  }
}

String recordStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'CONFIRMED':
      return context.t('mob.clearance.record.status.confirmed');
    case 'DISPUTED':
      return context.t('mob.clearance.record.status.disputed');
    case 'SUPERSEDED':
      return context.t('mob.clearance.record.status.superseded');
    default:
      return context.t('mob.clearance.record.status.draft');
  }
}

String householdStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'INVENTORIED':
      return context.t('mob.clearance.household.status.inventoried');
    case 'PLAN_LISTED':
      return context.t('mob.clearance.household.status.planListed');
    case 'COMPENSATED':
      return context.t('mob.clearance.household.status.compensated');
    case 'RESETTLED':
      return context.t('mob.clearance.household.status.resettled');
    case 'CLOSED':
      return context.t('mob.clearance.household.status.closed');
    case 'DISPUTED':
      return context.t('mob.clearance.household.status.disputed');
    default:
      return context.t('mob.clearance.household.status.registered');
  }
}

String legalBasisLabel(BuildContext context, String basis) {
  switch (basis) {
    case 'CONSENT':
      return context.t('mob.clearance.basis.consent');
    case 'LEGAL_OBLIGATION':
      return context.t('mob.clearance.basis.obligation');
    default:
      return context.t('mob.clearance.basis.publicTask');
  }
}

String rightKindLabel(BuildContext context, String? right) {
  switch (right) {
    case 'OWNER':
      return context.t('mob.clearance.right.owner');
    case 'USER':
      return context.t('mob.clearance.right.user');
    case 'LESSEE':
      return context.t('mob.clearance.right.lessee');
    case 'OCCUPANT_NO_TITLE':
      return context.t('mob.clearance.right.occupant');
    default:
      return context.t('mob.clearance.right.unknown');
  }
}

String inventoryProblemText(BuildContext context, InventoryProblem problem) {
  switch (problem) {
    case InventoryProblem.parcelRequired:
      return context.t('mob.clearance.form.parcelRequired');
    case InventoryProblem.kindRequired:
      return context.t('mob.clearance.form.kindRequired');
    case InventoryProblem.descriptionRequired:
      return context.t('mob.clearance.form.descriptionRequired');
    case InventoryProblem.descriptionTooLong:
      return context.t('mob.clearance.form.descriptionTooLong');
    case InventoryProblem.descriptionInvalid:
      return context.t('mob.clearance.form.descriptionInvalid');
    case InventoryProblem.quantityRequired:
      return context.t('mob.clearance.form.quantityRequired');
    case InventoryProblem.quantityInvalid:
      return context.t('mob.clearance.form.quantityInvalid');
    case InventoryProblem.unitRequired:
      return context.t('mob.clearance.form.unitRequired');
    case InventoryProblem.unitTooLong:
      return context.t('mob.clearance.form.unitTooLong');
    case InventoryProblem.unitInvalid:
      return context.t('mob.clearance.form.unitInvalid');
    case InventoryProblem.priceRequired:
      return context.t('mob.clearance.form.priceRequired');
    case InventoryProblem.priceInvalid:
      return context.t('mob.clearance.form.priceInvalid');
    case InventoryProblem.referenceRequired:
      return context.t('mob.clearance.form.referenceRequired');
    case InventoryProblem.referenceTooLong:
      return context.t('mob.clearance.form.referenceTooLong');
    case InventoryProblem.referenceInvalid:
      return context.t('mob.clearance.form.referenceInvalid');
    case InventoryProblem.dayRequired:
      return context.t('mob.clearance.form.dayRequired');
    case InventoryProblem.dayInvalid:
      return context.t('mob.clearance.form.dayInvalid');
  }
}

String answerProblemText(BuildContext context, AnswerProblem problem) {
  switch (problem) {
    case AnswerProblem.outcomeRequired:
      return context.t('mob.clearance.answer.outcomeRequired');
    case AnswerProblem.dayRequired:
      return context.t('mob.clearance.answer.dayRequired');
    case AnswerProblem.dayInvalid:
      return context.t('mob.clearance.answer.dayInvalid');
    case AnswerProblem.dayBeforeSurvey:
      return context.t('mob.clearance.answer.dayBeforeSurvey');
    case AnswerProblem.noteRequired:
      return context.t('mob.clearance.answer.noteRequired');
    case AnswerProblem.noteTooLong:
      return context.t('mob.clearance.answer.noteTooLong');
    case AnswerProblem.noteInvalid:
      return context.t('mob.clearance.answer.noteInvalid');
  }
}

String problemText(BuildContext context, ClearanceProblem problem) {
  switch (problem) {
    case ClearanceProblem.consentRequired:
      return context.t('mob.clearance.problem.consentRequired');
    case ClearanceProblem.legalBasis:
      return context.t('mob.clearance.problem.legalBasis');
    case ClearanceProblem.priceDecision:
      return context.t('mob.clearance.problem.priceDecision');
    case ClearanceProblem.parcelNotLinked:
      return context.t('mob.clearance.problem.parcelNotLinked');
    case ClearanceProblem.selfApproval:
      return context.t('mob.clearance.problem.selfApproval');
    case ClearanceProblem.stateInvalid:
      return context.t('mob.clearance.problem.stateInvalid');
    case ClearanceProblem.versionConflict:
      return context.t('mob.clearance.problem.versionConflict');
    case ClearanceProblem.documentNotClean:
      return context.t('mob.clearance.problem.documentNotClean');
    case ClearanceProblem.stepUp:
      return context.t('mob.clearance.problem.stepUp');
    case ClearanceProblem.licenseExpired:
      return context.t('mob.clearance.problem.licenseExpired');
    case ClearanceProblem.validation:
      return context.t('mob.clearance.problem.validation');
    case ClearanceProblem.notFound:
      return context.t('mob.clearance.problem.notFound');
    case ClearanceProblem.denied:
      return context.t('mob.clearance.problem.denied');
    case ClearanceProblem.sessionEnded:
      return context.t('mob.clearance.problem.sessionEnded');
    case ClearanceProblem.general:
      return context.t('mob.clearance.problem.general');
  }
}
