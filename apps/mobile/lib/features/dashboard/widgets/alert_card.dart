import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../alerts.dart';

/// The word of a level (`Urgent`, `Needs action`, `Watch`).
String severityLabel(BuildContext context, AlertSeverity severity) {
  switch (severity) {
    case AlertSeverity.urgent:
      return context.t('mob.alert.severity.urgent.label');
    case AlertSeverity.action:
      return context.t('mob.alert.severity.action.label');
    case AlertSeverity.watch:
      return context.t('mob.alert.severity.watch.label');
  }
}

({Color ink, Color fill, IconData icon}) _look(AlertSeverity severity) {
  switch (severity) {
    case AlertSeverity.urgent:
      return (ink: MachvonColors.danger, fill: MachvonColors.dangerSoft, icon: Icons.error);
    case AlertSeverity.action:
      return (ink: MachvonColors.warning, fill: MachvonColors.warningSoft, icon: Icons.warning_amber_rounded);
    case AlertSeverity.watch:
      return (ink: MachvonColors.info, fill: MachvonColors.infoSoft, icon: Icons.visibility_outlined);
  }
}

/// A level as an icon and a word on a soft ground: the meaning never rests on the colour alone. With [count] it is a tally
/// (`Urgent 2`).
class SeverityChip extends StatelessWidget {
  const SeverityChip({required this.severity, this.count, super.key});

  final AlertSeverity severity;
  final int? count;

  @override
  Widget build(BuildContext context) {
    final ({Color ink, Color fill, IconData icon}) look = _look(severity);
    final String label = severityLabel(context, severity);
    final String text = count == null ? label : context.t('mob.alert.list.tally.chip', <String, Object>{'label': label, 'count': count!});
    return Semantics(
      container: true,
      label: text,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: look.fill,
          border: Border.all(color: look.ink),
          borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(look.icon, size: 16, color: look.ink),
              const SizedBox(width: MachvonSpace.space4),
              Flexible(child: Text(text, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: look.ink, fontWeight: FontWeight.w700))),
            ],
          ),
        ),
      ),
    );
  }
}

/// The module source of an alert in words.
String alertSourceLabel(BuildContext context, String source) {
  switch (source) {
    case 'APPROVAL':
      return context.t('mob.alert.source.approval.label');
    case 'EXPLANATION':
    case 'EXPLANATION_REVIEW':
      return context.t('mob.alert.source.explanation.label');
    case 'REPORT':
    case 'REPORT_RETURNED':
    case 'REPORT_DRAFT_OVERDUE':
      return context.t('mob.alert.source.report.label');
    case 'MNE_OBLIGATION':
      return context.t('mob.alert.source.mne.label');
    case 'EARLY_WARNING':
      return context.t('mob.alert.source.earlyWarning.label');
    case 'ADVANCE':
      return context.t('mob.alert.source.advance.label');
    case 'PERMIT':
      return context.t('mob.alert.source.permit.label');
    case 'AUDIT_RECOMMENDATION':
      return context.t('mob.alert.source.audit.label');
    case 'ISSUE':
      return context.t('mob.alert.source.issue.label');
    case 'SITE_DIARY':
      return context.t('mob.alert.source.diary.label');
    case 'GUARANTEE':
      return context.t('mob.alert.source.guarantee.label');
    case 'CLOCK':
      return context.t('mob.alert.source.clock.label');
    case 'MONEY_CONTROL':
      return context.t('mob.alert.source.moneyControl.label');
    case 'DIRECTIVE':
      return context.t('mob.alert.source.directive.label');
    case 'PROCUREMENT_WORKFLOW':
      return context.t('mob.alert.source.procurementWorkflow.label');
    case 'TREASURY_RECON':
      return context.t('mob.alert.source.treasuryRecon.label');
    case 'CROSS_TOTAL':
      return context.t('mob.alert.source.crossTotal.label');
    case 'SOD_EXCEPTION':
      return context.t('mob.alert.source.sodException.label');
    case 'PAYMENT_INTEGRITY':
      return context.t('mob.alert.source.paymentIntegrity.label');
    case 'DISBURSEMENT_EXCEPTION':
      return context.t('mob.alert.source.disbursementException.label');
    case 'PROJECT_GOVERNANCE':
      return context.t('mob.alert.source.projectGovernance.label');
    case '':
      return context.t('mob.alert.source.other.label');
    default:
      // A source this phone does not know yet is shown with its code, never hidden.
      return context.t('mob.alert.source.unknown.label', <String, Object>{'code': source});
  }
}

