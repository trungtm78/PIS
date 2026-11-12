import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/deadline.dart';
import '../../core/widgets/tap_target.dart';
import '../../core/widgets/work_row.dart';
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
    final MachvonV2Palette palette = context.v2.palette;
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.pill)),
        child: SizedBox(
          height: 4,
          child: Stack(
            children: <Widget>[
              Positioned.fill(child: ColoredBox(color: palette.line)),
              FractionallySizedBox(widthFactor: fraction, child: ColoredBox(color: palette.primary, child: const SizedBox.expand())),
            ],
          ),
        ),
      ),
    );
  }
}

/// The band of a package: done when it is completed, else the band of its due day as the server counted it (never the clock of the phone);
/// null when the package has no due day to count (not started, on hold, cancelled).
DeadlineBand? bandOfRow(PrcPackageRow row) {
  if (row.status == 'COMPLETED') return DeadlineBand.done;
  final int? left = row.daysLeft;
  if (!row.running || left == null || row.dueOn == null) return null;
  return DeadlineBand.fromDays(left);
}

/// A package of a list: the code and the name, where it is (the step of the workflow), its deadline band with the real due day, and the facts
/// that decide whether to open it: the state, how long it has been there, the project, the price and who holds it. One tap target, read as
/// one sentence by a screen reader.
class PackageRowTile extends StatelessWidget {
  const PackageRowTile({required this.row, required this.onTap, this.dividerAbove = true, super.key});

  final PrcPackageRow row;
  final VoidCallback? onTap;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String title = row.title ?? '';
    final String status = statusLabel(context, row.status);
    final int? days = row.daysWorking ?? row.daysCalendar;
    final String? daysText = days == null
        ? null
        : (row.daysWorking != null ? context.t('mob.prc.row.days.working', <String, Object>{'n': days}) : context.t('mob.prc.row.days.calendar', <String, Object>{'n': days}));
    final DeadlineBand? band = bandOfRow(row);
    final bool counted = row.running && row.daysLeft != null && row.dueOn != null;
    final double inset = band == null ? MachvonV2Space.s16 : MachvonV2Space.s16 + MachvonV2Size.glyph + MachvonV2Space.s12;
    Widget fact(String line) => Text(line, style: text.caption);
    final Widget main = WorkRow(
      title: title.isEmpty ? row.code : '${row.code} · $title',
      subtitle: row.stepName != null && row.stepOrder != null
          ? context.t('mob.prc.row.step', <String, Object>{'order': row.stepOrder!, 'of': row.stepsTotal ?? 0, 'name': row.stepName!})
          : null,
      leading: band == null ? null : DeadlineGlyph(band: band),
      trailing: counted ? DeadlineLabel(band: band!, text: countdownLabel(context, row.daysLeft!, row.dueOn!), dueDay: row.dueOn) : null,
    );
    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        main,
        Padding(
          padding: EdgeInsets.only(left: inset, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Wrap(
                spacing: MachvonV2Space.s8,
                runSpacing: MachvonV2Space.s4,
                children: <Widget>[
                  StatusPill(label: status, tone: _toneOfStatus(row.status)),
                  if (row.late) StatusPill(label: context.t('mob.prc.row.late', <String, Object>{'n': row.lateDays}), tone: MachvonTone.danger, icon: Icons.block),
                  if (row.held) StatusPill(label: context.t('mob.prc.row.hold'), icon: Icons.pause_circle_outline),
                  if (row.stalled) StatusPill(label: context.t('mob.prc.row.stalled'), tone: MachvonTone.warning),
                ],
              ),
              const SizedBox(height: MachvonV2Space.s4),
              if (daysText != null) fact(daysText),
              if (row.running && row.progressPercent != null) fact(context.t('mob.prc.row.progress', <String, Object>{'percent': row.progressPercent!})),
              if (row.projectCode.isNotEmpty)
                fact(context.t('mob.prc.row.project', <String, Object>{'project': row.projectName == null ? row.projectCode : '${row.projectCode} · ${row.projectName}'})),
              fact(context.t('mob.prc.row.value', <String, Object>{'value': moneyLabel(context, row.valueVnd)})),
              if (row.running) fact(row.hasOwner && row.ownerName != null ? context.t('mob.prc.row.owner', <String, Object>{'name': row.ownerName!}) : context.t('mob.prc.row.ownerNone')),
            ],
          ),
        ),
      ],
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) Padding(padding: EdgeInsets.only(left: inset), child: SizedBox(height: 1, child: ColoredBox(color: context.v2.palette.line))),
        TapTarget(
          onTap: onTap,
          radius: 0,
          semanticLabel: <String>[
            context.t('mob.prc.list.row.aria', <String, Object>{'code': row.code, 'title': title, 'status': status}),
            if (counted) '${deadlineBandName(context, band!)}: ${countdownLabel(context, row.daysLeft!, row.dueOn!)}',
          ].join(', '),
          child: SizedBox(width: double.infinity, child: body),
        ),
      ],
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
