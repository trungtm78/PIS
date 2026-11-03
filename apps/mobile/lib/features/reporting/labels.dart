import 'package:flutter/widgets.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/l10n/app_strings.dart';
import '../read_support/money.dart';
import 'model/report_cells.dart';
import 'model/report_review.dart';

/// The name of a cell as the paper form writes it: the source and the budget.
String cellLabel(BuildContext context, CellKey cell) {
  switch (cell.id) {
    case 'CURRENT_YEAR:CENTRAL':
      return context.t('mob.rep.cell.currentYearCentral.label');
    case 'CURRENT_YEAR:LOCAL':
      return context.t('mob.rep.cell.currentYearLocal.label');
    case 'CARRYOVER:CENTRAL':
      return context.t('mob.rep.cell.carryoverCentral.label');
    case 'CARRYOVER:LOCAL':
      return context.t('mob.rep.cell.carryoverLocal.label');
    case 'OTHER:CENTRAL':
      return context.t('mob.rep.cell.otherCentral.label');
    default:
      return context.t('mob.rep.cell.otherLocal.label');
  }
}

/// The budget of a cell alone (the source is the title of the screen).
String levelLabel(BuildContext context, String level) =>
    level == 'CENTRAL' ? context.t('mob.rep.level.central.label') : context.t('mob.rep.level.local.label');

String basisLabel(BuildContext context, String basis) {
  switch (basis) {
    case 'PERIOD':
      return context.t('mob.rep.basis.period.label');
    case 'PROJECT_TO_DATE':
      return context.t('mob.rep.basis.projectToDate.label');
    default:
      return context.t('mob.rep.basis.ytd.label');
  }
}

/// The status of a report on the server.
String reportStatusLabel(BuildContext context, String status) {
  switch (status) {
    case 'DRAFT':
      return context.t('mob.rep.status.draft.label');
    case 'SUBMITTED':
      return context.t('mob.rep.status.submitted.label');
    case 'UNDER_REVIEW':
      return context.t('mob.rep.status.underReview.label');
    case 'ACCEPTED':
      return context.t('mob.rep.status.accepted.label');
    case 'RETURNED':
      return context.t('mob.rep.status.returned.label');
    case 'AMENDMENT_REQUESTED':
      return context.t('mob.rep.status.amendmentRequested.label');
    case 'WITHDRAWN':
      return context.t('mob.rep.status.withdrawn.label');
    case 'SUPERSEDED':
      return context.t('mob.rep.status.superseded.label');
    default:
      return status;
  }
}

String periodStatusLabel(BuildContext context, String? status) {
  switch (status) {
    case 'OPEN':
      return context.t('mob.rep.period.open.label');
    case 'SOFT_CLOSED':
      return context.t('mob.rep.period.softClosed.label');
    case 'LOCKED':
      return context.t('mob.rep.period.locked.label');
    default:
      return '';
  }
}

/// Why a command or a read of the weekly report was refused, in the words of the user (the web says the same in DIS 3 F1).
enum ReportProblem {
  draftExists,
  reportExists,
  periodLocked,
  planNotEffective,
  stageInvalid,
  subsetExceeds,
  immutable,
  versionConflict,
  scopeDenied,
  licenseExpired,
  sessionEnded,
  validation,
  notFound,
  idempotency,
  general,
}

const Map<String, ReportProblem> _problemByCode = <String, ReportProblem>{
  'DRAFT_EXISTS': ReportProblem.draftExists,
  'REPORT_STATE_INVALID': ReportProblem.reportExists,
  'PERIOD_LOCKED': ReportProblem.periodLocked,
  'PLAN_VERSION_NOT_EFFECTIVE': ReportProblem.planNotEffective,
  'PROJECT_STAGE_INVALID': ReportProblem.stageInvalid,
  'SUBSET_EXCEEDS_PARENT': ReportProblem.subsetExceeds,
  'REVISION_IMMUTABLE': ReportProblem.immutable,
  'VERSION_CONFLICT': ReportProblem.versionConflict,
  'DRAFT_VERSION_CONFLICT': ReportProblem.versionConflict,
  'SCOPE_DENIED': ReportProblem.scopeDenied,
  'PERMISSION_DENIED': ReportProblem.scopeDenied,
  'LICENSE_EXPIRED': ReportProblem.licenseExpired,
  'SESSION_EXPIRED': ReportProblem.sessionEnded,
  'VALIDATION_FAILED': ReportProblem.validation,
  'INVALID_REQUEST': ReportProblem.validation,
  'FIELD_NOT_ALLOWED': ReportProblem.validation,
  'NEGATIVE_DELTA_EXPLANATION_REQUIRED': ReportProblem.validation,
  'RESOURCE_NOT_FOUND': ReportProblem.notFound,
  'IDEMPOTENCY_CONFLICT': ReportProblem.idempotency,
};