/// The words of a snooze reason code; a code this phone has no words for is shown as the server sent it.
String snoozeReasonLabel(BuildContext context, String code) {
  switch (code) {
    case 'WAITING_INFORMATION':
      return context.t('mob.alert.snooze.reasonWaitingInformation.label');
    case 'WAITING_THIRD_PARTY':
      return context.t('mob.alert.snooze.reasonWaitingThirdParty.label');
    case 'SCHEDULED_ACTION':
      return context.t('mob.alert.snooze.reasonScheduledAction.label');
    case 'BLOCKED_BY_OTHER_WORK':
      return context.t('mob.alert.snooze.reasonBlockedByOtherWork.label');
    case 'ON_LEAVE':
      return context.t('mob.alert.snooze.reasonOnLeave.label');
    case 'OTHER':
      return context.t('mob.alert.snooze.reasonOther.label');
    default:
      return code;
  }
}

String _lowerFirst(String value) => value.isEmpty ? value : value[0].toLowerCase() + value.substring(1);

String _lifecycleLabel(BuildContext context, AlertLifecycle lifecycle) {
  switch (lifecycle) {
    case AlertLifecycle.fresh:
      return context.t('mob.alert.lifecycle.new.label');
    case AlertLifecycle.claimed:
      return context.t('mob.alert.lifecycle.claimed.label');
    case AlertLifecycle.inProgress:
      return context.t('mob.alert.lifecycle.inProgress.label');
    case AlertLifecycle.resolved:
      return context.t('mob.alert.lifecycle.resolved.label');
  }
}

/// The countdown in words: the time left and the absolute day (`2 days left · 09/11`), or how late (`Overdue 3 days`). No seconds.
String dueLine(BuildContext context, AlertDue due) {
  final Map<String, Object> values = <String, Object>{'amount': due.amount, 'day': due.day ?? '', 'time': due.time ?? ''};
  switch (due.kind) {
    case AlertDueKind.none:
      return context.t('mob.alert.due.none.line');
    case AlertDueKind.remainingDays:
      return context.t('mob.alert.due.remainingDays.line', values);
    case AlertDueKind.remainingHours:
      return due.amount < 1 ? context.t('mob.alert.due.lessThanHour.line', values) : context.t('mob.alert.due.remainingHours.line', values);
    case AlertDueKind.today:
      return context.t('mob.alert.due.today.line', values);
    case AlertDueKind.overdueDays:
      return context.t('mob.alert.due.overdueDays.line', values);
    case AlertDueKind.overdueHours:
      return context.t('mob.alert.due.overdueHours.line', values);
    case AlertDueKind.overdue:
      return context.t('mob.alert.due.overdue.line');
  }
}

/// One alert: its level (icon and word), title, source, countdown, who holds it, what follows if it is not done, and one primary
/// action. The other acts (take, give, remind later) are in a menu with a button of its own: nothing here is reached by a gesture alone.
/// A card in the read-only state (a copy kept on the device) offers no act.
class AlertCard extends StatelessWidget {
  const AlertCard({
    required this.item,
    required this.now,
    this.onOpen,
    this.onClaim,
    this.onAssign,
    this.onSnooze,
    this.busy = false,
    super.key,
  });

  final AlertItem item;
  final DateTime now;

  /// Opens the record the alert is about; null when the phone has no screen for it or the card is read-only.
  final VoidCallback? onOpen;
  final VoidCallback? onClaim;
  final VoidCallback? onAssign;
  final VoidCallback? onSnooze;

