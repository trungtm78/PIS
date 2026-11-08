import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/widgets/figure_info.dart';
import '../../directives/widgets/directive_widget.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/money.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../alert_badge.dart';
import '../alerts.dart';
import '../command_center.dart';
import '../home_data.dart';
import '../widgets/alert_list.dart';
import '../widgets/changes_block.dart';
import '../widgets/rag_card.dart';

/// MOB-07: the home of a leader, work before figures. From the top: one line of context (scope, closing day, freshness); the
/// alerts "Needs action now" (the three most important of the scope, each with one primary action; the alerts of the person when the
/// scope is refused); a compact command block (the amount, a small ring, the two rates with their denominators); the shortcuts of
/// the role; and the summary of the figures. All figures are of one frozen snapshot and of the projects in the scope of the reader
/// (the server decides the scope; nothing here adds a project). A rate that cannot be given says why and is never shown as zero.
/// The alerts and the command center are read apart: one failing is named and leaves the other in place. Beside the command center are the parts the web
/// leader home has: what changed since last week, the colours of the units with the reason for each, and the steering directives; every figure carries its
/// "i" (formula, source, day, owner, version), and each of those parts names its own failure with its own retry.
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
    return ScreenFrame(
      title: context.t('mob.home.leader.title'),
      body: DataView<LeaderHomeData>(
        cacheKey: 'home.leader',
        reloadKey: (_retry, ref.watch(alertsChangedProvider)),
        read: readLeaderHome,
        parse: parseLeaderHome,
        asOf: (LeaderHomeData home) => home.center?.asOfDate ?? home.alerts?.asOf,
        emptyOnCodes: const <String>{'RESOURCE_NOT_FOUND'},
        builder: (BuildContext context, Loaded<LeaderHomeData> loaded) => _HomeBody(loaded: loaded, onRetry: () => setState(() => _retry += 1)),
      ),
    );
  }
}

class _HomeBody extends StatelessWidget {
  const _HomeBody({required this.loaded, required this.onRetry});

  final Loaded<LeaderHomeData> loaded;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final LeaderHomeData home = loaded.value;
    final CommandCenter? center = home.center;
    final ({Tile pm, Tile total})? pair = center?.ratePair;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        _ContextLine(center: center, loaded: loaded),
        AlertsPanel(
          feed: home.alerts,
          errorCode: home.alertsError,
          onReload: onRetry,
          readOnly: loaded.fromCache,
          stale: loaded.fromCache && loaded.stale,
          fetchedAt: loaded.fetchedAt,
          scopeRefused: home.scopeRefused,
        ),
        if (center != null) _CommandBlock(center: center, pair: pair) else _CommandBlockProblem(code: home.centerError ?? 'UNKNOWN', onRetry: onRetry),
        ChangesBlock(changes: home.changes, errorCode: home.changesError, onRetry: onRetry),
        RagCard(reading: home.rag, errorCode: home.ragError, onRetry: onRetry),
        DirectiveWidgetCard(data: home.directives, errorCode: home.directivesError, onRetry: onRetry),
        SectionCard(
          title: context.t('mob.home.shortcuts.title'),
          children: <Widget>[
            _LinkRow(label: context.t('mob.home.link.work'), onTap: () => openScreen(context, 'MOB-08')),
            _LinkRow(label: context.t('mob.pbi.link.dashboard'), onTap: () => openScreen(context, 'MOB-40')),
            _LinkRow(label: context.t('mob.home.link.funding'), onTap: () => openScreen(context, 'MOB-58')),
            _LinkRow(label: context.t('mob.home.link.unreported'), onTap: () => openScreen(context, 'MOB-57')),
          ],
        ),
        if (center != null) ...<Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space8, MachvonSpace.space16, 0),
            child: Semantics(header: true, child: Text(context.t('mob.home.summary.title'), style: Theme.of(context).textTheme.titleMedium)),
          ),
          SectionCard(
            title: context.t('mob.home.summary.rates.title'),
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
              _CountLine(text: context.t('mob.home.waiting.warnings', <String, Object>{'count': center.openWarnings}), figure: center.countOf(openWarningsMetric)),
              _CountLine(text: context.t('mob.home.waiting.explanations', <String, Object>{'count': center.overdueExplanations}), figure: center.countOf(overdueExplanationsMetric)),
              _CountLine(text: context.t('mob.home.waiting.reallocations', <String, Object>{'count': center.pendingReallocations}), figure: center.countOf(pendingReallocationsMetric)),
            ],
          ),
          _ContextCard(center: center),
        ],
      ],
    );
  }
}

