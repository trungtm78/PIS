import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/di/providers.dart';
import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/offline/drafts/decimal.dart';
import '../../core/session/session.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/kpi_tile.dart';
import '../../core/widgets/section_panel.dart';
import '../read_support/clock.dart';
import '../read_support/data_view.dart' show defaultCacheTtl;
import '../read_support/read_cache.dart';
import 'bi_query_service.dart';
import 'charts.dart';
import 'dashboard_models.dart';
import 'personal_bi_labels.dart';
import 'query_models.dart';

/// How many groups a tile lists before the person asks for the rest.
const int tileRowsShown = 8;

enum _Phase { loading, ready, failed }

/// One step down from a cell: the cell that was tapped, the answer it came from, and what the drill found.
final class _Step {
  const _Step({required this.cell, required this.from, required this.result, required this.dimension});

  final Group cell;
  final QueryResult from;
  final QueryResult result;
  final String dimension;
}

/// One tile of a dashboard: the metric over the snapshot the dashboard is read from, with what every number of BI carries (the
/// period, the snapshot, the quality of the data, whether it came from the cache, whose scope it is), and a way down from each
/// group to the figures behind it. Each tile reads for itself, so the first content is on the screen as soon as the first answer is
/// there and a slow tile never holds up the others. When the server cannot be reached the last answer is shown as a copy kept on
/// this device, with the period it describes, and nothing can be drilled.
class TileCard extends ConsumerStatefulWidget {
  const TileCard({required this.dashboardId, required this.tile, required this.snapshotId, required this.onResult, required this.onRenew, super.key});

  final String dashboardId;
  final DashboardWidget tile;
  final String snapshotId;

  /// Told each answer the server gave (not a copy): the dashboard shows one banner when any of them says newer data exists.
  final void Function(String widgetId, QueryResult result) onResult;

  /// Asked to renew the analysis on the newest snapshot, with a token of this tile.
  final Future<void> Function(String drillToken) onRenew;

  @override
  ConsumerState<TileCard> createState() => _TileCardState();
}

class _TileCardState extends ConsumerState<TileCard> {
  _Phase _phase = _Phase.loading;
  QueryResult? _base;
  bool _fromCopy = false;
  bool _stale = false;
  Object? _failure;
  final List<_Step> _steps = <_Step>[];
  Group? _choosing;
  bool _explaining = false;
  Object? _drillFailure;
  bool _all = false;

  /// Bumped by every read of the tile: an answer that comes back for an earlier read (another query, another snapshot) is dropped.
  int _read = 0;

  /// Bumped by every drill and by a step back: the answer of a drill whose level the person has left (or that was replaced) is dropped,
  /// so it is never added under a path it does not belong to.
  int _drill = 0;

  /// The copy kept for offline reading belongs to the query it answered (the metric and the cut), not to the place of the tile: a
  /// tile whose definition changed must never show the saved figures of the old one.
  String get _cacheKey => _cacheKeyOf(widget);

  static String _cacheKeyOf(TileCard card) => 'pbi.tile.${card.dashboardId}.${card.tile.id}.${card.snapshotId}.${card.tile.metricVersionId}.${_askedOf(card.tile) ?? '-'}';

  /// A single figure (or a tile without a dimension) asks for the total only.
  static String? _askedOf(DashboardWidget tile) => tile.kind == WidgetKind.kpi ? null : tile.dimension;

  String? get _asked => _askedOf(widget.tile);

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(TileCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A refreshed dashboard may keep the id and the snapshot of a tile and change what it asks: the figures on the screen are then
    // the answer to another question, so the tile is read again (and anything the person drilled into is left).
    if (_cacheKeyOf(oldWidget) != _cacheKey) _load();
  }

  CacheScope? _scope() {
    final SessionSnapshot session = ref.read(sessionProvider);
    final String? tenant = session.tenantId;
    final String? user = session.userId;
    if (!session.isSignedIn || tenant == null || user == null) return null;
    return CacheScope(tenantId: tenant, userId: user);
  }

  BiQueryService _service() => BiQueryService(client: ref.read(apiClientProvider), polling: ref.read(jobPollingProvider), cancelled: () => !mounted);