  /// An act on this alert is being sent: the buttons are locked, so it cannot be sent twice.
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ({Color ink, Color fill, IconData icon}) look = _look(item.severity);
    final AlertDue due = describeDue(item, now);
    final bool canClaim = onClaim != null && item.canClaim;
    final String claimLabel = item.needsReclaim ? context.t('mob.alert.action.reclaim.label') : context.t('mob.alert.action.claim.label');
    final bool canSnooze = onSnooze != null && item.canSnooze;
    final bool hasMenu = canClaim || onAssign != null || canSnooze;
    final String owner = _ownerLine(context);
    final String? escalation = _escalationLine(context);
    final String? snooze = _snoozeLine(context);
    final String? reminders = _remindersLine(context);
    final String title = item.title.isEmpty ? alertSourceLabel(context, item.source) : item.title;
    final Widget? primary = onOpen != null
        ? FilledButton(
            onPressed: busy ? null : onOpen,
            child: Text(context.t('mob.alert.action.open.label')),
          )
        : (canClaim ? FilledButton(onPressed: busy ? null : onClaim, child: Text(claimLabel)) : null);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space4),
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.card)),
        side: BorderSide(color: look.ink.withValues(alpha: 0.5)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space12, MachvonSpace.space8, MachvonSpace.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Wrap(
                    spacing: MachvonSpace.space8,
                    runSpacing: MachvonSpace.space4,
                    children: <Widget>[
                      SeverityChip(severity: item.severity),
                      if (item.lifecycle != AlertLifecycle.fresh) _Pill(label: _lifecycleLabel(context, item.lifecycle)),
                      if (item.needsReclaim) _Pill(label: context.t('mob.alert.card.reclaim.chip'), icon: Icons.replay, ink: MachvonColors.warning, fill: MachvonColors.warningSoft),
                    ],
                  ),
                ),
                if (hasMenu)
                  PopupMenuButton<String>(
                    tooltip: context.t('mob.alert.action.menu.label'),
                    enabled: !busy,
                    icon: const Icon(Icons.more_vert),
                    onSelected: (String action) {
                      if (action == 'claim') onClaim?.call();
                      if (action == 'assign') onAssign?.call();
                      if (action == 'snooze') onSnooze?.call();
                    },
                    itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
                      if (canClaim) PopupMenuItem<String>(value: 'claim', child: Text(claimLabel)),
                      if (onAssign != null) PopupMenuItem<String>(value: 'assign', child: Text(context.t('mob.alert.action.assign.label'))),
                      if (canSnooze) PopupMenuItem<String>(value: 'snooze', child: Text(context.t('mob.alert.action.snooze.label'))),
                    ],
                  )
                else
                  const SizedBox(height: MachvonSpace.space8),
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(right: MachvonSpace.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)),
                  Text(
                    <String>[context.t('mob.alert.card.source.line', <String, Object>{'source': alertSourceLabel(context, item.source)}), if (item.subtitle != null) item.subtitle!].join(' · '),
                    style: theme.textTheme.bodySmall,
                  ),
                  const SizedBox(height: MachvonSpace.space4),
                  // Without a published working calendar the due time is unknown, never "no due day": the clock line says so.
                  if (!(item.clocks?.basis == ClockBasis.calendarUnavailable && due.kind == AlertDueKind.none))
                  MergeSemantics(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Icon(due.isOverdue ? Icons.schedule : Icons.event_outlined, size: 16, color: due.isOverdue ? MachvonColors.danger : MachvonColors.neutral),
                        const SizedBox(width: MachvonSpace.space4),
                        Expanded(
                          child: Text(
                            dueLine(context, due),
                            style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, color: due.isOverdue ? MachvonColors.danger : null),
                          ),
                        ),
                      ],
                    ),
                  ),
                  ..._clockLines(context),
                  Text(owner, style: theme.textTheme.bodySmall),
                  if (snooze != null) Text(snooze, style: theme.textTheme.bodySmall),
                  if (item.pausedUntil != null) Text(context.t('mob.alert.card.paused.line', <String, Object>{'at': formatMoment(item.pausedUntil!)}), style: theme.textTheme.bodySmall),
                  if (reminders != null) Text(reminders, style: theme.textTheme.bodySmall),
                  if (escalation != null) Text(escalation, style: theme.textTheme.bodySmall),
                  if (item.expectedAction != null) Text(context.t('mob.alert.card.expected.line', <String, Object>{'text': item.expectedAction!}), style: theme.textTheme.bodySmall),
                  if (item.consequence != null) Text(context.t('mob.alert.card.consequence.line', <String, Object>{'text': item.consequence!}), style: theme.textTheme.bodySmall),
                  if (primary != null) ...<Widget>[
                    const SizedBox(height: MachvonSpace.space8),
                    Align(alignment: Alignment.centerLeft, child: ConstrainedBox(constraints: const BoxConstraints(minHeight: 48), child: primary)),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _ownerLine(BuildContext context) {
    final AlertPerson? assignee = item.assignee;
    final AlertPerson? claimed = item.claimedBy;
    if (assignee != null) {
      return assignee.dueOn == null
          ? context.t('mob.alert.owner.assignedNoDay.line', <String, Object>{'name': assignee.name})
          : context.t('mob.alert.owner.assigned.line', <String, Object>{'name': assignee.name, 'date': formatDay(assignee.dueOn!)});
    }
    if (claimed != null) {
      return claimed.at == null
          ? context.t('mob.alert.owner.claimedNoTime.line', <String, Object>{'name': claimed.name})
          : context.t('mob.alert.owner.claimed.line', <String, Object>{'name': claimed.name, 'at': formatMoment(claimed.at!)});
    }
    return context.t('mob.alert.owner.none.line');
  }

  /// "Snoozed 1/2 · Waiting for more information · until 03/11/2026 17:00": the snooze the alert is under, with its place in the run.
  String? _snoozeLine(BuildContext context) {
    final AlertSnooze? snooze = item.snooze;
    if (snooze == null) return null;
    final String? code = snooze.reasonCode;
    final Map<String, Object> values = <String, Object>{
      'n': snooze.ordinal,
      'of': snooze.of,
      'reason': code == null ? '' : snoozeReasonLabel(context, code),
      'at': snooze.until == null ? '' : formatMoment(snooze.until!),
    };
    final String line = snooze.until == null ? context.t('mob.alert.card.snooze.line', values) : context.t('mob.alert.card.snoozeUntil.line', values);
    return snooze.isFinal ? '$line · ${context.t('mob.alert.card.snoozeFinal.text')}' : line;
  }

  String? _remindersLine(BuildContext context) {
    final AlertReminders? reminders = item.reminders;
    if (reminders == null || (reminders.sent == 0 && !reminders.exhausted)) return null;
    final Map<String, Object> values = <String, Object>{'sent': reminders.sent, 'at': reminders.nextAt == null ? '' : formatMoment(reminders.nextAt!)};
    if (reminders.exhausted) return context.t('mob.alert.card.remindersExhausted.line', values);
    return reminders.nextAt == null ? context.t('mob.alert.card.remindersSent.line', values) : context.t('mob.alert.card.reminders.line', values);
  }

  /// The two clocks, one line each, with an icon and a word for the state; or the sentence that says why there is no due time.
  List<Widget> _clockLines(BuildContext context) {
    final AlertClocks? clocks = item.clocks;
    if (clocks == null) return const <Widget>[];
    final AlertClock? claim = clocks.claim;
    final AlertClock? resolve = clocks.resolve;
    final List<Widget> lines = <Widget>[
      if (claim != null) _clockLine(context, context.t('mob.alert.clock.claim.label'), claim),
      if (resolve != null) _clockLine(context, context.t('mob.alert.clock.resolve.label'), resolve),
    ];
    if (lines.isNotEmpty) return lines;
    switch (clocks.basis) {
      case ClockBasis.calendarUnavailable:
        return <Widget>[_ClockLine(icon: Icons.event_busy_outlined, color: MachvonColors.warning, text: context.t('mob.alert.clock.calendar.line'))];
      case ClockBasis.noStart:
        return <Widget>[_ClockLine(icon: Icons.hourglass_empty, color: MachvonColors.neutral, text: context.t('mob.alert.clock.noStart.line'))];
      case ClockBasis.workingTime:
        return const <Widget>[];
    }
  }

  Widget _clockLine(BuildContext context, String label, AlertClock clock) {
    final AlertDue? due = clock.dueAt == null ? null : describeInstant(clock.dueAt!, now);
    final String at = clock.dueAt == null ? '' : formatMoment(clock.dueAt!);
    final String metAt = clock.metAt == null ? '' : formatMoment(clock.metAt!);
    final IconData icon;
    final Color color;
    final String state;
    switch (clock.state) {
      case ClockState.running:
        final bool late = due != null && due.isOverdue;
        icon = late ? Icons.error_outline : Icons.timer_outlined;
        color = late ? MachvonColors.danger : MachvonColors.neutral;
        state = due == null || due.kind == AlertDueKind.none ? context.t('mob.alert.clock.running.text') : _lowerFirst(dueLine(context, due));
      case ClockState.paused:
        icon = Icons.pause_circle_outline;
        color = MachvonColors.neutral;
        state = clock.dueAt == null ? context.t('mob.alert.clock.pausedNoDue.text') : context.t('mob.alert.clock.paused.text', <String, Object>{'at': at});
      case ClockState.met:
        icon = Icons.check_circle_outline;
        color = MachvonColors.success;
        state = clock.metAt == null ? context.t('mob.alert.clock.metNoTime.text') : context.t('mob.alert.clock.met.text', <String, Object>{'at': metAt});
      case ClockState.metLate:
        icon = Icons.watch_later_outlined;
        color = MachvonColors.warning;
        state = clock.metAt == null ? context.t('mob.alert.clock.metLateNoTime.text') : context.t('mob.alert.clock.metLate.text', <String, Object>{'at': metAt});
      case ClockState.breached:
        icon = Icons.error_outline;
        color = MachvonColors.danger;
        state = due != null && due.isOverdue ? _lowerFirst(dueLine(context, due)) : context.t('mob.alert.clock.breached.text');
    }
    return _ClockLine(icon: icon, color: color, text: context.t('mob.alert.clock.state.line', <String, Object>{'label': label, 'state': state}));
  }

  String? _escalationLine(BuildContext context) {
    final AlertEscalation? escalation = item.escalation;
    if (escalation == null) return null;
    final Map<String, Object> values = <String, Object>{'level': escalation.level, 'of': escalation.of, 'at': escalation.nextAt == null ? '' : formatMoment(escalation.nextAt!)};
    return escalation.nextAt == null ? context.t('mob.alert.escalation.level.line', values) : context.t('mob.alert.escalation.next.line', values);
  }
}

/// A state as a word on a soft ground; with an [icon] it is an icon and a word, so the meaning never rests on the colour alone.
class _Pill extends StatelessWidget {
  const _Pill({required this.label, this.icon, this.ink = MachvonColors.neutral, this.fill = MachvonColors.neutralSoft});

  final String label;
  final IconData? icon;
  final Color ink;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(color: fill, borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill))),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (icon != null) ...<Widget>[ExcludeSemantics(child: Icon(icon, size: 16, color: ink)), const SizedBox(width: MachvonSpace.space4)],
            Flexible(child: Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: ink, fontWeight: icon == null ? null : FontWeight.w700))),
          ],
        ),
      ),
    );
  }
}

/// One line of a clock: an icon and the words, read as one sentence.
class _ClockLine extends StatelessWidget {
  const _ClockLine({required this.icon, required this.color, required this.text});

  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.only(top: MachvonSpace.space4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(icon, size: 16, color: color),
            const SizedBox(width: MachvonSpace.space4),
            Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
          ],
        ),
      ),
    );
  }
}
