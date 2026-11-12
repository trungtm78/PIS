import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/route_catalogue.dart';
import '../../../core/navigation/tab_badges.dart';
import '../../../core/state/empty_state_view.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart' show AppBarAction;
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/glyph_square.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../../core/widgets/work_row.dart';
import '../../dashboard/alert_badge.dart';
import '../../dashboard/alerts.dart' show AlertCounts;
import '../../dashboard/widgets/alerts_section.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../notification_commands.dart';
import '../notification_labels.dart';
import '../notification_models.dart';
import '../push_registration.dart';

/// The page size of the inbox.
const int inboxPageSize = 50;

/// MOB-32: the notifications of the member, a timeline of events apart from the tasks. Two tabs: "Sự kiện" (the notifications: filters by view
/// (all, unread, waiting for an acknowledgement), by priority and by type of event, grouped by what is asked of the person) and
/// "Việc cần xử lý" (the alerts of the person, the full list that the home leads to with "See all"). Opening a row opens its detail (MOB-33);
/// a push that was only delivered marks nothing read. The number unread is the badge of the Notifications tab. The screen also registers
/// this device for push (a device without a token is simply not registered and keeps its inbox).
Widget buildNotificationInboxScreen(BuildContext context, ScreenContext screen) => NotificationInboxScreen(initialTab: screen.queryParameters[inboxTabParameter] == inboxTabWork ? 1 : 0);

/// The query parameter that opens the inbox on its second tab, the alerts of the person: the "See all" of the home leads there.
const String inboxTabParameter = 'tab';
const String inboxTabWork = 'work';

class NotificationInboxScreen extends ConsumerStatefulWidget {
  const NotificationInboxScreen({this.initialTab = 0, super.key});

  /// 0 the events, 1 the alerts of the person.
  final int initialTab;

  @override
  ConsumerState<NotificationInboxScreen> createState() => _NotificationInboxScreenState();
}

class _NotificationInboxScreenState extends ConsumerState<NotificationInboxScreen> {
  NotificationFilter _filter = const NotificationFilter();
  late int _tab = widget.initialTab;

