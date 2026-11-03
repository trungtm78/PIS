import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/money.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../command_center.dart';

/// MOB-07: the home of a leader. The two disbursement rates side by side, each with its numerator and denominator, the
/// amounts beside them, and what waits, all of one frozen snapshot and of the projects in the scope of the reader (the
/// server decides the scope; nothing here adds a project). A rate that cannot be given says why and is never shown as zero.
Widget buildLeaderHomeScreen(BuildContext context, ScreenContext screen) => const LeaderHomeScreen();

class LeaderHomeScreen extends StatelessWidget {
  const LeaderHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.home.leader.title'),
      body: DataView<CommandCenter>(
        cacheKey: 'home.center',
        read: (MachvonApiClient client) => client.getCommandCenter(),
        parse: parseCommandCenter,
        asOf: (CommandCenter center) => center.asOfDate,
        emptyOnCodes: const <String>{'RESOURCE_NOT_FOUND'},
        builder: (BuildContext context, loaded) => _CenterBody(center: loaded.value),
      ),
    );
  }
}

class _CenterBody extends StatelessWidget {
  const _CenterBody({required this.center});

  final CommandCenter center;

  @override
  Widget build(BuildContext context) {
    final ({Tile pm, Tile total})? pair = center.ratePair;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        _ContextCard(center: center),
        SectionCard(
          title: context.t('mob.home.rates.title'),
          children: <Widget>[
            if (pair == null)
              Text(context.t('mob.home.rates.unavailable'), style: Theme.of(context).textTheme.bodyMedium)
            else
              _SideBySide(children: <Widget>[MetricTileCard(tile: pair.pm), MetricTileCard(tile: pair.total)]),
            for (final Tile tile in center.amountTiles) ...<Widget>[const SizedBox(height: MachvonSpace.space8), MetricTileCard(tile: tile)],
            if (center.projectsWithoutData > 0)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space8),
                child: Text(context.t('mob.home.rates.withoutData', <String, Object>{'count': center.projectsWithoutData})),
              ),
          ],
        ),
        SectionCard(
          title: context.t('mob.home.waiting.title'),
          children: <Widget>[
            Text(context.t('mob.home.waiting.warnings', <String, Object>{'count': center.openWarnings})),
            Text(context.t('mob.home.waiting.explanations', <String, Object>{'count': center.overdueExplanations})),
            Text(context.t('mob.home.waiting.reallocations', <String, Object>{'count': center.pendingReallocations})),
          ],
        ),
        _LinkRow(label: context.t('mob.home.link.work'), onTap: () => openScreen(context, 'MOB-08')),
        _LinkRow(label: context.t('mob.pbi.link.dashboard'), onTap: () => openScreen(context, 'MOB-40')),
        _LinkRow(label: context.t('mob.home.link.funding'), onTap: () => openScreen(context, 'MOB-58')),
        _LinkRow(label: context.t('mob.home.link.unreported'), onTap: () => openScreen(context, 'MOB-57')),
      ],
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TappableRow(
      semanticLabel: label,
      onTap: onTap,
      child: Row(
        children: <Widget>[
          Expanded(child: Text(label, style: Theme.of(context).textTheme.bodyLarge)),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

/// Two blocks side by side; one under the other when the text is enlarged so much that two columns would not hold a figure.
class _SideBySide extends StatelessWidget {
  const _SideBySide({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final bool stacked = MediaQuery.textScalerOf(context).scale(1) > 1.5;
    if (stacked) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[for (final Widget child in children) Padding(padding: const EdgeInsets.only(bottom: MachvonSpace.space8), child: child)],
      );
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (int index = 0; index < children.length; index += 1) ...<Widget>[
            if (index > 0) const SizedBox(width: MachvonSpace.space8),
            Expanded(child: children[index]),
          ],
        ],
      ),
    );
  }
}

class _ContextCard extends StatelessWidget {
  const _ContextCard({required this.center});

  final CommandCenter center;

