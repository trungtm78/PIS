import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'diary_commands.dart';
import 'diary_models.dart';

String contractStatusText(BuildContext context, String status) {
  switch (status) {
    case 'ACTIVE':
      return context.t('mob.dry.contract.status.active');
    case 'CANCELLED':
      return context.t('mob.dry.contract.status.cancelled');
    case 'CLOSED':
      return context.t('mob.dry.contract.status.closed');
    case 'COMPLETED':
      return context.t('mob.dry.contract.status.completed');
    case 'DRAFT':
      return context.t('mob.dry.contract.status.draft');
    case 'IN_REVIEW':
      return context.t('mob.dry.contract.status.inReview');
    case 'SIGNED':
      return context.t('mob.dry.contract.status.signed');
    case 'SUSPENDED':
      return context.t('mob.dry.contract.status.suspended');
    case 'TERMINATED':
      return context.t('mob.dry.contract.status.terminated');
    default:
      return status;
  }
}

String diaryStatusText(BuildContext context, String status) {
  switch (status) {
    case 'CONTRACTOR_SIGNED':
      return context.t('mob.dry.status.contractorSigned');
    case 'SUPERVISED':
      return context.t('mob.dry.status.supervised');
    case 'OWNER_CONFIRMED':
      return context.t('mob.dry.status.ownerConfirmed');
    case 'LOCKED':
      return context.t('mob.dry.status.locked');
    case 'SUPERSEDED':
      return context.t('mob.dry.status.superseded');
    default:
      return context.t('mob.dry.status.draft');
  }
}

String weatherText(BuildContext context, String code) {
  switch (code) {
    case 'SUNNY':
      return context.t('mob.dry.weather.sunny');
    case 'CLOUDY':
      return context.t('mob.dry.weather.cloudy');
    case 'RAIN':
      return context.t('mob.dry.weather.rain');
    case 'HEAVY_RAIN':
      return context.t('mob.dry.weather.heavyRain');
    case 'STORM':
      return context.t('mob.dry.weather.storm');
    case 'HOT':
      return context.t('mob.dry.weather.hot');
    case 'COLD':
      return context.t('mob.dry.weather.cold');
    default:
      return code;
  }
}

String roleText(BuildContext context, String role) {
  switch (role) {
    case 'CONTRACTOR':
      return context.t('mob.dry.role.contractor');
    case 'SUPERVISOR':
      return context.t('mob.dry.role.supervisor');
    default:
      return context.t('mob.dry.role.owner');
  }
}

String methodText(BuildContext context, String method) {
  switch (method) {
    case 'IN_APP_WEBAUTHN':
      return context.t('mob.dry.method.webauthn');
    case 'DIGITAL_CERT':
      return context.t('mob.dry.method.cert');
    default:
      return context.t('mob.dry.method.otp');
  }
}

String diaryProblemText(BuildContext context, DiaryProblem problem) {
  switch (problem) {
    case DiaryProblem.required:
      return context.t('mob.dry.problem.required');
    case DiaryProblem.tooLong:
      return context.t('mob.dry.problem.tooLong');
    case DiaryProblem.invalidNumber:
      return context.t('mob.dry.problem.invalidNumber');
    case DiaryProblem.futureDay:
      return context.t('mob.dry.problem.futureDay');
    case DiaryProblem.invalidDay:
      return context.t('mob.dry.problem.invalidDay');
    case DiaryProblem.tooManyItems:
      return context.t('mob.dry.problem.tooManyItems');
  }
}

String correctionProblemText(BuildContext context, CorrectionProblem problem) =>
    problem == CorrectionProblem.reasonRequired
    ? context.t('mob.dry.problem.required')
    : context.t('mob.dry.problem.tooLong');

String refusalText(BuildContext context, DiaryRefusal refusal) {
  switch (refusal) {
    case DiaryRefusal.diaryState:
      return context.t('mob.dry.refusal.diaryState');
    case DiaryRefusal.correctionOpen:
      return context.t('mob.dry.refusal.correctionOpen');
    case DiaryRefusal.contentChanged:
      return context.t('mob.dry.refusal.contentChanged');
    case DiaryRefusal.dayExists:
      return context.t('mob.dry.refusal.dayExists');
    case DiaryRefusal.syncConflict:
      return context.t('mob.dry.refusal.syncConflict');
    case DiaryRefusal.alreadySigned:
      return context.t('mob.dry.refusal.alreadySigned');
    case DiaryRefusal.methodNotAccepted:
      return context.t('mob.dry.refusal.methodNotAccepted');
    case DiaryRefusal.notYourRole:
      return context.t('mob.dry.refusal.notYourRole');
    case DiaryRefusal.contractState:
      return context.t('mob.dry.refusal.contractState');
    case DiaryRefusal.permitGate:
      return context.t('mob.dry.refusal.permitGate');
    case DiaryRefusal.versionConflict:
      return context.t('mob.dry.refusal.versionConflict');
    case DiaryRefusal.stepUp:
      return context.t('mob.dry.refusal.stepUp');
    case DiaryRefusal.licenseExpired:
      return context.t('mob.dry.refusal.licenseExpired');
    case DiaryRefusal.validation:
      return context.t('mob.dry.refusal.validation');
    case DiaryRefusal.notFound:
      return context.t('mob.dry.refusal.notFound');
    case DiaryRefusal.denied:
      return context.t('mob.dry.refusal.denied');
    case DiaryRefusal.sessionEnded:
      return context.t('mob.dry.refusal.sessionEnded');
    case DiaryRefusal.general:
      return context.t('mob.dry.refusal.general');
  }
}
