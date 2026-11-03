import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import 'notification_commands.dart';
import 'notification_models.dart';
import 'preference_models.dart';

/// What a notification is called: the translation of the title key of its event type when the catalogue has it, a neutral title
/// when it does not, and the unavailable title when the member lost access to the record. The key of the server is never
/// shown as text.
String titleOf(BuildContext context, NotificationItem item) {
  if (item.isUnavailable) return context.t('mob.ntf.item.unavailable');
  final AppStrings strings = AppStrings.of(context);
  return strings.catalogue.lookup(strings.language, item.title) ?? context.t('mob.ntf.item.fallback');
}

/// The name of an event type for the filter: its title when the catalogue has one, else the code of the type.
String eventTypeLabel(BuildContext context, String type) {
  final AppStrings strings = AppStrings.of(context);
  final String key = 'notification.event.$type.title';
  return strings.catalogue.lookup(strings.language, key) ?? type;
}

String priorityLabel(BuildContext context, String priority) {
  switch (priority) {
    case 'CRITICAL':
      return context.t('mob.ntf.inbox.priority.critical');
    case 'HIGH':
      return context.t('mob.ntf.inbox.priority.high');
    case 'LOW':
      return context.t('mob.ntf.inbox.priority.low');
    default:
      return context.t('mob.ntf.inbox.priority.normal');
  }
}

/// Where a notification stands: acknowledged, waiting for an acknowledgement, unread or read.
String stateLabel(BuildContext context, NotificationItem item) {
  if (item.acknowledgedAt != null) return context.t('mob.ntf.item.acknowledged');
  if (item.needsAction) return context.t('mob.ntf.item.needsAction');
  return item.isUnread ? context.t('mob.ntf.item.unread') : context.t('mob.ntf.item.read');
}

String channelName(BuildContext context, String channel) {
  switch (channel) {
    case 'IN_APP':
      return context.t('mob.ntf.pref.channel.inApp');
    case 'PUSH':
      return context.t('mob.ntf.pref.channel.push');
    case 'EMAIL':
      return context.t('mob.ntf.pref.channel.email');
    case 'ZALO':
      return context.t('mob.ntf.pref.channel.zalo');
    case 'WHATSAPP':
      return context.t('mob.ntf.pref.channel.whatsapp');
    default:
      return context.t('mob.ntf.pref.channel.sms');
  }
}

String digestName(BuildContext context, String mode) {
  switch (mode) {
    case 'HOURLY':
      return context.t('mob.ntf.pref.digest.hourly');
    case 'DAILY':
      return context.t('mob.ntf.pref.digest.daily');
    default:
      return context.t('mob.ntf.pref.digest.immediate');
  }
}

String categoryName(BuildContext context, String category) => category == allCategories ? context.t('mob.ntf.pref.category.all') : category;

String preferenceProblemText(BuildContext context, PreferenceProblem problem) {
  switch (problem) {
    case PreferenceProblem.locked:
      return context.t('mob.ntf.pref.problem.locked');
    case PreferenceProblem.stale:
      return context.t('mob.ntf.pref.problem.stale');
    case PreferenceProblem.invalid:
      return context.t('mob.ntf.pref.problem.invalid');
    case PreferenceProblem.denied:
      return context.t('mob.ntf.pref.problem.denied');
    case PreferenceProblem.session:
      return context.t('mob.ntf.pref.problem.session');
    case PreferenceProblem.general:
      return context.t('mob.ntf.pref.problem.general');
  }
}

String quietProblemText(BuildContext context, QuietProblem problem) =>
    problem == QuietProblem.empty ? context.t('mob.ntf.pref.quiet.emptyError') : context.t('mob.ntf.pref.quiet.clockError');

String acknowledgeErrorText(BuildContext context, CommandResultView result) {
  if (result.lost) return context.t('mob.ntf.detail.ack.lost');
  switch (result.code) {
    case 'ACK_NOT_REQUIRED':
      return context.t('mob.ntf.detail.ack.notRequired');
    case 'NOTIFICATION_EXPIRED':
      return context.t('mob.ntf.detail.ack.expired');
    default:
      return context.t('mob.ntf.detail.ack.general');
  }
}
