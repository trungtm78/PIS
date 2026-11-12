import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/command_band.dart';
import '../../../core/widgets/figure_info.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/nav_row.dart';
import '../../../core/widgets/section_panel.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../directives/widgets/directive_widget.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../alert_badge.dart';
import '../alerts.dart';
import '../command_center.dart';
import '../home_data.dart';
import '../widgets/alert_list.dart';
import '../widgets/changes_block.dart';
import '../widgets/committee_card.dart';
import '../widgets/edition_cards.dart';
import '../widgets/rag_card.dart';

/// MOB-07: the home of a leader, work before figures. From the top: the command band (the amount disbursed, one bar for the rate on the
/// total plan, the two rates in two notes); one line of context (scope, closing day, freshness); three figures that wait for someone;
/// the alerts "Needs your decision" (the three most important of the scope, each a row with one primary action; the alerts of the person
/// when the scope is refused); and under them the rest of the home: the committee, what changed since last week, the colours of the units, the
/// steering directives, the figures with their formulas and the shortcuts of the role. All figures are of one frozen snapshot and of the
/// projects in the scope of the reader (the server decides the scope; nothing here adds a project). A rate that cannot be given says why and
/// is never shown as zero. The alerts and the command center are read apart: one failing is named and leaves the other in place. Every
/// figure carries its "i" (formula, source, day, owner, version), and each part names its own failure with its own retry.
Widget buildLeaderHomeScreen(BuildContext context, ScreenContext screen) => const LeaderHomeScreen();

class LeaderHomeScreen extends ConsumerStatefulWidget {
  const LeaderHomeScreen({super.key});

  @override
  ConsumerState<LeaderHomeScreen> createState() => _LeaderHomeScreenState();
}

class _LeaderHomeScreenState extends ConsumerState<LeaderHomeScreen> {
  int _retry = 0;

  @override
  void initState() {
    super.initState();
    // Starts the count of the Notifications tab (it reads again on resume, on a push and after an act); nothing here depends on it.
    ref.read(alertBadgeProvider);
  }

  @override
  Widget build(BuildContext context) {
    // The command band is the top of the screen, so the frame draws no bar of its own.
    return AppScaffold(
      showTopBar: false,
      body: DataView<LeaderHomeData>(
        cacheKey: 'home.leader',
        reloadKey: (_retry, ref.watch(alertsChangedProvider)),
        read: readLeaderHome,
        parse: parseLeaderHome,
        asOf: (LeaderHomeData home) => home.center?.asOfDate ?? home.alerts?.asOf,
        emptyOnCodes: const <String>{'RESOURCE_NOT_FOUND'},
        contextParts: (Loaded<LeaderHomeData> loaded) {
          final CommandCenter? center = loaded.value.center;
          if (center == null) return const <String>[];
          return <String>[
            center.scopeUnitId == null
                ? context.t('mob.home.line.scope.all', <String, Object>{'projects': center.scopeProjects})
                : context.t('mob.home.line.scope.unit', <String, Object>{'projects': center.scopeProjects}),
          ];
        },
        contextBuilder: (BuildContext context, Loaded<LeaderHomeData> loaded, Widget contextLine) =>
            _HomeBody(loaded: loaded, contextLine: contextLine, onRetry: () => setState(() => _retry += 1)),
      ),
    );
  }
}

class _HomeBody extends StatelessWidget {
  const _HomeBody({required this.loaded, required this.contextLine, required this.onRetry});