  Future<void> _load() async {
    final int read = ++_read;
    setState(() {
      _phase = _Phase.loading;
      _failure = null;
      _steps.clear();
      _choosing = null;
    });
    final CacheScope? scope = _scope();
    final ReadCache cache = ref.read(readCacheProvider);
    final DateTime now = ref.read(clockProvider)();
    try {
      final RawQuery answer = await _service().run(metricVersionId: widget.tile.metricVersionId, snapshotId: widget.snapshotId, dimension: _asked);
      if (!mounted || read != _read) return;
      if (scope != null) await _remember(cache, scope, CacheEntry(raw: answer.raw, asOf: answer.result.asOfPeriod, fetchedAt: now));
      if (!mounted || read != _read) return;
      setState(() {
        _base = answer.result;
        _fromCopy = false;
        _phase = _Phase.ready;
      });
      widget.onResult(widget.tile.id, answer.result);
    } on QueryCancelled {
      return;
    } on Object catch (error) {
      if (!mounted || read != _read) return;
      if (error is ApiError && error.code == networkErrorCode && scope != null) {
        final CacheEntry? entry = await cache.read(scope, _cacheKey);
        final QueryResult? copy = entry == null ? null : parseQueryResult(entry.raw);
        if (!mounted || read != _read) return;
        if (entry != null && copy != null) {
          setState(() {
            _base = copy;
            _fromCopy = true;
            _stale = now.difference(entry.fetchedAt) > defaultCacheTtl;
            _phase = _Phase.ready;
          });
          return;
        }
      } else if (scope != null && error is ApiError && (error.status == 401 || error.status == 403)) {
        // What the server refused is not kept: a taken-away right leaves nothing on the device.
        await cache.forget(scope, _cacheKey);
      }
      if (!mounted || read != _read) return;
      setState(() {
        _failure = error;
        _phase = _Phase.failed;
      });
    }
  }

  /// A copy that cannot be stored costs only the offline copy: the answer on the screen is still true.
  Future<void> _remember(ReadCache cache, CacheScope scope, CacheEntry entry) async {
    try {
      await cache.write(scope, _cacheKey, entry);
    } on Object {
      return;
    }
  }

  Future<void> _explain(Group cell, QueryResult from, String dimension) async {
    final int read = _read;
    final int drill = ++_drill;
    setState(() {
      _explaining = true;
      _drillFailure = null;
    });
    try {
      final RawQuery answer = await _service().explain(drillToken: cell.drillToken!, dimension: dimension);
      if (!mounted || read != _read || drill != _drill) return;
      setState(() {
        _steps.add(_Step(cell: cell, from: from, result: answer.result, dimension: dimension));
        _choosing = null;
        _explaining = false;
        _all = false;
      });
    } on Object catch (error) {
      if (!mounted || read != _read || drill != _drill) return;
      setState(() {
        _drillFailure = error;
        _explaining = false;
      });
    }
  }

  /// One step up. A drill that is on its way started from the level that is being left, and the chooser that is open belongs to it: both end.
  void _back() {
    setState(() {
      _drill += 1;
      _steps.removeLast();
      _choosing = null;
      _explaining = false;
      _drillFailure = null;
      _all = false;
    });
  }

  Set<String> _pathDimensions() => <String>{
        ?_base?.dimension,
        for (final _Step step in _steps) step.dimension,
      };

