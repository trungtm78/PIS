import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../../core/widgets/deadline.dart' show DeadlineBand;
import 'approval_commands.dart';
import 'approval_models.dart';

export '../read_support/offline.dart' show isOffline;

/// Counts the decisions made on this device, so that the inbox, which stays mounted under its tab, reads again after one.
class ApprovalsChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<ApprovalsChanged, int> approvalsChangedProvider = NotifierProvider<ApprovalsChanged, int>(ApprovalsChanged.new);

/// The band of the deadline of a task: red when the server says it is overdue, otherwise the clock. The server has no count of days left
/// for a task and the phone never counts them from its own clock, so there is no yellow here.
DeadlineBand approvalBandOf(ApprovalTask task) => task.overdue ? DeadlineBand.late : DeadlineBand.ok;

/// Why a decision cannot be made now. The reason is always written beside the disabled button, never left to be guessed.
enum DecisionGate { open, offline, notAssigned, notPending, readOnly }

/// Whether the person may decide this task now. Offline wins over everything: a decision is made on the server, in a
/// session that is online, on a task as the server just gave it, never on a copy kept on the device.
DecisionGate gateOf({required ApprovalTask task, required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return DecisionGate.offline;
  if (!task.isPending) return DecisionGate.notPending;
  if (session.isReadOnly) return DecisionGate.readOnly;
  if (!mayDecide(task, sessionReadOnly: session.isReadOnly)) return DecisionGate.notAssigned;
  return DecisionGate.open;
}

String gateText(BuildContext context, DecisionGate gate) {
  switch (gate) {
    case DecisionGate.open:
      return '';
    case DecisionGate.offline:
      return context.t('mob.apv.gate.offline');
    case DecisionGate.notAssigned:
      return context.t('mob.apv.gate.notAssigned');
    case DecisionGate.notPending:
      return context.t('mob.apv.gate.notPending');
    case DecisionGate.readOnly:
      return context.t('mob.apv.gate.readOnly');
  }
}

/// The name of a kind of record. Each key is written out so the string check can see it is in use.
String businessTypeLabel(BuildContext context, String code) {
  switch (code) {
    case 'report.accept':
      return context.t('mob.apv.type.reportAccept');
    case 'plan.publish':
      return context.t('mob.apv.type.planPublish');
    case 'payment.approve':
      return context.t('mob.apv.type.paymentApprove');
    case 'contract.change':
      return context.t('mob.apv.type.contractChange');
    case 'period.reopen':
      return context.t('mob.apv.type.periodReopen');
    default:
      return context.t('mob.apv.type.other');
  }
}

/// The kinds of record the inbox can be narrowed to.
const List<String> businessTypes = <String>['report.accept', 'plan.publish', 'payment.approve', 'contract.change', 'period.reopen'];

String taskStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'Pending':
      return context.t('mob.apv.detail.status.pending');
    case 'Reassigned':
      return context.t('mob.apv.detail.status.reassigned');
    case 'Cancelled':
      return context.t('mob.apv.detail.status.cancelled');
    case 'Expired':
      return context.t('mob.apv.detail.status.expired');
    default:
      return context.t('mob.apv.detail.status.decided');
  }
}

String cellLabel(BuildContext context, String bucket, String level) {
  switch ('$bucket:$level') {
    case 'CURRENT_YEAR:CENTRAL':
      return context.t('mob.apv.cell.currentYear.central');
    case 'CURRENT_YEAR:LOCAL':
      return context.t('mob.apv.cell.currentYear.local');
    case 'CARRYOVER:CENTRAL':
      return context.t('mob.apv.cell.carryover.central');
    case 'CARRYOVER:LOCAL':
      return context.t('mob.apv.cell.carryover.local');
    case 'OTHER:CENTRAL':
      return context.t('mob.apv.cell.other.central');
    default:
      return context.t('mob.apv.cell.other.local');
  }
}

String problemText(BuildContext context, DecisionProblem problem) {
  switch (problem) {
    case DecisionProblem.selfApproval:
      return context.t('mob.apv.problem.selfApproval');
    case DecisionProblem.stepUp:
      return context.t('mob.apv.problem.stepUp');
    case DecisionProblem.notAuthorized:
      return context.t('mob.apv.problem.notAuthorized');
    case DecisionProblem.alreadyDecided:
      return context.t('mob.apv.problem.alreadyDecided');
    case DecisionProblem.versionConflict:
      return context.t('mob.apv.problem.versionConflict');
    case DecisionProblem.notRunning:
      return context.t('mob.apv.problem.notRunning');
    case DecisionProblem.periodLocked:
      return context.t('mob.apv.problem.periodLocked');
    case DecisionProblem.licenseExpired:
      return context.t('mob.apv.problem.licenseExpired');
    case DecisionProblem.denied:
      return context.t('mob.apv.problem.denied');
    case DecisionProblem.notFound:
      return context.t('mob.apv.problem.notFound');
    case DecisionProblem.validation:
      return context.t('mob.apv.problem.validation');
    case DecisionProblem.sessionEnded:
      return context.t('mob.apv.problem.sessionEnded');
    case DecisionProblem.general:
      return context.t('mob.apv.problem.general');
  }
}

String returnProblemText(BuildContext context, ReturnProblem problem) {
  switch (problem) {
    case ReturnProblem.reasonRequired:
      return context.t('mob.apv.return.error.reasonRequired');
    case ReturnProblem.reasonTooLong:
      return context.t('mob.apv.return.error.reasonTooLong');
    case ReturnProblem.sectionsRequired:
      return context.t('mob.apv.return.error.sectionsRequired');
    case ReturnProblem.sectionTooShort:
      return context.t('mob.apv.return.error.sectionTooShort');
    case ReturnProblem.sectionTooLong:
      return context.t('mob.apv.return.error.sectionTooLong');
    case ReturnProblem.tooManySections:
      return context.t('mob.apv.return.error.tooManySections');
    case ReturnProblem.dueRequired:
      return context.t('mob.apv.return.error.dueRequired');
    case ReturnProblem.dueInvalid:
      return context.t('mob.apv.return.error.dueInvalid');
  }
}