  final Loaded<LeaderHomeData> loaded;
  final Widget contextLine;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final LeaderHomeData home = loaded.value;
    final CommandCenter? center = home.center;
    final ({Tile pm, Tile total})? pair = center?.ratePair;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        const EditionHomeHeader(),
        if (center != null)
          _HomeBand(center: center, pair: pair)
        else ...<Widget>[
          const AppTopBar(showBack: false),
          LargeTitleHeader(title: context.t('mob.home.leader.band.title')),
        ],
        contextLine,
        if (center != null) _StatRow(center: center),
        AlertsPanel(
          feed: home.alerts,
          errorCode: home.alertsError,
          onReload: onRetry,
          title: context.t('mob.home.decide.title'),
          readOnly: loaded.fromCache,
          stale: loaded.fromCache && loaded.stale,
          fetchedAt: loaded.fetchedAt,
          scopeRefused: home.scopeRefused,
        ),
        if (center == null) _CenterProblem(code: home.centerError ?? 'UNKNOWN', onRetry: onRetry),
        const CommitteeCard(key: ValueKey<String>('committee-workspace')),
        const EditionHomeCards(),
        ChangesBlock(changes: home.changes, errorCode: home.changesError, onRetry: onRetry),
        RagCard(reading: home.rag, errorCode: home.ragError, onRetry: onRetry),
        DirectiveWidgetCard(data: home.directives, errorCode: home.directivesError, onRetry: onRetry),
        if (center != null) _Figures(center: center, pair: pair),
        SectionPanel(
          title: context.t('mob.home.shortcuts.title'),
          padded: false,
          children: <Widget>[
            NavRow(label: context.t('mob.home.link.work'), icon: Icons.checklist, onTap: () => openScreen(context, 'MOB-08')),
            NavRow(label: context.t('mob.pbi.link.dashboard'), icon: Icons.insights_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-40')),
            NavRow(label: context.t('mob.home.link.funding'), icon: Icons.account_balance_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-58')),
            NavRow(label: context.t('mob.home.link.unreported'), icon: Icons.assignment_late_outlined, dividerAbove: true, onTap: () => openScreen(context, 'MOB-57')),
          ],
        ),
      ],
    );
  }
}

/// A figure split from its unit for the band: `1.058,3` and `ty dong`.
({String figure, String unit}) _figureOf(BuildContext context, String? vnd) {
  final String label = moneyLabel(context, vnd, decimals: 1);
  final int cut = label.indexOf(' ');
  return cut < 0 ? (figure: label, unit: '') : (figure: label.substring(0, cut), unit: label.substring(cut + 1));
}

/// The command band: the amount disbursed through the Treasury, one bar for the rate on the total plan, the two rates in two notes. A rate
/// that cannot be given says why in its place; the bar then stays empty and is never read as a rate.
class _HomeBand extends StatelessWidget {
  const _HomeBand({required this.center, required this.pair});

  final CommandCenter center;
  final ({Tile pm, Tile total})? pair;

  @override
  Widget build(BuildContext context) {
    final String language = AppStrings.of(context).language;
    Tile? amount;
    for (final Tile tile in center.amountTiles) {
      if (tile.metricCode == 'DISBURSED_TREASURY') amount = tile;
    }
    amount ??= center.amountTiles.isEmpty ? null : center.amountTiles.first;
    final bool amountKnown = amount != null && amount.value != null;
    final ({String figure, String unit}) split = amountKnown ? _figureOf(context, amount.value) : (figure: amount == null ? context.t('mob.home.tile.nullReason.other') : _nullReasonText(context, amount.nullReason), unit: '');
    final String? totalValue = pair?.total.value;
    final double? rate = totalValue == null ? null : double.tryParse(totalValue);
    final String total = totalValue == null ? _nullReasonText(context, pair?.total.nullReason) : context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(pair!.total.displayValue ?? totalValue, language)});
    return CommandBand(
      title: context.t('mob.home.leader.band.title'),
      label: context.t('mob.home.tile.metric.disbursed'),
      figure: split.figure,
      unit: split.unit,
      progress: rate == null ? 0 : (rate / 100).clamp(0.0, 1.0),
      progressLabel: rate == null ? total : context.t('mob.home.band.progress', <String, Object>{'value': total}),
      footStart: pair == null ? '' : _rateNote(context, pair!.pm),
      footEnd: pair == null ? '' : _rateNote(context, pair!.total),
      showBack: false,
    );
  }

  String _rateNote(BuildContext context, Tile tile) {
    final String value = tile.value == null
        ? _nullReasonText(context, tile.nullReason)
        : context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(tile.displayValue ?? tile.value!, AppStrings.of(context).language)});
    return context.t('mob.home.band.rate.line', <String, Object>{'label': metricLabel(context, tile.metricCode), 'value': value});
  }
}

