import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'pwf_models.dart';
import 'pwf_step_logic.dart';

/// The words of the step table that depend on the language: the name of a colour, the sentence of where it comes from, a time limit with its unit, what
/// a step waits for and what a refusal of the server means. Every sentence is in `pwf_step_strings.dart`; a number in them is the server's.

/// The name of the official colour for a screen reader and for the sentence of its explanation: "Đỏ", "Vàng", "Xanh"; a deadline with no colour says why in words.
String pwfBandName(BuildContext context, PwfBandKind kind) => switch (kind) {
      PwfBandKind.red => context.t('mob.pwfs.band.red'),
      PwfBandKind.yellow => context.t('mob.pwfs.band.yellow'),
      PwfBandKind.green => context.t('mob.pwfs.band.green'),
      PwfBandKind.none => context.t('mob.pwfs.band.none'),
      PwfBandKind.unknown => context.t('mob.pwfs.band.unknown'),
    };

/// "Màu Đỏ": what a screen reader hears where the colour is the thing drawn (the dot), so that the colour is never the only signal.
String pwfBandSpoken(BuildContext context, PwfBandKind kind) => context.t('mob.pwfs.band.spoken', <String, Object>{'band': pwfBandName(context, kind)});

/// The same word for the colour the whole file carries (`overall_deadline.band` is the word of the server).
PwfBandKind pwfBandKindOf(String band) => PwfBandKind.parse(band) ?? PwfBandKind.unknown;

/// The sentence of where the colour comes from: the step of the template, an exception of the policy, the policy, the default of the system. An answer
/// that does not say (a server older than the tiers) gets the sentence that the colour is the official one, never a guess of a tier.
String pwfTierSentence(BuildContext context, PwfBandTier? tier) => switch (tier) {
      PwfBandTier.step => context.t('mob.pwfs.tier.step'),
      PwfBandTier.policyOverride => context.t('mob.pwfs.tier.override'),
      PwfBandTier.policy => context.t('mob.pwfs.tier.policy'),
      PwfBandTier.system => context.t('mob.pwfs.tier.system'),
      null => context.t('mob.pwfs.tier.unknown'),
    };

/// "Đỏ khi còn 0 ngày làm việc hoặc ít hơn, …": the thresholds the colour was counted with, in the unit the band counts in (`unit` of the band: `WORKING` or `CALENDAR`).
String pwfThresholdsSentence(BuildContext context, PwfThresholds thresholds, {required bool working}) {
  final String unit = working ? context.t('mob.pwfs.unit.working') : context.t('mob.pwfs.unit.calendar');
  final Map<String, Object> values = <String, Object>{'red': thresholds.red, 'yellow': thresholds.yellow, 'unit': unit};
  if (thresholds.green == null) return context.t('mob.pwfs.tier.thresholdsOpen', values);
  return context.t('mob.pwfs.tier.thresholds', <String, Object>{...values, 'green': thresholds.green!});
}

String pwfDurationUnitWord(BuildContext context, PwfDurationUnit unit) => switch (unit) {
      PwfDurationUnit.workingDay => context.t('mob.pwfs.unit.working'),
      PwfDurationUnit.calendarDay => context.t('mob.pwfs.unit.calendar'),
      PwfDurationUnit.month => context.t('mob.pwfs.unit.month'),
    };

/// A time limit with its unit: "20 ngày làm việc", "1 tháng"; moved to a working day when the template says so.
String pwfDurationWords(BuildContext context, PwfDuration duration) {
  final Map<String, Object> value = <String, Object>{'value': duration.value};
  final String words = switch (duration.unit) {
    PwfDurationUnit.workingDay => context.t('mob.pwfs.duration.working', value),
    PwfDurationUnit.calendarDay => context.t('mob.pwfs.duration.calendar', value),
    PwfDurationUnit.month => context.t('mob.pwfs.duration.month', value),
  };
  return duration.rollToWorkingDay ? context.t('mob.pwfs.duration.roll', <String, Object>{'words': words}) : words;
}

