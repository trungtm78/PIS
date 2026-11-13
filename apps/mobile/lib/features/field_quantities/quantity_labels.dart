import 'package:flutter/widgets.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/machvon_semantic.dart';
import 'quantity_commands.dart';
import 'quantity_models.dart';

/// A quantity in the language of the interface: the digits grouped, the decimals marked, nothing turned into a float; what is not a number is
/// returned as typed (the one formatter of the phone, `lib/core/format`).
String quantityLabel(BuildContext context, String value) => formatNumber(value, AppStrings.of(context).language);

String quantityProblemText(BuildContext context, QuantityProblem problem) {
  switch (problem) {
    case QuantityProblem.required:
      return context.t('mob.qty.problem.required');
    case QuantityProblem.tooLong:
      return context.t('mob.qty.problem.tooLong');
    case QuantityProblem.notAQuantity:
      return context.t('mob.qty.problem.notAQuantity');
    case QuantityProblem.notPositive:
      return context.t('mob.qty.problem.notPositive');
    case QuantityProblem.notAnIdentifier:
      return context.t('mob.qty.problem.notAnIdentifier');
  }
}

String measurementStatusText(BuildContext context, String status) {
  switch (status) {
    case 'SUBMITTED':
      return context.t('mob.qty.status.submitted');
    case 'APPROVED':
      return context.t('mob.qty.status.approved');
    case 'REJECTED':
      return context.t('mob.qty.status.rejected');
    case 'SUPERSEDED':
      return context.t('mob.qty.status.superseded');
    default:
      return context.t('mob.qty.status.draft');
  }
}

/// The tone of the pill of a recorded quantity: a draft waits, a sent one is with the approver, an approved one is done, a rejected one needs the maker.
MachvonTone measurementTone(String status) {
  switch (status) {
    case 'SUBMITTED':
      return MachvonTone.info;
    case 'APPROVED':
      return MachvonTone.success;
    case 'REJECTED':
      return MachvonTone.danger;
    default:
      return MachvonTone.neutral;
  }
}

String quantityRefusalText(BuildContext context, QuantityRefusal refusal) {
  switch (refusal) {
    case QuantityRefusal.exceeds:
      return context.t('mob.qty.refusal.exceeds');
    case QuantityRefusal.decrease:
      return context.t('mob.qty.refusal.decrease');
    case QuantityRefusal.duplicateReference:
      return context.t('mob.qty.refusal.duplicateReference');
    case QuantityRefusal.revisionNotEffective:
      return context.t('mob.qty.refusal.revisionNotEffective');
    case QuantityRefusal.permitGate:
      return context.t('mob.qty.refusal.permitGate');
    case QuantityRefusal.inAcceptance:
      return context.t('mob.qty.refusal.inAcceptance');
    case QuantityRefusal.evidenceRequired:
      return context.t('mob.qty.refusal.evidenceRequired');
    case QuantityRefusal.periodTaken:
      return context.t('mob.qty.refusal.periodTaken');
    case QuantityRefusal.measurementState:
      return context.t('mob.qty.refusal.measurementState');
    case QuantityRefusal.versionConflict:
      return context.t('mob.qty.refusal.versionConflict');
    case QuantityRefusal.stepUp:
      return context.t('mob.qty.refusal.stepUp');
    case QuantityRefusal.periodLocked:
      return context.t('mob.qty.refusal.periodLocked');
    case QuantityRefusal.licenseExpired:
      return context.t('mob.qty.refusal.licenseExpired');
    case QuantityRefusal.validation:
      return context.t('mob.qty.refusal.validation');
    case QuantityRefusal.notFound:
      return context.t('mob.qty.refusal.notFound');
    case QuantityRefusal.denied:
      return context.t('mob.qty.refusal.denied');
    case QuantityRefusal.sessionEnded:
      return context.t('mob.qty.refusal.sessionEnded');
    case QuantityRefusal.general:
      return context.t('mob.qty.refusal.general');
  }
}
