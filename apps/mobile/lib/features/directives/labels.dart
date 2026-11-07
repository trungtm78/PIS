import 'package:flutter/widgets.dart';

import '../../core/l10n/app_strings.dart';
import '../read_support/widgets.dart';
import 'directive_models.dart';

/// The name of a status as a reader sees it. Each key is written out so the string check can see it is in use.
String directiveStatusLabel(BuildContext context, DirectiveStatus status) {
  switch (status) {
    case DirectiveStatus.open:
      return context.t('mob.dir.status.open');
    case DirectiveStatus.inProgress:
      return context.t('mob.dir.status.inProgress');
    case DirectiveStatus.done:
      return context.t('mob.dir.status.done');
    case DirectiveStatus.overdue:
      return context.t('mob.dir.status.overdue');
    case DirectiveStatus.cancelled:
      return context.t('mob.dir.status.cancelled');
  }
}

/// Late is danger, close to the day is warning, done is success, being worked on is info; never told by colour alone (the pill has an icon and a text).
MachvonTone directiveStatusTone(DirectiveStatus status) {
  switch (status) {
    case DirectiveStatus.overdue:
      return MachvonTone.danger;
    case DirectiveStatus.done:
      return MachvonTone.success;
    case DirectiveStatus.inProgress:
      return MachvonTone.info;
    case DirectiveStatus.open:
    case DirectiveStatus.cancelled:
      return MachvonTone.neutral;
  }
}

/// How the clock of a directive reads, in days as the server counted them, or null when there is nothing to say (the day is far, or the directive ended).
String? directiveClockLabel(BuildContext context, DirectiveLine line) {
  switch (line.phase) {
    case DirectivePhase.dueSoon:
      return context.t('mob.dir.clock.dueSoon', <String, Object>{'days': line.daysToDue ?? 0});
    case DirectivePhase.dueToday:
      return context.t('mob.dir.clock.dueToday');
    case DirectivePhase.overdue:
      return context.t('mob.dir.clock.overdue', <String, Object>{'days': line.overdueDays ?? 0});
    case DirectivePhase.escalated:
      return context.t('mob.dir.clock.escalated', <String, Object>{'days': line.overdueDays ?? 0});
    case DirectivePhase.dueLater:
    case DirectivePhase.ended:
      return null;
  }
}

/// The clock reads as a warning from the reminder days on, and as danger when the day has passed.
MachvonTone directiveClockTone(DirectivePhase phase) => phase == DirectivePhase.overdue || phase == DirectivePhase.escalated ? MachvonTone.danger : MachvonTone.warning;

String directiveEventLabel(BuildContext context, DirectiveEventKind kind) {
  switch (kind) {
    case DirectiveEventKind.created:
      return context.t('mob.dir.event.created');
    case DirectiveEventKind.assigned:
      return context.t('mob.dir.event.assigned');
    case DirectiveEventKind.progress:
      return context.t('mob.dir.event.progress');
    case DirectiveEventKind.extensionRequested:
      return context.t('mob.dir.event.extensionRequested');
    case DirectiveEventKind.extensionApproved:
      return context.t('mob.dir.event.extensionApproved');
    case DirectiveEventKind.extensionRejected:
      return context.t('mob.dir.event.extensionRejected');
    case DirectiveEventKind.closed:
      return context.t('mob.dir.event.closed');
    case DirectiveEventKind.cancelled:
      return context.t('mob.dir.event.cancelled');
    case DirectiveEventKind.reopened:
      return context.t('mob.dir.event.reopened');
  }
}

String extensionStateLabel(BuildContext context, ExtensionState state) {
  switch (state) {
    case ExtensionState.requested:
      return context.t('mob.dir.extension.requested');
    case ExtensionState.approved:
      return context.t('mob.dir.extension.approved');
    case ExtensionState.rejected:
      return context.t('mob.dir.extension.rejected');
  }
}

String directiveFilterLabel(BuildContext context, DirectiveFilter filter) {
  switch (filter) {
    case DirectiveFilter.mine:
      return context.t('mob.dir.list.filter.mine');
    case DirectiveFilter.overdue:
      return context.t('mob.dir.list.filter.overdue');
    case DirectiveFilter.all:
      return context.t('mob.dir.list.filter.all');
  }
}
