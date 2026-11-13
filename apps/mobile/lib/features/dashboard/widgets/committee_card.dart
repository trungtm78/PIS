import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/figure_info.dart';
import '../../../core/widgets/skeleton.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../committee_workspace.dart';

/// The committee workspace on the home of a leader (BAN-1): the card of the head of the steering committee. It reads `getCommitteeWorkspace` on its own, so a
/// failure of it never takes the figures of the home down, and the server writes one row of the audit of views for every read: the card reads once when it
/// opens and once more for each press of its refresh button, never on a timer and never on resume. A reader the server refuses (not on the committee) does not
/// see the card at all. Every figure has its "i" (formula, source, day, owner, version), a figure without a value says so and is never shown as zero, and a
/// colour is always said in words with a shape.
class CommitteeCard extends ConsumerStatefulWidget {
  const CommitteeCard({super.key});

  @override
  ConsumerState<CommitteeCard> createState() => _CommitteeCardState();
}

enum _Phase { loading, ready, failed }

class _CommitteeCardState extends ConsumerState<CommitteeCard> with AutomaticKeepAliveClientMixin {
  _Phase _phase = _Phase.loading;
  CommitteeWorkspace? _workspace;
  String _errorCode = 'UNKNOWN';
  int _generation = 0;

  /// The list of the home builds its parts lazily; a card scrolled out of sight keeps what it read, so scrolling back never asks the server again.
  @override
  bool get wantKeepAlive => true;

  String? _who() {
    final SessionSnapshot session = ref.read(sessionProvider);
    final String? tenant = session.tenantId;
    final String? user = session.userId;
    if (!session.isSignedIn || tenant == null || user == null) return null;
    return '$tenant/$user';
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final String? who = _who();
    if (who == null || ref.read(committeeRefusalsProvider).contains(who)) return;
    final int generation = ++_generation;
    setState(() => _phase = _Phase.loading);
    try {
      final Object? raw = await readCommitteeWorkspace(ref.read(apiClientProvider));
      final CommitteeWorkspace? workspace = parseCommitteeWorkspace(raw);
      if (generation != _generation || !mounted) return;
      if (workspace == null) {
        setState(() {
          _phase = _Phase.failed;
          _errorCode = 'CONTRACT_MISMATCH';
        });
        return;
      }
      setState(() {
        _workspace = workspace;
        _phase = _Phase.ready;
      });
    } on ApiError catch (error) {
      if (generation != _generation || !mounted) return;
      if (isCommitteeRefusal(error)) {
        ref.read(committeeRefusalsProvider.notifier).remember(who);
        return;
      }
      setState(() {
        _phase = _Phase.failed;
        _errorCode = error.code;
      });
    } on Object {
      if (generation != _generation || !mounted) return;
      setState(() {
        _phase = _Phase.failed;
        _errorCode = 'UNKNOWN';
      });
    }
  }

