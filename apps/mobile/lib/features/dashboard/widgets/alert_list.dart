import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart' show ScreenSpec;
import '../../../core/navigation/route_table.dart' show RouteTable;
import '../../read_support/clock.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../alert_commands.dart';
import '../alerts.dart';
import 'alert_card.dart';
import 'alert_sheets.dart';

/// The time of day of a moment, for "checked at 07:05".
String _timeOf(DateTime moment) {
  final String full = formatMoment(moment.toUtc().toIso8601String());
  return full.substring(full.length - 5);
}

/// A grey shape where the alerts will be while they load: never a figure, never a 0 (the counts are unknown, not nought).
class AlertListSkeleton extends StatelessWidget {
  const AlertListSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: context.t('mob.alert.list.loading.label'),
      child: ExcludeSemantics(
        child: Column(
          children: <Widget>[
            for (int index = 0; index < 2; index += 1)
              const Card(
                margin: EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space4),
                child: SizedBox(height: 112, width: double.infinity, child: DecoratedBox(decoration: BoxDecoration(color: MachvonColors.neutralSoft, borderRadius: BorderRadius.all(Radius.circular(MachvonRadius.card))))),
              ),
          ],
        ),
      ),
    );
  }
}

/// The block "Needs action now": the alerts of the person (or of the scope), the most important [limit] of them, each with one
/// primary action and a menu for taking it, giving it and reminding later. It draws every state of the data it is given:
///
///  * no feed and no error: the skeleton;
///  * [errorCode] and no feed: the failing source is named, with the stable code and a retry in place;
///  * a feed that names unavailable sources: they are listed, and "nothing to do" is never said while one is missing;
///  * a feed with no alerts: "No urgent work left" with the time of the check;
///  * [stale] says "Stale figures"; [readOnly] (a copy kept on the device) offers no act and says when it was last synced.
class AlertsPanel extends ConsumerStatefulWidget {
  const AlertsPanel({
    required this.feed,
    required this.onReload,
    this.errorCode,
    this.limit = 3,
    this.readOnly = false,
    this.stale = false,
    this.fetchedAt,
    this.scopeRefused = false,
    this.allowAssign = true,
    this.showSeeAll = true,
    this.title,
    super.key,
  });

  final AlertFeed? feed;
  final String? errorCode;
  final VoidCallback onReload;
  final int limit;
  final bool readOnly;
  final bool stale;
  final DateTime? fetchedAt;

  /// The scope was refused and the alerts of the person are shown instead.
  final bool scopeRefused;
  final bool allowAssign;
  final bool showSeeAll;

  /// The heading of the block; "Needs action now" when the screen gives none.
  final String? title;

  @override
  ConsumerState<AlertsPanel> createState() => _AlertsPanelState();
}

class _AlertsPanelState extends ConsumerState<AlertsPanel> {
  late final WorkCommands _commands = WorkCommands(ref.read(apiClientProvider));
  final Set<String> _busy = <String>{};

  DateTime _now() => ref.read(clockProvider)();

  /// The screen of the phone the alert opens, or null when there is none.
  ({String screenId, String pathSuffix})? _screenOf(AlertItem item) {
    final RouteTable table = ref.read(routeTableProvider);
    return alertScreenOf(item, has: (String id) {
      final ScreenSpec? spec = table.implementations[id];
      return table.routeOf(id) != null && spec != null && spec.pathSuffix.isEmpty;
    });
  }

  void _open(AlertItem item) {
    final ({String screenId, String pathSuffix})? screen = _screenOf(item);
    if (screen != null) openScreen(context, screen.screenId, pathSuffix: screen.pathSuffix);
  }