  @override
  Widget build(BuildContext context) {
    final String title = widget.tile.title ?? _base?.metricCode ?? '';
    final List<Widget> content = _content(context);
    // A tile is a titled block of the dashboard: its heading and a hairline, not a card. Without a title it is the content alone.
    if (title.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: content),
      );
    }
    return SectionPanel(title: title, children: content);
  }

  List<Widget> _content(BuildContext context) {
    switch (_phase) {
      case _Phase.loading:
        return <Widget>[
          // A bar that does not move: a tile that waits is a skeleton, and a screen that never stops animating cannot rest.
          ExcludeSemantics(child: SizedBox(height: 3, child: ColoredBox(color: context.v2.palette.sunken))),
          Semantics(liveRegion: true, child: Text(context.t('mob.pbi.tile.loading.label'), style: context.v2text.body)),
        ];
      case _Phase.failed:
        final Object failure = _failure!;
        final bool offline = failure is ApiError && failure.code == networkErrorCode;
        return <Widget>[
          Semantics(
            liveRegion: true,
            container: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(offline ? context.t('mob.pbi.tile.offline.label') : queryProblemText(context, problemOfFailure(failure)), style: context.v2text.body),
                if (problemCodeOf(failure) != null) Text(problemCodeOf(failure)!, style: context.v2text.caption),
              ],
            ),
          ),
          Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: _load, child: Text(context.t('mob.pbi.tile.retry.action')))),
        ];
      case _Phase.ready:
        return _ready(context);
    }
  }

  List<Widget> _ready(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final QueryResult base = _base!;
    final QueryResult current = _steps.isEmpty ? base : _steps.last.result;
    final String unit = current.shownUnit;
    final bool ratio = current.isRatio;
    final List<Group> shown = _all ? current.children : current.children.take(tileRowsShown).toList();
    final List<double> values = chartValues(current.children);
    final double widest = widestOf(values);
    final bool bars = widget.tile.kind == WidgetKind.bar || widget.tile.kind == WidgetKind.pie;
    final bool line = (widget.tile.kind == WidgetKind.line || widget.tile.kind == WidgetKind.area) && _steps.isEmpty;
    return <Widget>[
      if (_fromCopy) _CopyNote(result: base, stale: _stale),
      if (_steps.isNotEmpty) _Breadcrumb(base: base, steps: _steps, onBack: _back),
      if (_steps.isNotEmpty) _CheckLine(step: _steps.last),
      KpiTile(key: const ValueKey<String>('total'), label: context.t('mob.pbi.tile.total.label'), value: figureLabel(context, current.total, unit)),
      if (ratio && current.total.numerator != null && current.total.denominator != null)
        Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.pbi.tile.ratio.parts', <String, Object>{'numerator': _number(context, current.total.numerator!), 'denominator': _number(context, current.total.denominator!)}), style: text.caption)),
      if (line) LineSketch(values: values, area: widget.tile.kind == WidgetKind.area),
      if (current.children.isNotEmpty && widget.tile.kind != WidgetKind.kpi) ...<Widget>[
        const SizedBox(height: MachvonV2Space.s12),
        if (current.dimension != null) Semantics(container: true, header: true, child: Text(dimensionLabel(context, current.dimension!), style: text.label)),
        for (final Group group in shown) _GroupRow(group: group, unit: unit, fraction: bars ? fractionOf(double.tryParse(group.figure.value ?? '') ?? 0, widest) : null, negative: (double.tryParse(group.figure.value ?? '') ?? 0) < 0, onDrill: _fromCopy || group.drillToken == null || _explaining ? null : () => setState(() => _choosing = group)),
        if (current.children.length > tileRowsShown)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              onPressed: () => setState(() => _all = !_all),
              child: Text(_all ? context.t('mob.pbi.tile.rowsLess.action') : context.t('mob.pbi.tile.rowsAll.action', <String, Object>{'count': current.children.length})),
            ),
          ),
      ],
      if (_choosing != null) _DimensionChooser(group: _choosing!, taken: _pathDimensions(), busy: _explaining, onPick: (String dimension) => _explain(_choosing!, current, dimension), onCancel: () => setState(() => _choosing = null)),
      if (_drillFailure != null) _DrillFailure(failure: _drillFailure!, onRenew: () => widget.onRenew(base.drillToken)),
      const SizedBox(height: MachvonV2Space.s8),
      _Meta(result: current),
    ];
  }
}

String _number(BuildContext context, String value) {
  final Decimal? parsed = Decimal.tryParse(value);
  if (parsed == null) return value;
  final bool english = AppStrings.of(context).language == 'en';
  return parsed.format(separator: english ? ',' : '.', decimalMark: english ? '.' : ',');
}

/// A copy kept on this device: it says so, says the period it describes, and that the figures are reference data.
class _CopyNote extends StatelessWidget {
  const _CopyNote({required this.result, required this.stale});

  final QueryResult result;
  final bool stale;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.pbi.copy.line', <String, Object>{'period': result.asOfPeriod, 'time': formatMoment(result.builtAt)}), style: context.v2text.caption),
            Text(context.t('mob.read.saved.readOnly'), style: context.v2text.caption),
            if (stale) Text(context.t('mob.read.stale.line', <String, Object>{'hours': defaultCacheTtl.inHours}), style: context.v2text.caption),
          ],
        ),
      ),
    );
  }
}

class _GroupRow extends StatelessWidget {
  const _GroupRow({required this.group, required this.unit, required this.fraction, required this.negative, required this.onDrill});

  final Group group;
  final String unit;
  final double? fraction;
  final bool negative;
  final VoidCallback? onDrill;

  @override
  Widget build(BuildContext context) {
    final String label = group.unclassified ? context.t('mob.pbi.group.unclassified') : group.label;
    final String value = figureLabel(context, group.figure, unit);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: MergeSemantics(
                  child: Wrap(
                    spacing: MachvonV2Space.s8,
                    children: <Widget>[Text(label, style: context.v2text.body), Text(value, key: ValueKey<String>('value-${group.key ?? 'unclassified'}'), style: context.v2text.bodyStrong)],
                  ),
                ),
              ),
              if (onDrill != null) TextButton(onPressed: onDrill, child: Semantics(label: context.t('mob.pbi.drill.aria', <String, Object>{'label': label}), excludeSemantics: true, child: Text(context.t('mob.pbi.drill.action')))),
            ],
          ),
          if (fraction != null && group.figure.value != null) ProportionBar(fraction: fraction!, negative: negative),
        ],
      ),
    );
  }
}

class _Breadcrumb extends StatelessWidget {
  const _Breadcrumb({required this.base, required this.steps, required this.onBack});