  void _sessionChanged(SessionSnapshot? previous, SessionSnapshot next) {
    if (previous?.tenantId == next.tenantId && previous?.userId == next.userId && previous?.status == next.status) return;
    _workspace = null;
    _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    ref.listen<SessionSnapshot>(sessionProvider, _sessionChanged);
    final String? who = _who();
    if (who == null || ref.watch(committeeRefusalsProvider).contains(who)) return const SizedBox.shrink();
    final CommitteeWorkspace? workspace = _workspace;
    return SectionCard(
      title: context.t('mob.home.committee.title.text'),
      children: <Widget>[
        Semantics(
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            key: const ValueKey<String>('committee-card'),
            children: <Widget>[
              if (_phase == _Phase.loading && workspace == null) const _Loading(),
              if (_phase == _Phase.failed) _Failed(code: _errorCode, onRetry: _load),
              if (workspace != null && _phase != _Phase.failed) ...<Widget>[
                _Refresh(busy: _phase == _Phase.loading, onRefresh: _load),
                if (workspace.feedEmpty) const _EmptyFeed() else _Body(workspace: workspace),
                if (!workspace.feedEmpty) const _OpenDashboard(),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// The way in to the full dashboard (MOB-72): by sector, district, investor and funding source, the whole attention list, the directives and the alerts.
class _OpenDashboard extends StatelessWidget {
  const _OpenDashboard();

  @override
  Widget build(BuildContext context) {
    return TappableRow(
      semanticLabel: context.t('mob.home.committee.open.action'),
      onTap: () => openScreen(context, 'MOB-72', stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(child: Text(context.t('mob.home.committee.open.action'), style: context.v2text.body.copyWith(color: context.v2.palette.primaryStrong))),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: context.t('mob.home.committee.loading.label'),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[SkeletonBar(height: MachvonSpace.space16), SizedBox(height: MachvonSpace.space8), SkeletonBar(height: MachvonSpace.space16), SizedBox(height: MachvonSpace.space8), SkeletonBar(height: MachvonSpace.space16)],
      ),
    );
  }
}

class _Failed extends StatelessWidget {
  const _Failed({required this.code, required this.onRetry});

  final String code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(context.t('mob.home.committee.error.text', <String, Object>{'code': code})),
          const SizedBox(height: MachvonSpace.space8),
          OutlinedButton(onPressed: onRetry, child: Text(context.t('mob.home.committee.retry.action'))),
        ],
      ),
    );
  }
}

/// The explicit refresh: one press is one read (and one row of the audit of views).
class _Refresh extends StatelessWidget {
  const _Refresh({required this.busy, required this.onRefresh});

  final bool busy;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final String label = context.t('mob.home.committee.refresh.action');
    return Align(
      alignment: Alignment.centerRight,
      child: Semantics(
        liveRegion: busy,
        label: busy ? context.t('mob.home.committee.loading.label') : null,
        child: IconButton(
          tooltip: label,
          constraints: const BoxConstraints(minWidth: MachvonTouch.androidDp, minHeight: MachvonTouch.androidDp),
          icon: const Icon(Icons.refresh),
          onPressed: busy ? null : onRefresh,
        ),
      ),
    );
  }
}

class _EmptyFeed extends StatelessWidget {
  const _EmptyFeed();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Text(context.t('mob.home.committee.empty.text')),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.workspace});

  final CommitteeWorkspace workspace;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final CommitteeProvince province = workspace.province;
    final CommitteeFigure? gap = workspace.figure(committeeGapMetric);
    // A colour is only said when the figure it comes from is given: a gap held back as not certified has no colour either.
    final CommitteeRag rag = gap != null && gap.hasValue ? province.rag : CommitteeRag.noData;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.home.committee.asOf.text', <String, Object>{'day': asOfLabel(workspace.asOf), 'year': workspace.fiscalYear}), style: theme.textTheme.bodySmall),
        if (workspace.isStale)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space4),
            child: Semantics(liveRegion: true, child: Wrap(children: <Widget>[StatusPill(label: context.t('mob.home.committee.stale.text'), warn: true)])),
          ),
        const SizedBox(height: MachvonSpace.space8),
        CommitteeRagLine(rag: rag),
        CommitteeFigureRow(figure: workspace.figure(committeeRateMetric), label: context.t('mob.home.committee.label.rate'), headline: true),
        CommitteeFigureRow(figure: gap, label: context.t('mob.home.committee.label.gap'), signed: true),
        FactLine(label: context.t('mob.home.committee.label.expected'), value: context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(province.expectedPct, AppStrings.of(context).language)})),
        CommitteeFigureRow(figure: workspace.figure(committeePlanMetric), label: context.t('mob.home.committee.label.plan')),
        CommitteeFigureRow(figure: workspace.figure(committeeDisbursedMetric), label: context.t('mob.home.committee.label.disbursed')),
        CommitteeLastYearRow(workspace: workspace),
        CommitteeOutlookRow(workspace: workspace),
        const Divider(),
        CommitteeFigureRow(figure: workspace.figure(committeeAttentionMetric), label: context.t('mob.home.committee.label.attention')),
        CommitteeFigureRow(figure: workspace.figure(committeeUnitsMetric), label: context.t('mob.home.committee.label.units')),
        CommitteeFigureRow(figure: workspace.figure(committeeDirectivesMetric), label: context.t('mob.home.committee.label.directives')),
        const Divider(),
        _AttentionList(workspace: workspace),
        const Divider(),
        _AlertList(alerts: workspace.alerts),
      ],
    );
  }
}

