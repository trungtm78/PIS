import 'package:flutter/material.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'reconciliation_commands.dart';

export '../read_support/offline.dart' show isOffline;

/// Why a note on a difference cannot be recorded now. Offline and a copy kept on the device come first: it is made on the server, under
/// the version of the item on the screen.
enum ReconGate { open, offline, readOnly }

ReconGate gateOf({required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return ReconGate.offline;
  if (session.isReadOnly) return ReconGate.readOnly;
  return ReconGate.open;
}

String gateText(BuildContext context, ReconGate gate) {
  switch (gate) {
    case ReconGate.open:
      return '';
    case ReconGate.offline:
      return context.t('mob.treasury.gate.offline');
    case ReconGate.readOnly:
      return context.t('mob.treasury.gate.readOnly');
  }
}

String paymentStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'SUBMITTED':
      return context.t('mob.paytrack.status.submitted');
    case 'VERIFIED':
      return context.t('mob.paytrack.status.verified');
    case 'SENT_TREASURY':
      return context.t('mob.paytrack.status.sentTreasury');
    case 'SETTLED':
      return context.t('mob.paytrack.status.settled');
    case 'RETURNED':
      return context.t('mob.paytrack.status.returned');
    case 'CANCELLED':
      return context.t('mob.paytrack.status.cancelled');
    case 'REVERSED':
      return context.t('mob.paytrack.status.reversed');
    default:
      return context.t('mob.paytrack.status.draft');
  }
}

String paymentKindLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'ADVANCE':
      return context.t('mob.paytrack.kind.advance');
    case 'FINAL':
      return context.t('mob.paytrack.kind.final');
    default:
      return context.t('mob.paytrack.kind.interim');
  }
}

String reconKindLabel(BuildContext context, String kind) {
  switch (kind) {
    case 'UNMATCHED_TRANSACTION':
      return context.t('mob.treasury.kind.unmatched');
    case 'MISSING_CONFIRMATION':
      return context.t('mob.treasury.kind.missing');
    case 'DUPLICATE_CONFLICT':
      return context.t('mob.treasury.kind.duplicate');
    case 'ADVANCE_OVERDUE':
      return context.t('mob.treasury.kind.advanceOverdue');
    default:
      return context.t('mob.treasury.kind.mismatch');
  }
}

String reconStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'EXPLAINED':
      return context.t('mob.treasury.status.explained');
    case 'RESOLVED':
      return context.t('mob.treasury.status.resolved');
    case 'WRITTEN_OFF_APPROVED':
      return context.t('mob.treasury.status.writtenOff');
    default:
      return context.t('mob.treasury.status.open');
  }
}

/// An exact amount of whole dong, or that there is none.
String moneyOrNone(BuildContext context, String? vnd) => vnd == null ? context.t('mob.treasury.figure.none') : moneyExactLabel(context, vnd);

/// The difference in words that keep its sign: the confirmed figure less the internal one, so a negative one is a shortfall at the Treasury.
String differenceWords(BuildContext context, String? difference) {
  if (difference == null) return context.t('mob.treasury.difference.none');
  if (difference == '0') return context.t('mob.treasury.difference.zero');
  return difference.startsWith('-') ? context.t('mob.treasury.difference.less') : context.t('mob.treasury.difference.more');
}

String resolveProblemText(BuildContext context, ResolveProblem problem) {
  switch (problem) {
    case ResolveProblem.resolutionRequired:
      return context.t('mob.treasury.form.resolutionRequired');
    case ResolveProblem.noteRequired:
      return context.t('mob.treasury.form.noteRequired');
    case ResolveProblem.noteTooLong:
      return context.t('mob.treasury.form.noteTooLong');
  }
}

String reconProblemText(BuildContext context, ReconciliationProblem problem) {
  switch (problem) {
    case ReconciliationProblem.itemState:
      return context.t('mob.treasury.problem.itemState');
    case ReconciliationProblem.approvalRequired:
      return context.t('mob.treasury.problem.approvalRequired');
    case ReconciliationProblem.selfApproval:
      return context.t('mob.treasury.problem.selfApproval');
    case ReconciliationProblem.versionConflict:
      return context.t('mob.treasury.problem.versionConflict');
    case ReconciliationProblem.stepUp:
      return context.t('mob.treasury.problem.stepUp');
    case ReconciliationProblem.licenseExpired:
      return context.t('mob.treasury.problem.licenseExpired');
    case ReconciliationProblem.validation:
      return context.t('mob.treasury.problem.validation');
    case ReconciliationProblem.notFound:
      return context.t('mob.treasury.problem.notFound');
    case ReconciliationProblem.denied:
      return context.t('mob.treasury.problem.denied');
    case ReconciliationProblem.sessionEnded:
      return context.t('mob.treasury.problem.sessionEnded');
    case ReconciliationProblem.general:
      return context.t('mob.treasury.problem.general');
  }
}
