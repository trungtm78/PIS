import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/theme/typography.dart';
import '../read_support/widgets.dart';
import 'labels.dart';
import 'node_stats.dart';

/// How many of each list the card writes out; the rest is counted (the full lists are on the computer).
const int kPrcNodeStatsShown = 5;

/// The statistics of the node that is open on the packages-by-step screen: the days the packages stay, the counts that need a person, who holds
/// most of them, what is still open and the weekly arrivals and departures. [stats] is null when the server could not give them: the card
/// then says so with the code and the list below stays right.
class NodeStatsCard extends StatelessWidget {
  const NodeStatsCard({required this.stats, this.errorCode, super.key});

  final PrcNodeStats? stats;
  final String? errorCode;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final PrcNodeStats? one = stats;
    if (one == null) {
      return SectionCard(
        title: context.t('mob.prc.node.title'),
        children: <Widget>[Text(context.t('mob.prc.node.unavailable', <String, Object>{'code': errorCode ?? 'UNKNOWN'}), style: text.body)],
      );
    }
    final String unit = one.working == false ? context.t('mob.prc.node.unit.calendar') : context.t('mob.prc.node.unit.working');
    return SectionCard(
      key: const ValueKey<String>('prc-node-stats'),
      title: context.t('mob.prc.node.title'),
      children: <Widget>[
        FactLine(label: context.t('mob.prc.node.count'), value: '${one.count}'),
        FactLine(label: context.t('mob.prc.node.late'), value: '${one.lateCount}'),
        if (one.stalledCount != null) FactLine(label: context.t('mob.prc.node.stalled'), value: '${one.stalledCount}'),
        if (one.heldCount != null) FactLine(label: context.t('mob.prc.node.held'), value: '${one.heldCount}'),
        if (one.noOwnerCount != null) FactLine(label: context.t('mob.prc.node.noOwner'), value: '${one.noOwnerCount}'),
        if (one.hasDays) ...<Widget>[
          if (one.medianDays != null) FactLine(label: context.t('mob.prc.node.median'), value: context.t('mob.prc.node.days', <String, Object>{'n': daysNumber(context, one.medianDays!), 'unit': unit})),
          if (one.longestDays != null) FactLine(label: context.t('mob.prc.node.longest'), value: context.t('mob.prc.node.days', <String, Object>{'n': '${one.longestDays}', 'unit': unit})),
          if (one.shortestDays != null) FactLine(label: context.t('mob.prc.node.shortest'), value: context.t('mob.prc.node.days', <String, Object>{'n': '${one.shortestDays}', 'unit': unit})),
        ] else
          Text(context.t('mob.prc.node.noDays'), style: text.caption),
        if (one.topOwners.isNotEmpty) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s8),
          Semantics(header: true, child: Text(context.t('mob.prc.node.owners'), style: text.heading)),
          for (final PrcTopOwner owner in one.topOwners.take(kPrcNodeStatsShown)) Text(context.t('mob.prc.node.owner.line', <String, Object>{'name': owner.name, 'count': owner.count}), style: text.body),
        ],
        if (one.unfinished.isNotEmpty) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s8),
          Semantics(header: true, child: Text(context.t('mob.prc.node.unfinished'), style: text.heading)),
          for (final PrcUnfinishedItem item in one.unfinished.take(kPrcNodeStatsShown)) Text(context.t('mob.prc.node.unfinished.line', <String, Object>{'name': item.label, 'count': item.count}), style: text.body),
        ],
        if (one.weeks.isNotEmpty) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s8),
          Semantics(header: true, child: Text(context.t('mob.prc.node.weeks'), style: text.heading)),
          for (final PrcWeek week in one.weeks.reversed.take(kPrcNodeStatsShown).toList().reversed)
            Text(context.t('mob.prc.node.week.line', <String, Object>{'day': formatDay(week.weekOf), 'in': week.arrivals, 'out': week.departures}), style: text.body),
        ],
        if (one.truncated) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.prc.node.truncated'), style: text.caption)),
      ],
    );
  }
}