/// How much of the extension is used and what the limit is: "Đã gia hạn 1/2 lần · đã thêm 2/5 ngày làm việc". A limit the template does not set is not said.
String pwfExtensionUsed(BuildContext context, PwfExtension extension) {
  final String unit = pwfDurationUnitWord(context, extension.unit);
  return <String>[
    extension.maxTimes == null
        ? context.t('mob.pwfs.ext.times', <String, Object>{'used': extension.timesUsed})
        : context.t('mob.pwfs.ext.timesMax', <String, Object>{'used': extension.timesUsed, 'max': extension.maxTimes!}),
    extension.maxValue == null
        ? context.t('mob.pwfs.ext.value', <String, Object>{'used': extension.valueUsed, 'unit': unit})
        : context.t('mob.pwfs.ext.valueMax', <String, Object>{'used': extension.valueUsed, 'max': extension.maxValue!, 'unit': unit}),
  ].join(' · ');
}

/// What a step waits for, in one line: "chờ người duyệt hoàn thành", "còn 2 mục hồ sơ chưa nộp", "bước "Thẩm định" chưa xong".
String pwfWaitingWords(BuildContext context, PwfWaitingFor wait) => switch (wait.kind) {
      PwfWaitKind.approval => context.t('mob.pwfs.wait.approval'),
      PwfWaitKind.evidence => context.t('mob.pwfs.wait.evidence', <String, Object>{'count': wait.count}),
      PwfWaitKind.step => context.t('mob.pwfs.wait.step', <String, Object>{'name': wait.name ?? ''}),
    };

/// What a refusal of the server means to the person, by its stable code (the PWF codes of the claim and of the extension request, then the ones every
/// command shares). [extensions] are the members of the problem body (`limit`, `reason`); [unit] is the unit of the extension of the step.
String pwfStepRefusalText(BuildContext context, String code, {Map<String, Object?> extensions = const <String, Object?>{}, String? unit, String? detail}) {
  switch (code) {
    case 'PWF_CLAIM_NOT_ELIGIBLE':
      final Object? reason = extensions['reason'] ?? detail;
      return switch (reason) {
        'NOT_MEMBER' => context.t('mob.pwfs.refusal.notMember'),
        'ROLE_NOT_HELD' => context.t('mob.pwfs.refusal.roleNotHeld'),
        _ => context.t('mob.pwfs.refusal.notEligible'),
      };
    case 'PWF_TASK_ALREADY_CLAIMED':
      return context.t('mob.pwfs.refusal.alreadyClaimed');
    case 'PWF_TASK_STATE_INVALID':
      return context.t('mob.pwfs.refusal.stateInvalid');
    case 'RESOURCE_NOT_FOUND':
      return context.t('mob.pwfs.refusal.notFound');
    case 'SCOPE_DENIED':
      return context.t('mob.pwfs.refusal.scope');
    case 'PWF_EXTENSION_NOT_ALLOWED':
      return context.t('mob.pwfs.refusal.extNotAllowed');
    case 'PWF_EXTENSION_LIMIT_EXCEEDED':
      return switch (extensions['limit']) {
        'TIMES' => context.t('mob.pwfs.refusal.extTimes'),
        'VALUE' => context.t('mob.pwfs.refusal.extValue', <String, Object>{'unit': unit ?? context.t('mob.pwfs.unit.working')}),
        _ => context.t('mob.pwfs.refusal.extLimit'),
      };
    case 'PWF_EXTENSION_TASK_CLOSED':
      return context.t('mob.pwfs.refusal.extClosed');
    case 'PWF_EXTENSION_REQUIRED':
      return context.t('mob.pwfs.refusal.extRequired');
    case 'PWF_SCHEDULE_VERSION_CONFLICT' || 'VERSION_CONFLICT':
      return context.t('mob.pwfs.refusal.scheduleConflict');
    default:
      return context.t('mob.pwfs.refusal.other');
  }
}

/// Whether a refusal means the screen is out of date and must read again (somebody else acted, the schedule moved).
bool pwfRefusalNeedsReload(String code) => code == 'PWF_TASK_ALREADY_CLAIMED' || code == 'PWF_SCHEDULE_VERSION_CONFLICT' || code == 'VERSION_CONFLICT' || code == 'PWF_TASK_STATE_INVALID';