ReportProblem problemOfCode(String? code) => _problemByCode[code] ?? ReportProblem.general;

/// What a failure of a command or a read means to the user. Only the code of the failure is looked at, never its text.
ReportProblem problemOf(Object error) => error is ApiError ? problemOfCode(error.code) : ReportProblem.general;

String problemMessage(BuildContext context, ReportProblem problem) {
  switch (problem) {
    case ReportProblem.draftExists:
      return context.t('mob.rep.problem.draftExists.body');
    case ReportProblem.reportExists:
      return context.t('mob.rep.problem.reportExists.body');
    case ReportProblem.periodLocked:
      return context.t('mob.rep.problem.periodLocked.body');
    case ReportProblem.planNotEffective:
      return context.t('mob.rep.problem.planNotEffective.body');
    case ReportProblem.stageInvalid:
      return context.t('mob.rep.problem.stageInvalid.body');
    case ReportProblem.subsetExceeds:
      return context.t('mob.rep.problem.subsetExceeds.body');
    case ReportProblem.immutable:
      return context.t('mob.rep.problem.immutable.body');
    case ReportProblem.versionConflict:
      return context.t('mob.rep.problem.versionConflict.body');
    case ReportProblem.scopeDenied:
      return context.t('mob.rep.problem.scopeDenied.body');
    case ReportProblem.licenseExpired:
      return context.t('mob.rep.problem.licenseExpired.body');
    case ReportProblem.sessionEnded:
      return context.t('mob.rep.problem.sessionEnded.body');
    case ReportProblem.validation:
      return context.t('mob.rep.problem.validation.body');
    case ReportProblem.notFound:
      return context.t('mob.rep.problem.notFound.body');
    case ReportProblem.idempotency:
      return context.t('mob.rep.problem.idempotency.body');
    case ReportProblem.general:
      return context.t('mob.rep.problem.general.body');
  }
}

/// A sentence for an amount of whole dong, with the thousands grouped in the language of the interface.
String _dong(BuildContext context, String? value) => formatDong(value ?? '0', AppStrings.of(context).language);