/// The colour of the province in words and with a shape, never by colour alone.
class CommitteeRagLine extends StatelessWidget {
  const CommitteeRagLine({required this.rag});

  final CommitteeRag rag;

  @override
  Widget build(BuildContext context) {
    final (MachvonTone, IconData, String) look = switch (rag) {
      CommitteeRag.red => (MachvonTone.danger, Icons.report_outlined, context.t('mob.home.committee.rag.red')),
      CommitteeRag.amber => (MachvonTone.warning, Icons.warning_amber_rounded, context.t('mob.home.committee.rag.amber')),
      CommitteeRag.green => (MachvonTone.success, Icons.check_circle_outline, context.t('mob.home.committee.rag.green')),
      CommitteeRag.noData => (MachvonTone.neutral, Icons.help_outline, context.t('mob.home.committee.rag.noData')),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
      child: Align(alignment: Alignment.centerLeft, child: StatusPill(label: look.$3, tone: look.$1, icon: look.$2)),
    );
  }
}

/// The text a figure is shown with: its digits as the server wrote them, or why it has none (never zero).
String committeeFigureText(BuildContext context, CommitteeFigure? figure, {bool signed = false}) {
  if (figure == null || figure.value == null) return _noValueText(context, figure?.nullReason);
  final String language = AppStrings.of(context).language;
  switch (figure.unit) {
    case CommitteeFigureUnit.percent:
      final String raw = figure.displayValue ?? figure.value!;
      final String digits = formatPercent(raw, language);
      return signed
          ? context.t('mob.home.committee.value.points', <String, Object>{'points': _withSign(digits, raw)})
          : context.t('mob.home.tile.value.percent', <String, Object>{'value': digits});
    case CommitteeFigureUnit.vnd:
      return moneyLabel(context, figure.value);
    case CommitteeFigureUnit.count:
      return figure.displayValue ?? figure.value!;
  }
}

/// A difference in points carries its sign: a rise is written with a plus, a fall with the minus the server wrote.
String _withSign(String digits, String raw) {
  if (raw.startsWith('-') || raw.startsWith('+')) return digits;
  final double? number = double.tryParse(raw);
  return number != null && number > 0 ? '+$digits' : digits;
}

String _noValueText(BuildContext context, String? reason) {
  switch (reason) {
    case 'NOT_CERTIFIED':
      return context.t('mob.home.committee.value.notCertified');
    case 'OBSOLETE':
      return context.t('mob.home.committee.value.obsolete');
    default:
      return context.t('mob.home.committee.value.none');
  }
}

/// One figure: its name, its value (or why it has none), the flags the server set and the "i" of its definition.
class CommitteeFigureRow extends StatelessWidget {
  const CommitteeFigureRow({required this.figure, required this.label, this.headline = false, this.signed = false});

  final CommitteeFigure? figure;
  final String label;
  final bool headline;
  final bool signed;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final FigureInfo? info = figure?.info;
    final List<String> flags = _flagWords(context, figure);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: theme.textTheme.bodySmall),
                  Text(committeeFigureText(context, figure, signed: signed), style: (headline ? theme.textTheme.headlineSmall : theme.textTheme.titleMedium)?.copyWith(fontWeight: FontWeight.w700)),
                  for (final String flag in flags) Text(flag, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
          if (info != null) FigureInfoButton(info: info),
        ],
      ),
    );
  }
}