  Future<void> _run(AlertItem item, Future<WorkActionResult> Function() send, String Function(BuildContext) success) async {
    if (_busy.contains(item.id)) return;
    setState(() => _busy.add(item.id));
    final WorkActionResult result = await send();
    if (!mounted) return;
    setState(() => _busy.remove(item.id));
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(result.ok ? success(context) : _failure(context, result))));
    if (result.ok) ref.read(alertsChangedProvider.notifier).bump();
  }

  String _failure(BuildContext context, WorkActionResult result) {
    if (result.outcome == WorkActionOutcome.lost) return context.t('mob.alert.action.error.lost');
    if (result.code == 'URGENT_NOT_SNOOZABLE') return context.t('mob.alert.action.error.urgent');
    return context.t('mob.alert.action.error.refused', <String, Object>{'code': result.code ?? ''});
  }

  Future<void> _claim(AlertItem item) => _run(item, () => _commands.claim(item), (BuildContext c) => item.needsReclaim ? c.t('mob.alert.action.reclaim.done', <String, Object>{'title': item.title}) : c.t('mob.alert.action.claim.done', <String, Object>{'title': item.title}));

  Future<void> _assign(AlertItem item) async {
    final AssignChoice? choice = await showAssignSheet(context, now: _now());
    if (choice == null || !mounted) return;
    await _run(
      item,
      () => _commands.assign(item, assigneeId: choice.assigneeId, dueOn: choice.dueOn, reason: choice.reason),
      (BuildContext c) => c.t('mob.alert.action.assign.done', <String, Object>{'title': item.title, 'date': formatDay(choice.dueOn)}),
    );
  }

  Future<void> _snooze(AlertItem item) async {
    if (_busy.contains(item.id)) return;
    // The sheet sends the snooze itself and stays open on a refusal, saying why; it closes with the choice once it was recorded.
    final SnoozeChoice? done = await showSnoozeSheet(
      context,
      item: item,
      now: _now(),
      send: (SnoozeChoice choice) => _commands.snooze(item, until: choice.until, reasonCode: choice.reasonCode, note: choice.note),
    );
    if (done == null || !mounted) return;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(context.t('mob.alert.action.snooze.done', <String, Object>{'title': item.title, 'time': formatMoment(done.until)}))));
    ref.read(alertsChangedProvider.notifier).bump();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AlertFeed? feed = widget.feed;
    final DateTime now = _now();
    final bool counted = feed != null;
    final String checked = _timeOf(widget.fetchedAt ?? now);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                Semantics(header: true, child: Text(widget.title ?? context.t('mob.alert.list.title.label'), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
                if (counted && widget.showSeeAll && !feed.isEmpty)
                  TextButton(
                    onPressed: () => openScreen(context, 'MOB-32'),
                    child: Text(context.t('mob.alert.list.seeAll.action')),
                  ),
              ],
            ),
          ),
          if (counted && !feed.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, 0, MachvonSpace.space16, MachvonSpace.space4),
              child: Wrap(
                spacing: MachvonSpace.space8,
                runSpacing: MachvonSpace.space4,
                children: <Widget>[
                  for (final AlertSeverity severity in AlertSeverity.values)
                    if (feed.counts.of(severity) > 0) SeverityChip(severity: severity, count: feed.counts.of(severity)),
                ],
              ),
            ),
          if (widget.readOnly) _Note(text: context.t('mob.alert.list.offline.note', <String, Object>{'time': formatMoment(widget.fetchedAt?.toUtc().toIso8601String() ?? now.toIso8601String())}), live: true),
          if (widget.stale) _Note(text: context.t('mob.alert.list.stale.note'), warn: true),
          if (widget.scopeRefused) _Note(text: context.t('mob.alert.list.scopeRefused.note')),
          if (counted && feed.unavailableSources.isNotEmpty)
            _Note(
              text: context.t('mob.alert.list.unavailable.note', <String, Object>{'sources': feed.unavailableSources.map((String s) => alertSourceLabel(context, s)).join(', ')}),
              warn: true,
              live: true,
            ),
          if (feed == null && widget.errorCode == null) const AlertListSkeleton(),
          if (feed == null && widget.errorCode != null) _ErrorBlock(code: widget.errorCode!, onRetry: widget.onReload),
          if (counted && feed.isEmpty && feed.unavailableSources.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
              child: MergeSemantics(
                child: Row(
                  children: <Widget>[
                    const Icon(Icons.check_circle_outline, color: MachvonColors.success),
                    const SizedBox(width: MachvonSpace.space8),
                    Expanded(child: Text(context.t('mob.alert.list.empty.line', <String, Object>{'time': checked}), style: theme.textTheme.bodyMedium)),
                  ],
                ),
              ),
            ),
          if (counted)
            for (final AlertItem item in feed.top(widget.limit))
              AlertCard(
                key: ValueKey<String>('alert-${item.id}'),
                item: item,
                now: now,
                busy: _busy.contains(item.id),
                onOpen: widget.readOnly || _screenOf(item) == null ? null : () => _open(item),
                onClaim: widget.readOnly ? null : () => _claim(item),
                onAssign: widget.readOnly || !widget.allowAssign ? null : () => _assign(item),
                onSnooze: widget.readOnly ? null : () => _snooze(item),
              ),
          if (counted && feed.items.length > widget.limit || (counted && feed.truncated))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space4),
              child: Text(context.t('mob.alert.list.more.note', <String, Object>{'count': feed.counts.total > widget.limit ? feed.counts.total - widget.limit : feed.items.length - widget.limit}), style: theme.textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.text, this.warn = false, this.live = false});

  final String text;
  final bool warn;
  final bool live;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: live,
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space4),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: warn ? MachvonColors.warningSoft : MachvonColors.neutralSoft,
            borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(MachvonSpace.space8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                ExcludeSemantics(child: Icon(warn ? Icons.info_outline : Icons.cloud_off_outlined, size: 18, color: warn ? MachvonColors.warning : MachvonColors.neutral)),
                const SizedBox(width: MachvonSpace.space8),
                Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: MachvonColors.ink))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.code, required this.onRetry});

  final String code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.alert.list.error.title'), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)),
            Text(context.t('mob.alert.list.error.body', <String, Object>{'code': code}), style: theme.textTheme.bodyMedium),
            const SizedBox(height: MachvonSpace.space8),
            OutlinedButton(onPressed: onRetry, child: Text(context.t('mob.alert.list.retry.action'))),
          ],
        ),
      ),
    );
  }
}
