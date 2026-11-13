import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart' show ScreenSpec;
import '../../../core/navigation/route_table.dart' show RouteTable;
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/clock.dart';
import '../../read_support/navigate.dart';
import '../alert_commands.dart';
import '../alerts.dart';
import 'alert_card.dart';
import 'alert_row.dart';
import 'alert_sheets.dart';

/// The time of day of a moment, for "checked at 07:05".
String _timeOf(DateTime moment) {
  final String full = formatMoment(moment.toUtc().toIso8601String());
  return full.substring(full.length - 5);
}

/// Rows in the shape of the alerts where they will be while they load: never a figure, never a 0 (the counts are unknown, not nought).
class AlertListSkeleton extends StatelessWidget {
  const AlertListSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: context.t('mob.alert.list.loading.label'),
      child: const ExcludeSemantics(child: Column(children: <Widget>[WorkRowSkeleton(), WorkRowSkeleton()])),
    );
  }
}

/// The block "Needs action now": the alerts of the person (or of the scope), the most important [limit] of them, each a row with its
/// deadline and one primary action; a tap on the row opens the whole alert in a sheet (the clocks, who holds it, what follows, and the
/// acts of taking it, giving it and reminding later). It draws every state of the data it is given:
///
///  * no feed and no error: the skeleton;
///  * [errorCode] and no feed: the failing source is named, with the stable code and a retry in place;
///  * a feed that names unavailable sources: they are listed, and "nothing to do" is never said while one is missing;
///  * a feed with no alerts: "No urgent work left" with the time of the check;
///  * [stale] says "Stale figures"; [readOnly] (a copy kept on the device) offers no act and says when it was last synced.
///
/// With [groupByDeadline] the rows are ordered by their due day and grouped under the three bands (late, soon, with time) and a group of
/// the alerts that have no due day: the "work of today" of an officer.
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
    this.groupByDeadline = false,
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
  final bool groupByDeadline;

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
    return alertScreenOf(
      item,
      has: (String id) {
        final ScreenSpec? spec = table.implementations[id];
        return table.routeOf(id) != null && spec != null && spec.pathSuffix.isEmpty;
      },
      available: (String id) => table.routeOf(id) != null && table.implementations[id] != null,
    );
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

  /// The whole alert in a sheet: every line of it and its acts. An act closes the sheet first, so what it opens (the record, a sheet to
  /// choose a person or a time) is not laid over it.
  void _openDetail(AlertItem item) {
    showActionSheet<void>(
      context,
      builder: (BuildContext sheet) {
        void closeThen(VoidCallback act) {
          Navigator.of(sheet).pop();
          act();
        }

        return AlertCard(
          key: ValueKey<String>('alert-${item.id}'),
          item: item,
          now: _now(),
          busy: _busy.contains(item.id),
          onOpen: widget.readOnly || _screenOf(item) == null ? null : () => closeThen(() => _open(item)),
          onClaim: widget.readOnly ? null : () => closeThen(() => _claim(item)),
          onAssign: widget.readOnly || !widget.allowAssign ? null : () => closeThen(() => _assign(item)),
          onSnooze: widget.readOnly ? null : () => closeThen(() => _snooze(item)),
        );
      },
    );
  }

  Widget _row(AlertItem item, DateTime now, {required bool first}) {
    final bool canOpen = !widget.readOnly && _screenOf(item) != null;
    final bool canClaim = !widget.readOnly && item.canClaim;
    final String? label = canOpen
        ? context.t('mob.alert.action.open.label')
        : (canClaim ? (item.needsReclaim ? context.t('mob.alert.action.reclaim.label') : context.t('mob.alert.action.claim.label')) : null);
    return AlertRow(
      key: ValueKey<String>('alert-row-${item.id}'),
      item: item,
      now: now,
      busy: _busy.contains(item.id),
      primaryLabel: label,
      onPrimary: canOpen ? () => _open(item) : (canClaim ? () => _claim(item) : null),
      onTap: () => _openDetail(item),
      dividerAbove: !first,
    );
  }

  /// The rows ordered by due day, nearest first and late first, under one heading per band; the alerts without a due day come last.
  List<Widget> _grouped(List<AlertItem> items, DateTime now) {
    final List<(AlertItem, AlertDeadline?)> ordered = <(AlertItem, AlertDeadline?)>[
      for (final AlertItem item in items) (item, alertDeadline(item, now)),
    ]..sort(((AlertItem, AlertDeadline?) a, (AlertItem, AlertDeadline?) b) {
        final AlertDeadline? da = a.$2;
        final AlertDeadline? db = b.$2;
        if (da == null || db == null) return da == db ? compareAlerts(a.$1, b.$1) : (da == null ? 1 : -1);
        final int byDays = da.days.compareTo(db.days);
        return byDays != 0 ? byDays : compareAlerts(a.$1, b.$1);
      });
    final List<Widget> out = <Widget>[];
    for (final DeadlineBand? band in <DeadlineBand?>[DeadlineBand.late, DeadlineBand.soon, DeadlineBand.ok, null]) {
      final List<(AlertItem, AlertDeadline?)> group = <(AlertItem, AlertDeadline?)>[
        for (final (AlertItem, AlertDeadline?) entry in ordered)
          if (entry.$2?.band == band) entry,
      ];
      if (group.isEmpty) continue;
      out.add(GroupHeader(title: band == null ? context.t('mob.alert.group.none.label') : deadlineBandName(context, band), count: group.length));
      for (int index = 0; index < group.length; index += 1) {
        out.add(_row(group[index].$1, now, first: index == 0));
      }
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final AlertFeed? feed = widget.feed;
    final DateTime now = _now();
    final bool counted = feed != null;
    final String checked = _timeOf(widget.fetchedAt ?? now);
    final List<AlertItem> shown = counted ? feed.top(widget.limit) : const <AlertItem>[];
    return Padding(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8),
            child: Row(
              children: <Widget>[
                // A node of its own: the heading flag would otherwise merge the texts of the panel into one heading (UAT 2026-11-13).
                Expanded(child: Semantics(container: true, header: true, child: Text(widget.title ?? context.t('mob.alert.list.title.label'), style: text.heading))),
                if (counted && widget.showSeeAll && !feed.isEmpty)
                  TextButton(onPressed: () => openScreen(context, 'MOB-32', query: const <String, String>{'tab': 'work'}), child: Text(context.t('mob.alert.list.seeAll.action'))),
              ],
            ),
          ),
          if (counted && !feed.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s4, MachvonV2Space.s16, MachvonV2Space.s8),
              child: Semantics(
                container: true,
                child: Text(
                  <String>[
                    for (final AlertSeverity severity in AlertSeverity.values)
                      if (feed.counts.of(severity) > 0) context.t('mob.alert.list.tally.chip', <String, Object>{'label': severityLabel(context, severity), 'count': feed.counts.of(severity)}),
                  ].join(' · '),
                  style: text.caption,
                ),
              ),
            ),
          if (widget.readOnly) _Note(text: context.t('mob.alert.list.offline.note', <String, Object>{'time': formatMoment(widget.fetchedAt?.toUtc().toIso8601String() ?? now.toIso8601String())})),
          if (widget.stale) StatusBanner(tone: BannerTone.warning, icon: Icons.info_outline, text: context.t('mob.alert.list.stale.note')),
          if (widget.scopeRefused) _Note(text: context.t('mob.alert.list.scopeRefused.note')),
          if (counted && feed.unavailableSources.isNotEmpty)
            StatusBanner(
              tone: BannerTone.warning,
              icon: Icons.info_outline,
              text: context.t('mob.alert.list.unavailable.note', <String, Object>{'sources': feed.unavailableSources.map((String s) => alertSourceLabel(context, s)).join(', ')}),
            ),
          if (feed == null && widget.errorCode == null) const AlertListSkeleton(),
          if (feed == null && widget.errorCode != null) _ErrorBlock(code: widget.errorCode!, onRetry: widget.onReload),
          if (counted && feed.isEmpty && feed.unavailableSources.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
              child: MergeSemantics(
                child: Row(
                  children: <Widget>[
                    Icon(Icons.check_circle_outline, color: v2.palette.okFg),
                    const SizedBox(width: MachvonV2Space.s8),
                    Expanded(child: Text(context.t('mob.alert.list.empty.line', <String, Object>{'time': checked}), style: text.body)),
                  ],
                ),
              ),
            ),
          if (counted)
            if (widget.groupByDeadline) ..._grouped(shown, now) else for (int index = 0; index < shown.length; index += 1) _row(shown[index], now, first: index == 0),
          if (counted && feed.items.length > widget.limit || (counted && feed.truncated))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4),
              child: Text(context.t('mob.alert.list.more.note', <String, Object>{'count': feed.counts.total > widget.limit ? feed.counts.total - widget.limit : feed.items.length - widget.limit}), style: text.caption),
            ),
        ],
      ),
    );
  }
}

/// A line of explanation under the heading: why the acts are locked, where the list came from.
class _Note extends StatelessWidget {
  const _Note({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s4),
        child: Text(text, style: context.v2text.caption),
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
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.alert.list.error.title'), style: text.bodyStrong),
            Text(context.t('mob.alert.list.error.body', <String, Object>{'code': code}), style: text.body),
            const SizedBox(height: MachvonV2Space.s8),
            OutlinedButton(onPressed: onRetry, style: v2QuietButtonStyle(v2), child: Text(context.t('mob.alert.list.retry.action'))),
          ],
        ),
      ),
    );
  }
}