/// The sentence of one finding of the review, with its figures written the way a person reads them. The server's findings and
/// the phone's are the same codes, so they read the same.
String findingMessage(BuildContext context, Finding finding) {
  final CellKey? cell = cellOfFinding(finding);
  final String cellName = cell == null ? '' : cellLabel(context, cell);
  switch (finding.code) {
    case 'CELL_REQUIRED':
      return context.t('mob.rep.finding.cellRequired.body', <String, Object>{'cell': cellName});
    case 'CELL_INVALID':
      return context.t('mob.rep.finding.cellInvalid.body', <String, Object>{'cell': cellName});
    case 'CTMTQG_NOT_ALLOWED':
      return context.t('mob.rep.finding.ctmtqgNotAllowed.body', <String, Object>{'cell': cellName});
    case 'SUBSET_EXCEEDS_PARENT':
      return finding.field.endsWith('next_month_ctmtqg_subset_vnd')
          ? context.t('mob.rep.finding.subsetNext.body', <String, Object>{'subset': _dong(context, finding.values['subset_vnd']), 'parent': _dong(context, finding.values['parent_vnd']), 'cell': cellName})
          : context.t('mob.rep.finding.subset.body', <String, Object>{'subset': _dong(context, finding.values['subset_vnd']), 'parent': _dong(context, finding.values['parent_vnd']), 'cell': cellName});
    case 'NEGATIVE_DELTA_EXPLANATION_REQUIRED':
      return context.t('mob.rep.finding.fall.body');
    case 'EXPLANATION_INVALID':
      return context.t('mob.rep.finding.explanationInvalid.body');
    case 'VOLUME_INVALID':
      return context.t('mob.rep.finding.volumeInvalid.body');
    case 'PERCENT_INVALID':
      return context.t('mob.rep.finding.percentInvalid.body');
    case 'PERCENT_RANGE':
      return context.t('mob.rep.finding.percentRange.body');
    case 'NARRATIVE_TOO_LONG':
      return context.t('mob.rep.finding.narrativeTooLong.body');
    case 'VALIDATION_FAILED':
      return finding.field.startsWith('narrative') ? context.t('mob.rep.finding.causes.body') : context.t('mob.rep.finding.volumes.body');
    case 'REVISION_IMMUTABLE':
      return context.t('mob.rep.finding.immutable.body');
    case 'PERIOD_LOCKED':
      return context.t('mob.rep.finding.periodLocked.body');
    case 'PLAN_VERSION_NOT_EFFECTIVE':
      return context.t('mob.rep.finding.planNotEffective.body');
    case 'NEGATIVE_DELTA':
      return context.t('mob.rep.finding.fallExplained.body', <String, Object>{'delta': _dong(context, finding.values['delta_vnd'])});
    case 'VOLUME_EXCEEDS_ALLOCATION':
      final String? ratio = finding.values['ratio_pct'];
      return ratio == null
          ? context.t('mob.rep.finding.volumeNoCapital.body', <String, Object>{'construction': _dong(context, finding.values['construction_vnd'])})
          : context.t('mob.rep.finding.volumeExceeds.body', <String, Object>{'construction': _dong(context, finding.values['construction_vnd']), 'ratio': ratio, 'allocated': _dong(context, finding.values['allocated_vnd'])});
    case 'TREASURY_GAP':
      final String? gap = finding.values['gap_pct'];
      return gap == null
          ? context.t('mob.rep.finding.treasuryNone.body', <String, Object>{'reported': _dong(context, finding.values['reported_vnd'])})
          : context.t('mob.rep.finding.treasuryGap.body', <String, Object>{'reported': _dong(context, finding.values['reported_vnd']), 'pct': gap, 'treasury': _dong(context, finding.values['treasury_vnd'])});
    case 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT':
      return context.t('mob.rep.finding.nextMonth.body', <String, Object>{'remaining': _dong(context, finding.values['remaining_vnd'])});
    default:
      return context.t('mob.rep.finding.other.body', <String, Object>{'code': finding.code});
  }
}

/// An amount of whole dong in millions of dong with its sign (`+50 triệu đồng`, `-30 triệu đồng`), exactly.
String signedMillionsLabel(BuildContext context, String? vnd) {
  if (vnd == null) return context.t('mob.read.money.none');
  return context.t('mob.read.money.millions', <String, Object>{'value': formatSignedMillions(vnd, AppStrings.of(context).language)});
}

/// The short text beside the box a finding is about, or null for a finding that is not about one box.
String? fieldError(BuildContext context, Finding? finding) {
  switch (finding?.code) {
    case 'CELL_REQUIRED':
      return context.t('mob.rep.field.required.body');
    case 'CELL_INVALID':
    case 'VOLUME_INVALID':
      return context.t('mob.rep.field.invalid.body');
    case 'SUBSET_EXCEEDS_PARENT':
      return context.t('mob.rep.field.exceeds.body');
    case 'CTMTQG_NOT_ALLOWED':
      return context.t('mob.rep.field.notAllowed.body');
    case 'PERCENT_INVALID':
      return context.t('mob.rep.field.percentInvalid.body');
    case 'PERCENT_RANGE':
      return context.t('mob.rep.field.percentRange.body');
    case 'EXPLANATION_INVALID':
      return context.t('mob.rep.field.explanationInvalid.body');
    case 'NARRATIVE_TOO_LONG':
      return context.t('mob.rep.field.tooLong.body');
    default:
      return null;
  }
}
