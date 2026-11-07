import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../read_support/moment.dart';
import '../alerts.dart';

/// The word of a level (`Khẩn`, `Cần xử lý`, `Theo dõi`).
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
/// (`Khẩn 2`).
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
    default:
      return context.t('mob.alert.source.other.label');
  }
}

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

/// The countdown in words: the time left and the absolute day (`Còn 2 ngày · 09/11`), or how late (`Quá hạn 3 ngày`). No seconds.
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
    final bool canClaim = onClaim != null && item.unclaimed;
    final bool canSnooze = onSnooze != null && item.canSnooze;
    final bool hasMenu = canClaim || onAssign != null || canSnooze;
    final String owner = _ownerLine(context);
    final String? escalation = _escalationLine(context);
    final String title = item.title.isEmpty ? alertSourceLabel(context, item.source) : item.title;
    final Widget? primary = onOpen != null
        ? FilledButton(
            onPressed: busy ? null : onOpen,
            child: Text(context.t('mob.alert.action.open.label')),
          )
        : (canClaim ? FilledButton(onPressed: busy ? null : onClaim, child: Text(context.t('mob.alert.action.claim.label'))) : null);
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
                      if (canClaim) PopupMenuItem<String>(value: 'claim', child: Text(context.t('mob.alert.action.claim.label'))),
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
                  Text(owner, style: theme.textTheme.bodySmall),
                  if (escalation != null) Text(escalation, style: theme.textTheme.bodySmall),
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

  String? _escalationLine(BuildContext context) {
    final AlertEscalation? escalation = item.escalation;
    if (escalation == null) return null;
    final Map<String, Object> values = <String, Object>{'level': escalation.level, 'of': escalation.of, 'at': escalation.nextAt == null ? '' : formatMoment(escalation.nextAt!)};
    return escalation.nextAt == null ? context.t('mob.alert.escalation.level.line', values) : context.t('mob.alert.escalation.next.line', values);
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(color: MachvonColors.neutralSoft, borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.pill))),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space8, vertical: MachvonSpace.space4),
        child: Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: MachvonColors.neutral)),
      ),
    );
  }
}