  // The inbox keeps its state while another tab is open, so a link to the other tab arrives as a new parameter of the same screen: follow it.
  @override
  void didUpdateWidget(NotificationInboxScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialTab != widget.initialTab) _tab = widget.initialTab;
  }

  @override
  void initState() {
    super.initState();
    ref.read(pushRefreshListenerProvider);
    ref.read(alertBadgeProvider);
    unawaited(ref.read(pushRegistrationProvider).sync());
  }

  @override
  Widget build(BuildContext context) {
    final AlertCounts? alerts = ref.watch(alertBadgeProvider);
    return ScreenFrame(
      root: true,
      title: context.t('mob.ntf.inbox.title'),
      actions: <Widget>[
        AppBarAction(icon: Icons.forum_outlined, label: context.t('mob.conv.inbox.open.action'), onPressed: () => openScreen(context, 'MOB-35', stacked: true)),
        AppBarAction(icon: Icons.tune, label: context.t('mob.ntf.inbox.settings.action'), onPressed: () => openScreen(context, 'MOB-34', stacked: true)),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          UnderlineTabs(
            tabs: <TabOption>[
              TabOption(label: context.t('mob.ntf.inbox.tab.events')),
              TabOption(label: context.t('mob.ntf.inbox.tab.work'), count: alerts != null && alerts.needsDoing > 0 ? alerts.needsDoing : null),
            ],
            index: _tab,
            onChanged: (int index) => setState(() => _tab = index),
          ),
          // Both tabs stay mounted: the alerts are read once and keep their place while the person looks at the events.
          Expanded(
            child: IndexedStack(
              index: _tab,
              children: <Widget>[
                DataView<NotificationList>(
                  cacheKey: 'notifications.inbox',
                  reloadKey: ref.watch(notificationsChangedProvider),
                  read: readNotifications,
                  parse: parseNotificationList,
                  builder: (BuildContext context, Loaded<NotificationList> loaded) {
                    final NotificationList list = loaded.value;
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      // The number on the tab is the count of alerts the server gave; the unread notifications stand in for it only until it answers.
                      if (mounted && ref.read(alertBadgeProvider) == null) ref.read(tabBadgeProvider.notifier).set(AppTab.inbox, list.unreadCount);
                    });
                    return _InboxBody(list: list, filter: _filter, onFilter: (NotificationFilter next) => setState(() => _filter = next));
                  },
                ),
                const SingleChildScrollView(child: AlertsSection()),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The notifications of the member, a page at a time, to the end or to the limit of pages.
Future<Object?> readNotifications(MachvonApiClient client) async {
  final Map<String, Object?> merged = await readMerged(client, 'listMyNotifications', query: <String, Object?>{'limit': inboxPageSize});
  return merged;
}

/// One entry of the list: a heading of a group or a notification. The timeline is groups of what is asked of the person (the model has no
/// moment to group by day yet; a day group is one more kind of heading here).
sealed class _Entry {
  const _Entry();
}

final class _Heading extends _Entry {
  const _Heading(this.title, this.count);

  final String title;
  final int count;
}

final class _Item extends _Entry {
  const _Item(this.item, {required this.first});

  final NotificationItem item;
  final bool first;
}

List<_Entry> _entries(BuildContext context, List<NotificationItem> shown) {
  final List<NotificationItem> action = <NotificationItem>[for (final NotificationItem item in shown) if (item.needsAction) item];
  final List<NotificationItem> unread = <NotificationItem>[for (final NotificationItem item in shown) if (!item.needsAction && item.isUnread) item];
  final List<NotificationItem> read = <NotificationItem>[for (final NotificationItem item in shown) if (!item.needsAction && !item.isUnread) item];
  final List<_Entry> entries = <_Entry>[];
  void group(String title, List<NotificationItem> items) {
    if (items.isEmpty) return;
    entries.add(_Heading(title, items.length));
    for (int index = 0; index < items.length; index += 1) {
      entries.add(_Item(items[index], first: index == 0));
    }
  }

  group(context.t('mob.ntf.inbox.group.action'), action);
  group(context.t('mob.ntf.inbox.group.unread'), unread);
  group(context.t('mob.ntf.inbox.group.read'), read);
  return entries;
}

class _InboxBody extends StatelessWidget {
  const _InboxBody({required this.list, required this.filter, required this.onFilter});

  final NotificationList list;
  final NotificationFilter filter;
  final ValueChanged<NotificationFilter> onFilter;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final List<NotificationItem> shown = applyNotificationFilter(list.items, filter);
    final List<String> types = <String>{for (final NotificationItem item in list.items) ?item.eventType}.toList()..sort();
    final Map<InboxView, int> counts = <InboxView, int>{
      InboxView.all: list.items.length,
      InboxView.unread: list.unreadCount,
      InboxView.action: list.items.where((NotificationItem item) => item.needsAction).length,
    };
    final int narrowed = (filter.priority == null ? 0 : 1) + (filter.type == null ? 0 : 1);
    final List<Widget> header = <Widget>[
      FilterChips<InboxView>(
        options: <ChipOption<InboxView>>[
          for (final InboxView view in InboxView.values)
            ChipOption<InboxView>(value: view, label: _viewLabel(context, view), count: counts[view]),
        ],
        selected: filter.view,
        onChanged: (InboxView view) => onFilter(NotificationFilter(view: view, priority: filter.priority, type: filter.type)),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.ntf.inbox.count', <String, Object>{'shown': shown.length, 'total': list.items.length}), style: text.caption),
                  if (!list.complete) Text(context.t('mob.ntf.inbox.partial'), style: text.caption),
                ],
              ),
            ),
            TapTarget(
              onTap: () => _openFilters(context, types),
              semanticLabel: narrowed == 0 ? context.t('mob.ntf.inbox.filter.action') : context.t('mob.ntf.inbox.filter.active', <String, Object>{'count': narrowed}),
              radius: MachvonV2Radius.chip,
              minHeight: 48,
              alignment: Alignment.center,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(Icons.filter_list, size: 20, color: context.v2.palette.primaryStrong),
                    const SizedBox(width: MachvonV2Space.s4),
                    Text(
                      narrowed == 0 ? context.t('mob.ntf.inbox.filter.action') : context.t('mob.ntf.inbox.filter.active', <String, Object>{'count': narrowed}),
                      style: text.label.copyWith(color: context.v2.palette.primaryStrong),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: MachvonV2Space.s8),
    ];
    if (shown.isEmpty) {
      return ListView(
        children: <Widget>[
          ...header,
          SizedBox(
            height: 360,
            child: EmptyStateView(
              activeFilters: <String>[
                if (filter.view != InboxView.all) _viewLabel(context, filter.view),
                if (filter.priority != null) priorityLabel(context, filter.priority!),
                if (filter.type != null) eventTypeLabel(context, filter.type!),
              ],
              onClearFilters: () => onFilter(const NotificationFilter()),
            ),
          ),
        ],
      );
    }
    final List<_Entry> entries = _entries(context, shown);
    return ListView.builder(
      itemCount: header.length + entries.length,
      itemBuilder: (BuildContext context, int index) {
        if (index < header.length) return header[index];
        final _Entry entry = entries[index - header.length];
        return switch (entry) {
          _Heading() => GroupHeader(title: entry.title, count: entry.count),
          _Item() => _Row(item: entry.item, first: entry.first),
        };
      },
    );
  }

  /// The priority and the type of event, which are rarely changed, in a sheet: the chips apply at once and the list behind follows.
  Future<void> _openFilters(BuildContext context, List<String> types) {
    return showActionSheet<void>(
      context,
      title: context.t('mob.ntf.inbox.filter.title'),
      builder: (BuildContext sheet) => _FilterSheet(types: types, initial: filter, onFilter: onFilter),
    );
  }

  String _viewLabel(BuildContext context, InboxView view) {
    switch (view) {
      case InboxView.all:
        return context.t('mob.ntf.inbox.view.all');
      case InboxView.unread:
        return context.t('mob.ntf.inbox.view.unread');
      case InboxView.action:
        return context.t('mob.ntf.inbox.view.action');
    }
  }
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.types, required this.initial, required this.onFilter});

  final List<String> types;
  final NotificationFilter initial;
  final ValueChanged<NotificationFilter> onFilter;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late NotificationFilter _filter = widget.initial;

  void _set(NotificationFilter next) {
    setState(() => _filter = next);
    widget.onFilter(next);
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    const EdgeInsets none = EdgeInsets.symmetric(vertical: MachvonV2Space.s8);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(header: true, child: Text(context.t('mob.ntf.inbox.priority.label'), style: text.label)),
        FilterChips<String?>(
          padding: none,
          options: <ChipOption<String?>>[
            ChipOption<String?>(value: null, label: context.t('mob.ntf.inbox.priority.all')),
            for (final String priority in priorities) ChipOption<String?>(value: priority, label: priorityLabel(context, priority)),
          ],
          selected: _filter.priority,
          onChanged: (String? priority) => _set(NotificationFilter(view: _filter.view, priority: priority, type: _filter.type)),
        ),
        if (widget.types.isNotEmpty) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s12),
          Semantics(header: true, child: Text(context.t('mob.ntf.inbox.type.label'), style: text.label)),
          FilterChips<String?>(
            padding: none,
            options: <ChipOption<String?>>[
              ChipOption<String?>(value: null, label: context.t('mob.ntf.inbox.type.all')),
              for (final String type in widget.types) ChipOption<String?>(value: type, label: eventTypeLabel(context, type)),
            ],
            selected: _filter.type,
            onChanged: (String? type) => _set(NotificationFilter(view: _filter.view, priority: _filter.priority, type: type)),
          ),
        ],
        const SizedBox(height: MachvonV2Space.s16),
        FilledButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t('mob.ntf.inbox.filter.done'))),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.item, required this.first});

  final NotificationItem item;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final String title = titleOf(context, item);
    final String state = stateLabel(context, item);
    final String priority = priorityLabel(context, item.priority);
    final MachvonV2Palette p = context.v2.palette;
    final bool urgent = item.priority == 'CRITICAL' || item.priority == 'HIGH';
    final (IconData icon, Color color) mark = item.needsAction
        ? (Icons.warning_amber_rounded, p.soonFg)
        : item.acknowledgedAt != null
            ? (Icons.check_circle_outline, p.okFg)
            : item.isUnread
                ? (Icons.fiber_manual_record, p.primaryStrong)
                : (Icons.drafts_outlined, p.ink3);
    return WorkRow(
      dividerAbove: !first,
      quiet: !item.isUnread && !item.needsAction,
      title: title,
      subtitle: urgent ? priority : null,
      leading: GlyphSquare(
        icon: item.isUnavailable ? Icons.lock_outline : Icons.notifications_none,
        tone: item.needsAction ? GlyphTone.attention : (item.isUnread ? GlyphTone.primary : GlyphTone.neutral),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ExcludeSemantics(child: Icon(mark.$1, size: 16, color: mark.$2)),
          const SizedBox(width: MachvonV2Space.s4),
          Flexible(child: Text(state, style: context.v2text.label.copyWith(color: mark.$2))),
        ],
      ),
      semanticLabel: context.t('mob.ntf.item.aria', <String, Object>{'title': title, 'priority': priority, 'state': state}),
      onTap: () => openScreen(context, 'MOB-33', pathSuffix: '/${Uri.encodeComponent(item.id)}'),
    );
  }
}
