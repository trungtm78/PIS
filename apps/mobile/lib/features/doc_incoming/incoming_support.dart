import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import 'incoming_commands.dart';
import 'incoming_models.dart';

export '../read_support/offline.dart' show isOffline;

/// Why a letter cannot be started or resolved now. The reason is always written beside the missing button. Offline wins over
/// everything: handling is judged by the server on the letter as it is now, never from a copy and never from a queue.
enum IncomingGate { open, offline, readOnly, notHandling, noAction }

IncomingGate gateOf({required IncomingLetter letter, required bool offline, required SessionSnapshot session}) {
  if (offline) return IncomingGate.offline;
  if (!letter.isHandling) return IncomingGate.notHandling;
  if (session.isReadOnly) return IncomingGate.readOnly;
  if (!letter.canStart && !letter.canResolve) return IncomingGate.noAction;
  return IncomingGate.open;
}

String gateText(BuildContext context, IncomingGate gate) {
  switch (gate) {
    case IncomingGate.open:
      return '';
    case IncomingGate.offline:
      return context.t('mob.docin.gate.offline');
    case IncomingGate.readOnly:
      return context.t('mob.docin.gate.readOnly');
    case IncomingGate.notHandling:
      return context.t('mob.docin.gate.notHandling');
    case IncomingGate.noAction:
      return context.t('mob.docin.gate.noAction');
  }
}

String statusLabel(BuildContext context, String status) {
  switch (status) {
    case 'RECEIVED':
      return context.t('mob.docin.status.received');
    case 'REGISTERED':
      return context.t('mob.docin.status.registered');
    case 'ASSIGNED':
      return context.t('mob.docin.status.assigned');
    case 'PROCESSING':
      return context.t('mob.docin.status.processing');
    case 'RESOLVED':
      return context.t('mob.docin.status.resolved');
    case 'FILED':
      return context.t('mob.docin.status.filed');
    default:
      return context.t('mob.docin.status.rejected');
  }
}

String urgencyLabel(BuildContext context, String urgency) {
  switch (urgency) {
    case 'KHAN':
      return context.t('mob.docin.urgency.khan');
    case 'THUONG_KHAN':
      return context.t('mob.docin.urgency.thuongKhan');
    case 'HOA_TOC':
      return context.t('mob.docin.urgency.hoaToc');
    default:
      return context.t('mob.docin.urgency.normal');
  }
}

String summaryProblemText(BuildContext context, SummaryProblem problem) {
  switch (problem) {
    case SummaryProblem.required:
      return context.t('mob.docin.summary.required');
    case SummaryProblem.tooShort:
      return context.t('mob.docin.summary.tooShort');
    case SummaryProblem.tooLong:
      return context.t('mob.docin.summary.tooLong');
  }
}

String problemText(BuildContext context, IncomingProblem problem) {
  switch (problem) {
    case IncomingProblem.notAssignee:
      return context.t('mob.docin.problem.notAssignee');
    case IncomingProblem.wrongState:
      return context.t('mob.docin.problem.wrongState');
    case IncomingProblem.responseNotIssued:
      return context.t('mob.docin.problem.responseNotIssued');
    case IncomingProblem.versionConflict:
      return context.t('mob.docin.problem.versionConflict');
    case IncomingProblem.stepUp:
      return context.t('mob.docin.problem.stepUp');
    case IncomingProblem.licenseExpired:
      return context.t('mob.docin.problem.licenseExpired');
    case IncomingProblem.validation:
      return context.t('mob.docin.problem.validation');
    case IncomingProblem.notFound:
      return context.t('mob.docin.problem.notFound');
    case IncomingProblem.denied:
      return context.t('mob.docin.problem.denied');
    case IncomingProblem.sessionEnded:
      return context.t('mob.docin.problem.sessionEnded');
    case IncomingProblem.general:
      return context.t('mob.docin.problem.general');
  }
}

/// Counts the changes made to letters, so that the list under a letter that was just handled reads again.
class LettersChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<LettersChanged, int> lettersChangedProvider = NotifierProvider<LettersChanged, int>(LettersChanged.new);