/// The three counts that wait for someone, in one band of the screen, each with the "i" of its definition.
class _StatRow extends StatelessWidget {
  const _StatRow({required this.center});

  final CommandCenter center;

  @override
  Widget build(BuildContext context) {
    return StatStrip(
      cells: <StatCell>[
        StatCell(
          value: '${center.openWarnings}',
          label: context.t('mob.home.stat.warnings.label'),
          band: center.openWarnings > 0 ? DeadlineBand.soon : null,
          bandText: context.t('mob.home.stat.watch.text'),
          info: center.countOf(openWarningsMetric)?.info,
        ),
        StatCell(
          value: '${center.overdueExplanations}',
          label: context.t('mob.home.stat.explanations.label'),
          band: center.overdueExplanations > 0 ? DeadlineBand.late : null,
          bandText: context.t('mob.home.stat.overdue.text'),
          info: center.countOf(overdueExplanationsMetric)?.info,
        ),
        StatCell(
          value: '${center.pendingReallocations}',
          label: context.t('mob.home.stat.reallocations.label'),
          info: center.countOf(pendingReallocationsMetric)?.info,
        ),
      ],
    );
  }
}

/// The figures with what makes them citable: the two rates and the amounts, each with its numerator and denominator, its formula and the state of
/// the definition, and the context of the snapshot (the Treasury cutoff, the snapshot, the quality). The scope and the closing day are in the line of
/// context above, not said again here.
class _Figures extends StatelessWidget {
  const _Figures({required this.center, required this.pair});

  final CommandCenter center;
  final ({Tile pm, Tile total})? pair;

  @override
  Widget build(BuildContext context) {
    return SectionPanel(
      title: context.t('mob.home.details.title'),
      padded: false,
      children: <Widget>[
        if (pair == null)
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16), child: Text(context.t('mob.home.rates.unavailable'), style: context.v2text.body))
        else ...<Widget>[MetricTileCard(tile: pair!.pm), MetricTileCard(tile: pair!.total, dividerAbove: true)],
        for (final Tile tile in center.amountTiles) MetricTileCard(tile: tile, dividerAbove: true),
        if (center.projectsWithoutData > 0)
          Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
            child: Text(context.t('mob.home.rates.withoutData', <String, Object>{'count': center.projectsWithoutData}), style: context.v2text.caption),
          ),
        if (center.treasuryCutoffDate.isNotEmpty) InfoRow(label: context.t('mob.home.context.cutoff.label'), value: asOfLabel(center.treasuryCutoffDate)),
        InfoRow(label: context.t('mob.home.context.snapshot.label'), value: _shortId(center.snapshotId)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Text(_qualityLabel(context, center.qualityBadge), style: context.v2text.caption),
        ),
        if (center.isStale)
          Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
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

/// The command center could not be read: no snapshot yet, or a failure named with its code and a retry in place.
class _CenterProblem extends StatelessWidget {
  const _CenterProblem({required this.code, required this.onRetry});

  final String code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final bool noSnapshot = code == 'RESOURCE_NOT_FOUND';
    return SectionPanel(
      title: context.t('mob.home.command.title'),
      children: <Widget>[
        Semantics(
          liveRegion: true,
          container: true,
          child: noSnapshot
              ? Text(context.t('mob.home.command.empty.body'), style: context.v2text.body)
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.home.command.error.title'), style: context.v2text.bodyStrong),
                    Text(context.t('mob.home.command.error.body', <String, Object>{'code': code}), style: context.v2text.body),
                    const SizedBox(height: MachvonV2Space.s8),
                    OutlinedButton(onPressed: onRetry, style: v2QuietButtonStyle(context.v2), child: Text(context.t('mob.alert.list.retry.action'))),
                  ],
                ),
        ),
      ],
    );
  }
}

