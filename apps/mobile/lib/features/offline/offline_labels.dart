import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/offline/queue/offline_codes.dart';
import '../../core/offline/queue/queue_results.dart';
import '../../core/offline/queue/queued_command.dart';

/// The name of a command type for a person. A type this application does not know is shown by its type.
String commandTypeLabel(BuildContext context, String commandType) {
  switch (commandType) {
    case 'report.submit':
      return context.t('mob.queue.type.reportSubmit.label');
    case 'report.draft.save':
      return context.t('mob.queue.type.reportDraftSave.label');
    case 'issue.create':
      return context.t('mob.queue.type.issueCreate.label');
    case 'site_diary.append':
      return context.t('mob.queue.type.siteDiaryAppend.label');
    case 'measurement.record':
      return context.t('mob.queue.type.measurementRecord.label');
    case 'inspection.result':
      return context.t('mob.queue.type.inspectionResult.label');
    default:
      return context.t('mob.queue.type.other.label', <String, Object>{'type': commandType});
  }
}

String stateLabel(BuildContext context, CommandState state) {
  switch (state) {
    case CommandState.queued:
      return context.t('mob.queue.state.queued.label');
    case CommandState.sending:
      return context.t('mob.queue.state.sending.label');
    case CommandState.unknown:
      return context.t('mob.queue.state.unknown.label');
    case CommandState.accepted:
      return context.t('mob.queue.state.accepted.label');
    case CommandState.rejected:
      return context.t('mob.queue.state.rejected.label');
    case CommandState.conflict:
      return context.t('mob.queue.state.conflict.label');
    case CommandState.discarded:
      return context.t('mob.queue.state.discarded.label');
  }
}

/// Why a command is not done, in words and with guidance, or null when nothing needs saying. The code is shown beside it.
String? reasonOf(BuildContext context, QueuedCommand command) {
  switch (command.state) {
    case CommandState.unknown:
      return context.t('mob.queue.reason.unknown.body');
    case CommandState.queued:
      return command.errorCode == null ? null : context.t('mob.queue.reason.waiting.body');
    case CommandState.conflict:
      return context.t('mob.queue.reason.conflict.body');
    case CommandState.rejected:
      return _refusal(context, command.errorCode);
    case CommandState.sending:
    case CommandState.accepted:
    case CommandState.discarded:
      return null;
  }
}

String _refusal(BuildContext context, String? code) {
  switch (code) {
    case kPeriodLocked:
      return context.t('mob.queue.reason.periodLocked.body');
    case kLicenseExpired:
      return context.t('mob.queue.reason.licenseExpired.body');
    case kScopeDenied:
      return context.t('mob.queue.reason.scopeDenied.body');
    case kIdempotencyConflict:
      return context.t('mob.queue.reason.idempotency.body');
    case kResultUnverifiable:
      return context.t('mob.queue.reason.unverifiable.body');
    case 'VALIDATION_FAILED':
      return context.t('mob.queue.reason.validation.body');
    default:
      return context.t('mob.queue.reason.other.body');
  }
}

/// What stopped the last send, or null when nothing did.
String? blockerNotice(BuildContext context, FlushBlocker? blocker) {
  switch (blocker) {
    case null:
    case FlushBlocker.noSession:
      return null;
    case FlushBlocker.noDevice:
      return context.t('mob.queue.notice.noDevice.body');
    case FlushBlocker.offline:
      return context.t('mob.queue.notice.offline.body');
    case FlushBlocker.sessionExpired:
      return context.t('mob.queue.notice.sessionExpired.body');
    case FlushBlocker.deviceRejected:
      return context.t('mob.queue.notice.deviceRejected.body');
    case FlushBlocker.busy:
      return context.t('mob.queue.notice.busy.body');
    case FlushBlocker.serverError:
      return context.t('mob.queue.notice.serverError.body');
  }
}

final RegExp _fundingField = RegExp(r'^funding_lines\[([^|\]]*)\|([^|\]]*)\|([^\]]*)\](?:\.(.+))?$');

/// The name of a field of a draft for a person, from its path in the comparison. A path this application has no name for is
/// shown as it is, so nothing is hidden from the person who has to choose.
String fieldLabel(BuildContext context, String path) {
  final RegExpMatch? line = _fundingField.firstMatch(path);
  if (line != null) {
    final String bucket = _bucketLabel(context, line.group(1)!);
    final String level = _levelLabel(context, line.group(2)!);
    final String? field = line.group(4);
    if (field == null) return context.t('mob.conflict.field.fundingItem.label', <String, Object>{'bucket': bucket, 'level': level});
    return context.t('mob.conflict.field.fundingLine.label', <String, Object>{'bucket': bucket, 'level': level, 'field': _plainField(context, field)});
  }
  return _plainField(context, path);
}

String _plainField(BuildContext context, String path) {
  switch (path) {
    case 'construction_vnd':
      return context.t('mob.conflict.field.constructionVnd.label');
    case 'acceptance_vnd':
      return context.t('mob.conflict.field.acceptanceVnd.label');
    case 'treasury_submitted_vnd':
      return context.t('mob.conflict.field.treasurySubmittedVnd.label');
    case 'preparing_dossier_vnd':
      return context.t('mob.conflict.field.preparingDossierVnd.label');
    case 'physical_progress_pct':
      return context.t('mob.conflict.field.physicalProgressPct.label');
    case 'negative_delta_explanation':
      return context.t('mob.conflict.field.negativeDeltaExplanation.label');
    case 'narrative.results':
      return context.t('mob.conflict.field.narrativeResults.label');
    case 'narrative.causes':
      return context.t('mob.conflict.field.narrativeCauses.label');
    case 'narrative.solutions':
      return context.t('mob.conflict.field.narrativeSolutions.label');
    case 'narrative.proposals':
      return context.t('mob.conflict.field.narrativeProposals.label');
    case 'cumulative_vnd':
      return context.t('mob.conflict.field.cumulativeVnd.label');
    case 'ctmtqg_subset_vnd':
      return context.t('mob.conflict.field.ctmtqgSubsetVnd.label');
    case 'next_month_vnd':
      return context.t('mob.conflict.field.nextMonthVnd.label');
    case 'next_month_ctmtqg_subset_vnd':
      return context.t('mob.conflict.field.nextMonthCtmtqgSubsetVnd.label');
    default:
      return path;
  }
}

String _bucketLabel(BuildContext context, String bucket) {
  switch (bucket) {
    case 'CURRENT_YEAR':
      return context.t('mob.conflict.bucket.currentYear.label');
    case 'CARRYOVER':
      return context.t('mob.conflict.bucket.carryover.label');
    case 'OTHER':
      return context.t('mob.conflict.bucket.other.label');
    default:
      return bucket;
  }
}

String _levelLabel(BuildContext context, String level) {
  switch (level) {
    case 'CENTRAL':
      return context.t('mob.conflict.level.central.label');
    case 'LOCAL':
      return context.t('mob.conflict.level.local.label');
    default:
      return level;
  }
}
