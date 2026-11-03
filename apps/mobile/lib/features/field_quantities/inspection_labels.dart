import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'inspection_commands.dart';
import 'inspection_models.dart';

String inspectionStatusText(BuildContext context, String status) {
  switch (status) {
    case 'SCHEDULED':
      return context.t('mob.chk.status.scheduled');
    case 'RESULT_RECORDED':
      return context.t('mob.chk.status.recorded');
    case 'CANCELLED':
      return context.t('mob.chk.status.cancelled');
    default:
      return context.t('mob.chk.status.requested');
  }
}

String outcomeText(BuildContext context, String outcome) {
  switch (outcome) {
    case 'PASS':
      return context.t('mob.chk.outcome.pass');
    case 'FAIL':
      return context.t('mob.chk.outcome.fail');
    default:
      return context.t('mob.chk.outcome.na');
  }
}

String resultText(BuildContext context, String result) {
  switch (result) {
    case 'PASS':
      return context.t('mob.chk.result.pass');
    case 'FAIL':
      return context.t('mob.chk.result.fail');
    default:
      return context.t('mob.chk.result.conditional');
  }
}

String severityOfNcrText(BuildContext context, String severity) {
  switch (severity) {
    case 'CRITICAL':
      return context.t('mob.chk.severity.critical');
    case 'MAJOR':
      return context.t('mob.chk.severity.major');
    default:
      return context.t('mob.chk.severity.minor');
  }
}

String resultProblemText(BuildContext context, ResultProblem problem) {
  switch (problem) {
    case ResultProblem.unanswered:
      return context.t('mob.chk.problem.unanswered');
    case ResultProblem.required:
      return context.t('mob.chk.problem.required');
    case ResultProblem.tooLong:
      return context.t('mob.chk.problem.tooLong');
    case ResultProblem.contradiction:
      return context.t('mob.chk.problem.contradiction');
    case ResultProblem.noInspection:
      return context.t('mob.chk.problem.noChecklist');
  }
}

String requestProblemText(BuildContext context, RequestProblem problem) {
  switch (problem) {
    case RequestProblem.recordRequired:
    case RequestProblem.documentRequired:
      return context.t('mob.chk.problem.required');
    case RequestProblem.recordTooLong:
      return context.t('mob.chk.problem.tooLong');
    case RequestProblem.documentNotAnIdentifier:
      return context.t('mob.chk.problem.notAnIdentifier');
  }
}

String inspectionRefusalText(BuildContext context, InspectionRefusal refusal) {
  switch (refusal) {
    case InspectionRefusal.openCriticalNcr:
      return context.t('mob.chk.refusal.openCriticalNcr');
    case InspectionRefusal.notPassed:
      return context.t('mob.chk.refusal.notPassed');
    case InspectionRefusal.contractState:
      return context.t('mob.chk.refusal.contractState');
    case InspectionRefusal.acceptanceState:
      return context.t('mob.chk.refusal.acceptanceState');
    case InspectionRefusal.inspectionState:
      return context.t('mob.chk.refusal.inspectionState');
    case InspectionRefusal.checklistIncomplete:
      return context.t('mob.chk.refusal.checklistIncomplete');
    case InspectionRefusal.versionConflict:
      return context.t('mob.chk.refusal.versionConflict');
    case InspectionRefusal.stepUp:
      return context.t('mob.chk.refusal.stepUp');
    case InspectionRefusal.validation:
      return context.t('mob.chk.refusal.validation');
    case InspectionRefusal.notFound:
      return context.t('mob.chk.refusal.notFound');
    case InspectionRefusal.denied:
      return context.t('mob.chk.refusal.denied');
    case InspectionRefusal.sessionEnded:
      return context.t('mob.chk.refusal.sessionEnded');
    case InspectionRefusal.general:
      return context.t('mob.chk.refusal.general');
  }
}