  @override
  Widget build(BuildContext context) {
    final String scope = center.scopeUnitId == null
        ? context.t('mob.home.context.scope.all', <String, Object>{'projects': center.scopeProjects})
        : context.t('mob.home.context.scope.unit', <String, Object>{'projects': center.scopeProjects});
    return SectionCard(
      title: context.t('mob.home.context.title'),
      children: <Widget>[
        FactLine(label: context.t('mob.home.context.scope.label'), value: scope),
        FactLine(label: context.t('mob.home.context.asOf.label'), value: asOfLabel(center.asOfDate)),
        if (center.treasuryCutoffDate.isNotEmpty)
          FactLine(label: context.t('mob.home.context.cutoff.label'), value: asOfLabel(center.treasuryCutoffDate)),
        FactLine(label: context.t('mob.home.context.snapshot.label'), value: _shortId(center.snapshotId)),
        Wrap(children: <Widget>[StatusPill(label: _qualityLabel(context, center.qualityBadge))]),
        if (center.isStale)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Semantics(liveRegion: true, child: StatusPill(label: context.t('mob.home.context.stale.notice'), warn: true)),
          ),
      ],
    );
  }

  String _qualityLabel(BuildContext context, QualityBadge badge) {
    switch (badge) {
      case QualityBadge.ok:
        return context.t('mob.home.quality.ok');
      case QualityBadge.warn:
        return context.t('mob.home.quality.warn');
      case QualityBadge.fail:
        return context.t('mob.home.quality.fail');
      case QualityBadge.notAssessed:
        return context.t('mob.home.quality.notAssessed');
    }
  }
}

/// The first and the last characters of a snapshot id: enough to cite it.
String _shortId(String id) => id.length <= 13 ? id : '${id.substring(0, 8)}…${id.substring(id.length - 4)}';

/// One figure with what makes it citable: its value or why it has none, its numerator and denominator, its formula and the
/// state of the definition.
class MetricTileCard extends StatelessWidget {
  const MetricTileCard({required this.tile, super.key});

  final Tile tile;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String label = _metricLabel(context, tile.metricCode);
    final String value = _valueOf(context, tile);
    final String? sums = tile.hasSums
        ? '${context.t('mob.home.tile.numerator', <String, Object>{'value': millionsLabel(context, tile.numerator)})} · '
            '${context.t('mob.home.tile.denominator', <String, Object>{'value': millionsLabel(context, tile.denominator)})}'
        : null;
    final String definition = tile.isSigned
        ? context.t('mob.home.tile.definition.signed')
        : context.t('mob.home.tile.definition.pending', <String, Object>{'ref': formulaReference});
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: MachvonColors.border),
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space12),
        child: MergeSemantics(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(label, style: theme.textTheme.bodySmall),
              Text(value, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
              if (sums != null) Text(sums, style: theme.textTheme.bodySmall),
              Text(context.t('mob.home.tile.formula', <String, Object>{'formula': tile.formula}), style: theme.textTheme.bodySmall),
              Text(definition, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      ),
    );
  }

  String _valueOf(BuildContext context, Tile tile) {
    final String? value = tile.value;
    if (value == null) return _nullReason(context, tile.nullReason);
    if (tile.unit == TileUnit.percent) {
      return context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(value, AppStrings.of(context).language)});
    }
    return millionsLabel(context, value);
  }

  String _nullReason(BuildContext context, String? reason) {
    switch (reason) {
      case 'NO_DATA':
        return context.t('mob.home.tile.nullReason.noData');
      case 'ZERO_DENOMINATOR':
        return context.t('mob.home.tile.nullReason.zeroDenominator');
      case 'TREASURY_COVERAGE_NONE':
        return context.t('mob.home.tile.nullReason.treasuryNone');
      default:
        return context.t('mob.home.tile.nullReason.other');
    }
  }

  String _metricLabel(BuildContext context, String code) {
    switch (code) {
      case ratePmMetric:
        return context.t('mob.home.tile.metric.ratePm');
      case rateTotalMetric:
        return context.t('mob.home.tile.metric.rateTotal');
      case 'DISBURSED_TREASURY':
        return context.t('mob.home.tile.metric.disbursed');
      case 'PLAN_PM_ASSIGNED':
        return context.t('mob.home.tile.metric.planPm');
      case 'PLAN_TOTAL':
        return context.t('mob.home.tile.metric.planTotal');
      default:
        return code;
    }
  }
}
