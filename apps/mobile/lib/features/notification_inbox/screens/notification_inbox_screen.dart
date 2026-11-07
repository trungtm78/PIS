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
import '../../dashboard/alert_badge.dart';
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

/// MOB-32: the notifications of the member. Filters by view (all, unread, waiting for an acknowledgement), by priority and by
/// type of event. Opening a row opens its detail (MOB-33); a push that was only delivered marks nothing read. The number unread
/// is the badge of the Notifications tab. The screen also registers this device for push (a device without a token is simply
/// not registered and keeps its inbox).
Widget buildNotificationInboxScreen(BuildContext context, ScreenContext screen) => const NotificationInboxScreen();

class NotificationInboxScreen extends ConsumerStatefulWidget {
  const NotificationInboxScreen({super.key});

  @override
  ConsumerState<NotificationInboxScreen> createState() => _NotificationInboxScreenState();
}

class _NotificationInboxScreenState extends ConsumerState<NotificationInboxScreen> {
  NotificationFilter _filter = const NotificationFilter();

  @override
  void initState() {
    super.initState();
    ref.read(pushRefreshListenerProvider);
    ref.read(alertBadgeProvider);
    unawaited(ref.read(pushRegistrationProvider).sync());
  }

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.ntf.inbox.title'),
      actions: <Widget>[
        IconButton(
          tooltip: context.t('mob.conv.inbox.open.action'),
          icon: const Icon(Icons.forum_outlined),
          onPressed: () => openScreen(context, 'MOB-35', stacked: true),
        ),
        IconButton(
          tooltip: context.t('mob.ntf.inbox.settings.action'),
          icon: const Icon(Icons.tune),
          onPressed: () => openScreen(context, 'MOB-34', stacked: true),
        ),
      ],
      body: DataView<NotificationList>(
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
    );
  }
}

/// The notifications of the member, a page at a time, to the end or to the limit of pages.
Future<Object?> readNotifications(MachvonApiClient client) async {
  final Map<String, Object?> merged = await readMerged(client, 'listMyNotifications', query: <String, Object?>{'limit': inboxPageSize});
  return merged;
}

class _InboxBody extends StatelessWidget {
  const _InboxBody({required this.list, required this.filter, required this.onFilter});

  final NotificationList list;
  final NotificationFilter filter;
  final ValueChanged<NotificationFilter> onFilter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<NotificationItem> shown = applyNotificationFilter(list.items, filter);
    final List<String> types = <String>{for (final NotificationItem item in list.items) ?item.eventType}.toList()..sort();
    final Map<InboxView, int> counts = <InboxView, int>{
      InboxView.all: list.items.length,
      InboxView.unread: list.unreadCount,
      InboxView.action: list.items.where((NotificationItem item) => item.needsAction).length,
    };
    final List<Widget> header = <Widget>[
      const AlertsSection(),
      Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              children: <Widget>[
                for (final InboxView view in InboxView.values)
                  ChoiceChip(
                    label: Text(context.t('mob.ntf.inbox.view.count', <String, Object>{'label': _viewLabel(context, view), 'count': counts[view]!})),
                    selected: filter.view == view,
                    onSelected: (bool selected) => onFilter(NotificationFilter(view: view, priority: filter.priority, type: filter.type)),
                  ),
              ],
            ),
            const SizedBox(height: MachvonSpace.space12),
            DropdownButtonFormField<String?>(
              initialValue: filter.priority,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.ntf.inbox.priority.label')),
              items: <DropdownMenuItem<String?>>[
                DropdownMenuItem<String?>(child: Text(context.t('mob.ntf.inbox.priority.all'))),
                for (final String priority in priorities) DropdownMenuItem<String?>(value: priority, child: Text(priorityLabel(context, priority))),
              ],
              onChanged: (String? priority) => onFilter(NotificationFilter(view: filter.view, priority: priority, type: filter.type)),
            ),
            if (types.isNotEmpty) ...<Widget>[
              const SizedBox(height: MachvonSpace.space12),
              DropdownButtonFormField<String?>(
                initialValue: filter.type,
                isExpanded: true,
                decoration: InputDecoration(labelText: context.t('mob.ntf.inbox.type.label')),
                items: <DropdownMenuItem<String?>>[
                  DropdownMenuItem<String?>(child: Text(context.t('mob.ntf.inbox.type.all'))),
                  for (final String type in types) DropdownMenuItem<String?>(value: type, child: Text(eventTypeLabel(context, type))),
                ],
                onChanged: (String? type) => onFilter(NotificationFilter(view: filter.view, priority: filter.priority, type: type)),
              ),
            ],
            const SizedBox(height: MachvonSpace.space8),
            Text(context.t('mob.ntf.inbox.count', <String, Object>{'shown': shown.length, 'total': list.items.length}), style: theme.textTheme.bodySmall),
            if (!list.complete) Text(context.t('mob.ntf.inbox.partial'), style: theme.textTheme.bodySmall),
          ],
        ),
      ),
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
    return ListView.builder(
      itemCount: header.length + shown.length,
      itemBuilder: (BuildContext context, int index) => index < header.length ? header[index] : _Row(item: shown[index - header.length]),
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

class _Row extends StatelessWidget {
  const _Row({required this.item});

  final NotificationItem item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String title = titleOf(context, item);
    final String state = stateLabel(context, item);
    final String priority = priorityLabel(context, item.priority);
    return TappableRow(
      semanticLabel: context.t('mob.ntf.item.aria', <String, Object>{'title': title, 'priority': priority, 'state': state}),
      onTap: () => openScreen(context, 'MOB-33', pathSuffix: '/${Uri.encodeComponent(item.id)}'),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: item.isUnread ? FontWeight.w700 : FontWeight.w400)),
                Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: priority, warn: item.priority == 'CRITICAL' || item.priority == 'HIGH'), StatusPill(label: state, warn: item.needsAction)]),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
