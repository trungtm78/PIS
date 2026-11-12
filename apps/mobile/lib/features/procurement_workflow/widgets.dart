import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../read_support/widgets.dart';
import 'labels.dart';
import 'workflow_models.dart';

/// The tone and icon of a health: always paired with its word, never colour alone.
MachvonTone toneOfHealth(PrcHealth health) {
  switch (health) {
    case PrcHealth.ok:
      return MachvonTone.success;
    case PrcHealth.attention:
      return MachvonTone.warning;
    case PrcHealth.late:
      return MachvonTone.danger;
    case PrcHealth.hold:
    case PrcHealth.none:
      return MachvonTone.neutral;
  }
}

IconData iconOfHealth(PrcHealth health) {
  switch (health) {
    case PrcHealth.ok:
      return Icons.check_circle_outline;
    case PrcHealth.attention:
      return Icons.warning_amber_rounded;
    case PrcHealth.late:
      return Icons.block;
    case PrcHealth.hold:
      return Icons.pause_circle_outline;
    case PrcHealth.none:
      return Icons.remove_circle_outline;
  }
}

/// The health of a node as a pill: icon and word.
class HealthPill extends StatelessWidget {
  const HealthPill({required this.health, super.key});

  final PrcHealth health;

  @override
  Widget build(BuildContext context) {
    if (health == PrcHealth.none) return const SizedBox.shrink();
    return StatusPill(label: healthLabel(context, health), tone: toneOfHealth(health), icon: iconOfHealth(health));
  }
}

/// A 4 px bar that says what share of all packages a node holds; the share is also written as text beside it.
class ShareBar extends StatelessWidget {
  const ShareBar({required this.fraction, super.key});

  final double fraction;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill)),
        child: SizedBox(
          height: 4,
          child: Stack(
            children: <Widget>[
              const Positioned.fill(child: ColoredBox(color: MachvonColors.border)),
              FractionallySizedBox(widthFactor: fraction, child: const ColoredBox(color: MachvonColors.primary, child: SizedBox.expand())),
            ],
          ),
        ),
      ),
    );
  }
}

/// A package of a list: the code and the name, where it is, how long, who holds it and whether it is late. One tap target, read as one
/// sentence by a screen reader.
class PackageRowTile extends StatelessWidget {
  const PackageRowTile({required this.row, required this.onTap, super.key});

  final PrcPackageRow row;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String title = row.title ?? '';
    final String status = statusLabel(context, row.status);
    final int? days = row.daysWorking ?? row.daysCalendar;
    final String? daysText = days == null
        ? null
        : (row.daysWorking != null ? context.t('mob.prc.row.days.working', <String, Object>{'n': days}) : context.t('mob.prc.row.days.calendar', <String, Object>{'n': days}));
    final bool overdue = row.daysLeft != null && row.daysLeft! < 0;
    return TappableRow(
      semanticLabel: context.t('mob.prc.list.row.aria', <String, Object>{'code': row.code, 'title': title, 'status': status}),
      onTap: onTap,
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title.isEmpty ? row.code : '${row.code} · $title', style: theme.textTheme.bodyLarge),
                const SizedBox(height: MachvonSpace.space4),
                Wrap(
                  spacing: MachvonSpace.space8,
                  runSpacing: MachvonSpace.space4,
                  children: <Widget>[
                    StatusPill(label: status, tone: _toneOfStatus(row.status)),
                    if (row.late) StatusPill(label: context.t('mob.prc.row.late', <String, Object>{'n': row.lateDays}), tone: MachvonTone.danger, icon: Icons.block),
                    if (row.held) StatusPill(label: context.t('mob.prc.row.hold'), icon: Icons.pause_circle_outline),
                    if (row.stalled) StatusPill(label: context.t('mob.prc.row.stalled'), tone: MachvonTone.warning),
                  ],
                ),
                if (row.stepName != null && row.stepOrder != null)
                  Text(context.t('mob.prc.row.step', <String, Object>{'order': row.stepOrder!, 'of': row.stepsTotal ?? 0, 'name': row.stepName!}), style: theme.textTheme.bodyMedium),
                if (daysText != null) Text(daysText, style: theme.textTheme.bodySmall),
                if (row.running && row.progressPercent != null) Text(context.t('mob.prc.row.progress', <String, Object>{'percent': row.progressPercent!}), style: theme.textTheme.bodySmall),
                if (row.running && row.daysLeft != null && row.dueOn != null)
                  Text(countdownLabel(context, row.daysLeft!, row.dueOn!), style: theme.textTheme.bodySmall?.copyWith(color: overdue ? MachvonColors.danger : null)),
                if (row.projectCode.isNotEmpty)
                  Text(context.t('mob.prc.row.project', <String, Object>{'project': row.projectName == null ? row.projectCode : '${row.projectCode} · ${row.projectName}'}), style: theme.textTheme.bodySmall),
                Text(context.t('mob.prc.row.value', <String, Object>{'value': moneyLabel(context, row.valueVnd)}), style: theme.textTheme.bodySmall),
                if (row.running)
                  Text(
                    row.hasOwner && row.ownerName != null ? context.t('mob.prc.row.owner', <String, Object>{'name': row.ownerName!}) : context.t('mob.prc.row.ownerNone'),
                    style: theme.textTheme.bodySmall,
                  ),
              ],
            ),
          ),
          if (onTap != null) const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

MachvonTone _toneOfStatus(String status) {
  switch (status) {
    case 'IN_PROGRESS':
      return MachvonTone.info;
    case 'COMPLETED':
      return MachvonTone.success;
    default:
      return MachvonTone.neutral;
  }
}