List<String> _flagWords(BuildContext context, CommitteeFigure? figure) {
  final List<String> words = <String>[];
  for (final String flag in figure?.flags ?? const <String>[]) {
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

/// The same period of last year; when only some funding lines have a figure of last year, it says how many.
class CommitteeLastYearRow extends StatelessWidget {
  const CommitteeLastYearRow({required this.workspace});

  final CommitteeWorkspace workspace;

  @override
  Widget build(BuildContext context) {
    final CommitteeFigure? figure = workspace.figure(committeeLastYearMetric);
    final CommitteeProvince province = workspace.province;
    final bool partial = (figure == null || !figure.hasValue) && province.lastYearKnown > 0 && province.lastYearKnown < province.lastYearTotal;
    if (!partial) return CommitteeFigureRow(figure: figure, label: context.t('mob.home.committee.label.lastYear'));
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.home.committee.label.lastYear'), style: theme.textTheme.bodySmall),
                  Text(context.t('mob.home.committee.lastYear.partial', <String, Object>{'known': province.lastYearKnown, 'total': province.lastYearTotal}), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                ],
              ),
            ),
          ),
          if (figure?.info != null) FigureInfoButton(info: figure!.info!),
        ],
      ),
    );
  }
}

/// The band the year is expected to close in: the lowest to the highest estimate, each end with its own "i", or why there is none.
class CommitteeOutlookRow extends StatelessWidget {
  const CommitteeOutlookRow({required this.workspace});

  final CommitteeWorkspace workspace;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String language = AppStrings.of(context).language;
    final CommitteeFigure? low = workspace.figure(committeeOutlookLowMetric);
    final CommitteeFigure? high = workspace.figure(committeeOutlookHighMetric);
    final CommitteeOutlook outlook = workspace.province.outlook;
    final String band;
    if (low != null && high != null && low.hasValue && high.hasValue) {
      final String range = context.t('mob.home.committee.outlook.range', <String, Object>{'low': moneyLabel(context, low.value), 'high': moneyLabel(context, high.value)});
      final String? lowPct = outlook.lowPct;
      final String? highPct = outlook.highPct;
      band = lowPct != null && highPct != null
          ? '$range ${context.t('mob.home.committee.outlook.percent', <String, Object>{'low': '${formatPercent(lowPct, language)}%', 'high': '${formatPercent(highPct, language)}%'})}'
          : range;
    } else if (low?.nullReason == 'NOT_CERTIFIED' || high?.nullReason == 'NOT_CERTIFIED') {
      band = context.t('mob.home.committee.value.notCertified');
    } else if (low?.nullReason == 'OBSOLETE' || high?.nullReason == 'OBSOLETE') {
      band = context.t('mob.home.committee.value.obsolete');
    } else {
      band = outlook.reason == 'NO_PLAN' ? context.t('mob.home.committee.outlook.noPlan') : context.t('mob.home.committee.outlook.noData');
    }
    final bool thin = low != null && high != null && low.hasValue && high.hasValue && outlook.thin;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.home.committee.label.outlook'), style: theme.textTheme.bodySmall),
                  Text(band, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  if (thin) Text(context.t('mob.home.committee.outlook.thin'), style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
          if (low?.info != null) FigureInfoButton(info: low!.info!),
          if (high?.info != null) FigureInfoButton(info: high!.info!),
        ],
      ),
    );
  }
}

String committeeReasonWord(BuildContext context, CommitteeReason reason) {
  switch (reason) {
    case CommitteeReason.delayed:
      return context.t('mob.home.committee.reason.delayed');
    case CommitteeReason.stalled:
      return context.t('mob.home.committee.reason.stalled');
    case CommitteeReason.overBudget:
      return context.t('mob.home.committee.reason.overBudget');
    case CommitteeReason.farBelow:
      return context.t('mob.home.committee.reason.farBelow');
    case CommitteeReason.notReporting:
      return context.t('mob.home.committee.reason.notReporting');
  }
}