String _nullReasonText(BuildContext context, String? reason) {
  switch (reason) {
    case 'NO_DATA':
      return context.t('mob.home.tile.nullReason.noData');
    case 'ZERO_DENOMINATOR':
      return context.t('mob.home.tile.nullReason.zeroDenominator');
    case 'TREASURY_COVERAGE_NONE':
      return context.t('mob.home.tile.nullReason.treasuryNone');
    case 'NOT_CERTIFIED':
      return context.t('mob.home.tile.nullReason.notCertified');
    case 'OBSOLETE':
      return context.t('mob.home.tile.nullReason.obsolete');
    default:
      return context.t('mob.home.tile.nullReason.other');
  }
}

/// The name of a metric in the words of the interface (its code when it is not one the home knows).
String metricLabel(BuildContext context, String code) {
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

/// One figure with what makes it citable: its value or why it has none, its numerator and denominator, its formula and the state of the
/// definition. It is a row of the block of figures, not a box.
class MetricTileCard extends StatelessWidget {
  const MetricTileCard({required this.tile, this.dividerAbove = false, super.key});

  final Tile tile;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String label = metricLabel(context, tile.metricCode);
    final String value = _valueOf(context, tile);
    final String? sums = tile.hasSums
        ? '${context.t('mob.home.tile.numerator', <String, Object>{'value': moneyLabel(context, tile.numerator)})} · '
            '${context.t('mob.home.tile.denominator', <String, Object>{'value': moneyLabel(context, tile.denominator)})}'
        : null;
    final String definition = tile.isSigned
        ? context.t('mob.home.tile.definition.signed')
        : context.t('mob.home.tile.definition.pending', <String, Object>{'ref': formulaReference});
    final List<String> flags = _flagTexts(context, tile);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) const RowRule(),
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s8, MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: MergeSemantics(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(label, style: text.caption),
                          Text(value, style: text.title),
                          if (sums != null) Text(sums, style: text.caption),
                          Text(context.t('mob.home.tile.formula', <String, Object>{'formula': tile.formula}), style: text.caption),
                          Text(definition, style: text.caption),
                        ],
                      ),
                    ),
                  ),
                  if (tile.info != null) FigureInfoButton(info: tile.info!),
                ],
              ),
              if (flags.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: MachvonV2Space.s4),
                  child: Wrap(spacing: MachvonV2Space.s8, runSpacing: MachvonV2Space.s4, children: <Widget>[for (final String flag in flags) StatusPill(label: flag, warn: true)]),
                ),
            ],
          ),
        ),
      ],
    );
  }

  String _valueOf(BuildContext context, Tile tile) {
    final String? value = tile.value;
    if (value == null) return _nullReasonText(context, tile.nullReason);
    if (tile.unit == TileUnit.percent) {
      return context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(tile.displayValue ?? value, AppStrings.of(context).language)});
    }
    return moneyLabel(context, value);
  }
}

/// The flags that sit on a figure, as words. A flag that only repeats what is said in place of the number (no data, not certified, obsolete) is not said twice.
List<String> _flagTexts(BuildContext context, Tile tile) {
  final List<String> words = <String>[];
  for (final String flag in tile.flags) {
    switch (flag) {
      case 'STALE':
        words.add(context.t('mob.home.flag.stale.text'));
      case 'PARTIAL_COVERAGE':
        words.add(context.t('mob.home.flag.partial.text'));
      case 'UNVERIFIED_DEFINITION':
        words.add(context.t('mob.home.flag.unverified.text'));
    }
  }
  return words;
}