/// The scope, the closing day and the freshness of what is on the screen, in one line.
class _ContextLine extends StatelessWidget {
  const _ContextLine({required this.center, required this.loaded});

  final CommandCenter? center;
  final Loaded<LeaderHomeData> loaded;

  @override
  Widget build(BuildContext context) {
    final CommandCenter? c = center;
    final String updated = formatFetched(loaded.fetchedAt);
    final List<String> parts = <String>[
      if (c != null)
        c.scopeUnitId == null
            ? context.t('mob.home.line.scope.all', <String, Object>{'projects': c.scopeProjects})
            : context.t('mob.home.line.scope.unit', <String, Object>{'projects': c.scopeProjects}),
      if (c != null) context.t('mob.home.line.closing.text', <String, Object>{'date': asOfLabel(c.asOfDate)}),
      context.t('mob.home.line.updated.text', <String, Object>{'time': updated.substring(updated.length - 5)}),
      if ((c?.isStale ?? false) || (loaded.fromCache && loaded.stale)) context.t('mob.home.line.stale.text'),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space8, MachvonSpace.space16, 0),
      child: Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
    );
  }
}

/// A rate without its trailing zeros for the ring (`12,5%`); the exact figure with its denominator is beside it.
String _shortPercent(String value, String language) {
  final double? parsed = double.tryParse(value);
  if (parsed == null) return value;
  String text = parsed.toStringAsFixed(1);
  if (text.endsWith('.0')) text = text.substring(0, text.length - 2);
  return '${language == 'en' ? text : text.replaceAll('.', ',')}%';
}

/// The command block, compact: the amount at 32 and a small ring for the rate on the total plan, then the two rates each with the
/// numerator over the denominator it was computed from. About 140 logical pixels at the normal text size.
class _CommandBlock extends StatelessWidget {
  const _CommandBlock({required this.center, required this.pair});

  final CommandCenter center;
  final ({Tile pm, Tile total})? pair;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String language = AppStrings.of(context).language;
    Tile? amount;
    for (final Tile tile in center.amountTiles) {
      if (tile.metricCode == 'DISBURSED_TREASURY') amount = tile;
    }
    amount ??= center.amountTiles.isEmpty ? null : center.amountTiles.first;
    final String? totalValue = pair?.total.value;
    final double? ringValue = totalValue == null ? null : double.tryParse(totalValue);
    final Tile? shownAmount = amount;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Semantics(header: true, child: Text(context.t('mob.home.command.title'), style: theme.textTheme.titleMedium)),
            const SizedBox(height: MachvonSpace.space8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                Expanded(
                  child: MergeSemantics(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(context.t('mob.home.tile.metric.disbursed'), style: theme.textTheme.bodySmall),
                        Text(
                          shownAmount == null
                              ? context.t('mob.home.tile.nullReason.other')
                              : (shownAmount.value == null ? _nullReasonText(context, shownAmount.nullReason) : millionsLabel(context, shownAmount.value)),
                          style: theme.textTheme.headlineSmall?.copyWith(fontSize: 32, fontWeight: FontWeight.w700, height: 1.1),
                        ),
                      ],
                    ),
                  ),
                ),
                if (shownAmount?.info != null) FigureInfoButton(info: shownAmount!.info!),
                if (ringValue != null && totalValue != null)
                  Semantics(
                    label: context.t('mob.home.command.ring.aria', <String, Object>{'value': context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(totalValue, language)})}),
                    excludeSemantics: true,
                    child: _Ring(fraction: (ringValue / 100).clamp(0.0, 1.0), label: _shortPercent(totalValue, language)),
                  ),
              ],
            ),
            if (pair != null) ...<Widget>[
              const SizedBox(height: MachvonSpace.space8),
              Semantics(header: true, child: Text(context.t('mob.home.rates.title'), style: theme.textTheme.labelLarge)),
              _rateLine(context, pair!.pm),
              _rateLine(context, pair!.total),
            ],
          ],
        ),
      ),
    );
  }

  Widget _rateLine(BuildContext context, Tile tile) {
    final String label = metricLabel(context, tile.metricCode);
    final String value = tile.value == null
        ? _nullReasonText(context, tile.nullReason)
        : context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(tile.displayValue ?? tile.value!, AppStrings.of(context).language)});
    final String line = tile.hasSums && tile.value != null
        ? context.t('mob.home.command.rate.line', <String, Object>{'label': label, 'value': value, 'numerator': millionsLabel(context, tile.numerator), 'denominator': millionsLabel(context, tile.denominator)})
        : '$label: $value';
    final FigureInfo? info = tile.info;
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space4),
      child: Row(
        children: <Widget>[
          Expanded(child: Text(line, style: Theme.of(context).textTheme.bodySmall)),
          if (info != null) FigureInfoButton(info: info),
        ],
      ),
    );
  }
}