/// The three projects that need the head's attention most: code, name and the reasons as words.
class _AttentionList extends StatelessWidget {
  const _AttentionList({required this.workspace});

  final CommitteeWorkspace workspace;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<CommitteeAttention> items = workspace.attention;
    final int more = workspace.attentionTotal - items.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(container: true, header: true, child: Text(context.t('mob.home.committee.attention.title'), style: theme.textTheme.titleSmall)),
        const SizedBox(height: MachvonSpace.space4),
        if (items.isEmpty)
          Text(context.t('mob.home.committee.attention.none'))
        else
          for (final CommitteeAttention item in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.home.committee.attention.item', <String, Object>{'code': item.code, 'name': item.name}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                    if (item.reasons.isNotEmpty)
                      Text(
                        context.t('mob.home.committee.attention.reasons', <String, Object>{'reasons': <String>[for (final CommitteeReason reason in item.reasons) committeeReasonWord(context, reason)].join(', ')}),
                        style: theme.textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
            ),
        if (more > 0) Text(context.t('mob.home.committee.attention.more', <String, Object>{'count': more}), style: theme.textTheme.bodySmall),
      ],
    );
  }
}

String committeeAlertTypeWord(BuildContext context, CommitteeAlertType type) {
  switch (type) {
    case CommitteeAlertType.provinceBehind:
      return context.t('mob.home.committee.alert.provinceBehind');
    case CommitteeAlertType.sectorBehind:
      return context.t('mob.home.committee.alert.sectorBehind');
    case CommitteeAlertType.unitNotReporting:
      return context.t('mob.home.committee.alert.unitNotReporting');
    case CommitteeAlertType.directiveOverdue:
      return context.t('mob.home.committee.alert.directiveOverdue');
  }
}

/// The live alerts of the committee: what they are about, and how severe in a word and a shape.
class _AlertList extends StatelessWidget {
  const _AlertList({required this.alerts});

  final List<CommitteeAlert> alerts;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<CommitteeAlert> shown = alerts.take(committeeAlertsShown).toList();
    final int more = alerts.length - shown.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(container: true, header: true, child: Text(context.t('mob.home.committee.alerts.title'), style: theme.textTheme.titleSmall)),
        const SizedBox(height: MachvonSpace.space4),
        if (shown.isEmpty)
          Text(context.t('mob.home.committee.alerts.none'))
        else
          for (final CommitteeAlert alert in shown)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
              child: MergeSemantics(
                child: Wrap(
                  spacing: MachvonSpace.space8,
                  runSpacing: MachvonSpace.space4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    CommitteeSeverityPill(severity: alert.severity),
                    Text(alert.subjectLabel == null ? committeeAlertTypeWord(context, alert.type) : context.t('mob.home.committee.alert.subject', <String, Object>{'type': committeeAlertTypeWord(context, alert.type), 'subject': alert.subjectLabel!}), style: theme.textTheme.bodyMedium),
                  ],
                ),
              ),
            ),
        if (more > 0) Text(context.t('mob.home.committee.alerts.more', <String, Object>{'count': more}), style: theme.textTheme.bodySmall),
      ],
    );
  }
}

class CommitteeSeverityPill extends StatelessWidget {
  const CommitteeSeverityPill({required this.severity});

  final CommitteeSeverity severity;

  @override
  Widget build(BuildContext context) {
    switch (severity) {
      case CommitteeSeverity.urgent:
        return StatusPill(label: context.t('mob.home.committee.severity.urgent'), tone: MachvonTone.danger, icon: Icons.error_outline);
      case CommitteeSeverity.action:
        return StatusPill(label: context.t('mob.home.committee.severity.action'), tone: MachvonTone.warning, icon: Icons.warning_amber_rounded);
      case CommitteeSeverity.watch:
        return StatusPill(label: context.t('mob.home.committee.severity.watch'), tone: MachvonTone.info, icon: Icons.visibility_outlined);
    }
  }
}