  final QueryResult base;
  final List<_Step> steps;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final String path = <String>[
      context.t('mob.pbi.tile.total.label'),
      for (final _Step step in steps) '${step.cell.unclassified ? context.t('mob.pbi.group.unclassified') : step.cell.label} (${dimensionLabel(context, step.dimension)})',
    ].join(' › ');
    return Row(
      children: <Widget>[
        Expanded(child: Text(path, style: context.v2text.caption)),
        TextButton(onPressed: onBack, child: Text(context.t('mob.pbi.drill.back.action'))),
      ],
    );
  }
}

/// What the drill found against the cell it started from: the total is the value of the cell, from the same snapshot. A difference is
/// shown, not hidden.
class _CheckLine extends StatelessWidget {
  const _CheckLine({required this.step});

  final _Step step;

  @override
  Widget build(BuildContext context) {
    final DrillCheck check = drillCheck(cell: step.cell, from: step.from, drill: step.result);
    final String unit = step.from.shownUnit;
    final String text = drillCheckText(context, check, cell: figureLabel(context, step.cell.figure, unit), total: figureLabel(context, step.result.total, unit));
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
        child: Text(text, key: ValueKey<String>('check-${check.name}'), style: context.v2text.caption.copyWith(fontWeight: check == DrillCheck.agrees ? FontWeight.w400 : FontWeight.w600)),
      ),
    );
  }
}

class _DimensionChooser extends StatelessWidget {
  const _DimensionChooser({required this.group, required this.taken, required this.busy, required this.onPick, required this.onCancel});

  final Group group;
  final Set<String> taken;
  final bool busy;
  final ValueChanged<String> onPick;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final List<String> free = <String>[for (final String dimension in drillDimensions) if (!taken.contains(dimension)) dimension];
    return Semantics(
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(top: MachvonV2Space.s8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.pbi.drill.choose.label', <String, Object>{'label': group.unclassified ? context.t('mob.pbi.group.unclassified') : group.label}), style: context.v2text.label),
            Wrap(
              spacing: MachvonV2Space.s8,
              children: <Widget>[for (final String dimension in free) ActionChip(label: Text(dimensionLabel(context, dimension)), onPressed: busy ? null : () => onPick(dimension))],
            ),
            if (busy) Semantics(liveRegion: true, child: Text(context.t('mob.pbi.tile.loading.label'), style: context.v2text.body)),
            TextButton(onPressed: busy ? null : onCancel, child: Text(context.t('mob.pbi.drill.cancel.action'))),
          ],
        ),
      ),
    );
  }
}

class _DrillFailure extends StatelessWidget {
  const _DrillFailure({required this.failure, required this.onRenew});

  final Object failure;
  final VoidCallback onRenew;

  @override
  Widget build(BuildContext context) {
    final QueryProblem problem = problemOfFailure(failure);
    final String? code = problemCodeOf(failure);
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(top: MachvonV2Space.s8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(queryProblemText(context, problem), style: context.v2text.body),
            if (code != null) Text(code, style: context.v2text.caption),
            if (problem == QueryProblem.expired || problem == QueryProblem.token) TextButton(onPressed: onRenew, child: Text(context.t('mob.pbi.renew.action'))),
          ],
        ),
      ),
    );
  }
}

/// What every number of BI carries (BR-BI-04): the period, the snapshot, the quality of the data, where it came from, and whose scope
/// it is.
class _Meta extends StatelessWidget {
  const _Meta({required this.result});

  final QueryResult result;

  @override
  Widget build(BuildContext context) {
    final TextStyle small = context.v2text.caption;
    final bool grouped = result.dimension != null && result.children.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(context.t('mob.pbi.meta.period', <String, Object>{'period': result.asOfPeriod, 'snapshot': shortId(result.snapshotId)}), style: small),
        Text('${context.t('mob.pbi.meta.quality')}: ${badgeLabel(context, result.badge)}${result.feedsCertified ? '' : ' ${context.t('mob.pbi.meta.notCertified')}'}', style: small),
        Text(result.servedFromCache ? context.t('mob.pbi.meta.cached', <String, Object>{'time': formatMoment(result.builtAt)}) : context.t('mob.pbi.meta.fresh', <String, Object>{'time': formatMoment(result.builtAt)}), style: small),
        Text(result.yourScope ? context.t('mob.pbi.meta.yourScope') : context.t('mob.pbi.meta.fullTenant'), style: small),
        if (result.excludedQuarantineRows > 0) Text(context.t('mob.pbi.meta.excluded', <String, Object>{'rows': result.excludedQuarantineRows}), style: small),
        if (result.truncated) Text(context.t('mob.pbi.meta.truncated'), style: small),
        if (grouped)
          Text(
            result.reconcilesToParent
                ? context.t('mob.pbi.meta.reconciles')
                : (result.nonAdditiveReason == 'DISTINCT_NOT_ADDITIVE' ? context.t('mob.pbi.meta.notAdditive.distinct') : context.t('mob.pbi.meta.notAdditive.other')),
            style: small,
          ),
      ],
    );
  }
}