class _Ring extends StatelessWidget {
  const _Ring({required this.fraction, required this.label});

  final double fraction;
  final String label;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 64,
      height: 64,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          CustomPaint(size: const Size(64, 64), painter: _RingPainter(fraction)),
          Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter(this.fraction);

  final double fraction;

  @override
  void paint(Canvas canvas, Size size) {
    const double stroke = 7;
    final Rect arc = (Offset.zero & size).deflate(stroke / 2);
    final Paint track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = MachvonColors.neutralSoft;
    final Paint value = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..color = MachvonColors.primary;
    canvas.drawArc(arc, 0, 2 * math.pi, false, track);
    canvas.drawArc(arc, -math.pi / 2, 2 * math.pi * fraction, false, value);
  }

  @override
  bool shouldRepaint(_RingPainter oldDelegate) => oldDelegate.fraction != fraction;
}

class _CommandBlockProblem extends StatelessWidget {
  const _CommandBlockProblem({required this.code, required this.onRetry});

  final String code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final bool noSnapshot = code == 'RESOURCE_NOT_FOUND';
    return SectionCard(
      title: context.t('mob.home.command.title'),
      children: <Widget>[
        Semantics(
          liveRegion: true,
          container: true,
          child: noSnapshot
              ? Text(context.t('mob.home.command.empty.body'))
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.home.command.error.title'), style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)),
                    Text(context.t('mob.home.command.error.body', <String, Object>{'code': code})),
                    const SizedBox(height: MachvonSpace.space8),
                    OutlinedButton(onPressed: onRetry, child: Text(context.t('mob.alert.list.retry.action'))),
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
    final String label = metricLabel(context, tile.metricCode);
    final String value = _valueOf(context, tile);
    final String? sums = tile.hasSums
        ? '${context.t('mob.home.tile.numerator', <String, Object>{'value': millionsLabel(context, tile.numerator)})} · '
            '${context.t('mob.home.tile.denominator', <String, Object>{'value': millionsLabel(context, tile.denominator)})}'
        : null;
    final String definition = tile.isSigned
        ? context.t('mob.home.tile.definition.signed')
        : context.t('mob.home.tile.definition.pending', <String, Object>{'ref': formulaReference});
    final List<String> flags = _flagTexts(context, tile);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: MachvonColors.border),
        borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space12),
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
                        Text(label, style: theme.textTheme.bodySmall),
                        Text(value, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                        if (sums != null) Text(sums, style: theme.textTheme.bodySmall),
                        Text(context.t('mob.home.tile.formula', <String, Object>{'formula': tile.formula}), style: theme.textTheme.bodySmall),
                        Text(definition, style: theme.textTheme.bodySmall),
                      ],
                    ),
                  ),
                ),
                if (tile.info != null) FigureInfoButton(info: tile.info!),
              ],
            ),
            if (flags.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space4),
                child: Wrap(spacing: MachvonSpace.space8, runSpacing: MachvonSpace.space4, children: <Widget>[for (final String flag in flags) StatusPill(label: flag, warn: true)]),
              ),
          ],
        ),
      ),
    );
  }

  String _valueOf(BuildContext context, Tile tile) {
    final String? value = tile.value;
    if (value == null) return _nullReasonText(context, tile.nullReason);
    if (tile.unit == TileUnit.percent) {
      return context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(tile.displayValue ?? value, AppStrings.of(context).language)});
    }
    return millionsLabel(context, value);
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

/// One count that waits for someone, with the "i" of its definition when the server gave one.
class _CountLine extends StatelessWidget {
  const _CountLine({required this.text, required this.figure});

  final String text;
  final CountFigure? figure;

  @override
  Widget build(BuildContext context) {
    final FigureInfo? info = figure?.info;
    return Row(
      children: <Widget>[
        Expanded(child: Text(text)),
        if (info != null) FigureInfoButton(info: info),
      ],
    );
  }
}
