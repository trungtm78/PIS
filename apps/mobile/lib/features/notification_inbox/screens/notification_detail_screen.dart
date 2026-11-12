import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../notification_commands.dart';
import '../notification_labels.dart';
import '../notification_models.dart';
import 'notification_inbox_screen.dart' show inboxPageSize, readNotifications;

/// The query parameter that says the detail was opened from a push, so that the read receipt records it.
const String openedViaParameter = 'via';
const String openedViaPush = 'push';

/// MOB-33: one notification. Opening it marks it read, once (from a push the receipt says `PUSH`); acknowledging is a separate
/// act that only a notification that asks for it offers, and only once it is read. Read is never acknowledged, and a push that
/// was only delivered or tapped is not an acknowledgement. What the member may see is decided by the server on every read: a
/// notification whose record they lost access to shows nothing but that fact, and a notification that is not theirs is not found.
Widget buildNotificationDetailScreen(BuildContext context, ScreenContext screen) => NotificationDetailScreen(
      notificationId: screen.pathParameters['notificationId'] ?? '',
      openedVia: screen.queryParameters[openedViaParameter] == openedViaPush ? 'PUSH' : 'IN_APP',
    );

class NotificationDetailScreen extends ConsumerWidget {
  const NotificationDetailScreen({required this.notificationId, required this.openedVia, super.key});

  final String notificationId;
  final String openedVia;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ScreenFrame(
      title: context.t('mob.ntf.detail.title'),
      body: DataView<NotificationList>(
        cacheKey: 'notifications.inbox',
        reloadKey: ref.watch(notificationsChangedProvider),
        read: readNotifications,
        parse: parseNotificationList,
        builder: (BuildContext context, Loaded<NotificationList> loaded) {
          final NotificationItem? item = loaded.value.byId(notificationId);
          if (item != null) return _Detail(item: item, fromCopy: loaded.fromCache, openedVia: openedVia);
          final String? cursor = loaded.value.nextCursor;
          // The inbox lists the newest notifications up to a limit of pages: one that is not among them may still be further on.
          return cursor == null ? const _NotFound() : _FurtherOn(notificationId: notificationId, cursor: cursor, openedVia: openedVia);
        },
      ),
    );
  }
}

/// A notification that is not in the pages the inbox holds, looked for in the pages after them until it is found or the list ends.
/// Not found is said only when the server's list was read to its end.
class _FurtherOn extends ConsumerWidget {
  const _FurtherOn({required this.notificationId, required this.cursor, required this.openedVia});

  final String notificationId;
  final String cursor;
  final String openedVia;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DataView<NotificationList>(
      cacheKey: 'notifications.detail.$notificationId',
      keepCopy: false,
      reloadKey: ref.watch(notificationsChangedProvider),
      read: (MachvonApiClient client) => readNotificationsUntil(client, notificationId, from: cursor),
      parse: parseNotificationList,
      builder: (BuildContext context, Loaded<NotificationList> loaded) {
        final NotificationItem? item = loaded.value.byId(notificationId);
        return item == null ? const _NotFound() : _Detail(item: item, fromCopy: loaded.fromCache, openedVia: openedVia);
      },
    );
  }
}

/// The notifications of the member from [from] on, page after page, up to the one called [id] or to the end of the list. A cursor that
/// comes back ends the read (it would ask for the same page for ever).
Future<Object?> readNotificationsUntil(MachvonApiClient client, String id, {required String from}) async {
  final List<Object?> items = <Object?>[];
  final Set<String> asked = <String>{};
  String? cursor = from;
  while (cursor != null && asked.add(cursor)) {
    final Json page = await readMerged(client, 'listMyNotifications', query: <String, Object?>{'limit': inboxPageSize, 'cursor': cursor}, maxPages: 1);
    items.addAll(listOf(page['items']));
    cursor = filled(page['next_cursor']);
    if (parseNotificationList(page)?.byId(id) != null) break;
  }
  return <String, Object?>{'items': items, 'next_cursor': null};
}

class _NotFound extends StatelessWidget {
  const _NotFound();

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      children: <Widget>[
        Semantics(liveRegion: true, container: true, child: Text(context.t('mob.ntf.detail.closed.title'), style: theme.textTheme.titleMedium)),
        const SizedBox(height: MachvonSpace.space4),
        Text(context.t('mob.ntf.detail.notFound.title'), style: theme.textTheme.bodyLarge),
        const SizedBox(height: MachvonSpace.space8),
        Text(context.t('mob.ntf.detail.notFound.body')),
        const SizedBox(height: MachvonSpace.space16),
        FilledButton(onPressed: () => openScreen(context, 'MOB-32'), child: Text(context.t('mob.ntf.detail.back.action'))),
      ],
    );
  }
}

class _Detail extends ConsumerStatefulWidget {
  const _Detail({required this.item, required this.fromCopy, required this.openedVia});

  final NotificationItem item;
  final bool fromCopy;
  final String openedVia;

  @override
  ConsumerState<_Detail> createState() => _DetailState();
}

class _DetailState extends ConsumerState<_Detail> {
  late final NotificationCommands _commands = NotificationCommands(ref.read(apiClientProvider));
  final TextEditingController _comment = TextEditingController();
  final Set<String> _marked = <String>{};
  bool _markFailed = false;
  bool _acknowledging = false;
  String? _acknowledgeError;
  bool _acknowledged = false;

  @override
  void initState() {
    super.initState();
    _markRead();
  }

  @override
  void didUpdateWidget(_Detail oldWidget) {
    super.didUpdateWidget(oldWidget);
    _markRead();
  }

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  /// Opening a notification marks it read, once per notification however often the screen is built. A copy kept on the device
  /// does not: the state of a notification is the server's, so it is marked when the server has been reached.
  Future<void> _markRead() async {
    final NotificationItem item = widget.item;
    if (!item.isUnread || item.isUnavailable || widget.fromCopy || _marked.contains(item.id)) return;
    _marked.add(item.id);
    await _send(item);
  }

  Future<void> _send(NotificationItem item) async {
    final CommandResultView result = await _commands.markRead(item.id, openedVia: widget.openedVia);
    if (!mounted) return;
    setState(() => _markFailed = !result.ok);
    if (result.ok) ref.read(notificationsChangedProvider.notifier).bump();
  }

  Future<void> _acknowledge(NotificationItem item) async {
    if (_acknowledging) return;
    setState(() {
      _acknowledging = true;
      _acknowledgeError = null;
    });
    final CommandResultView result = await _commands.acknowledge(item.id, _comment.text);
    if (!mounted) return;
    setState(() {
      _acknowledging = false;
      _acknowledged = result.ok;
      _acknowledgeError = result.ok ? null : acknowledgeErrorText(context, result);
    });
    if (result.ok) ref.read(notificationsChangedProvider.notifier).bump();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final NotificationItem item = widget.item;
    final String? recordLocation = item.isUnavailable ? null : recordLocationOf(item.resourceRef, (String id) => ref.read(routeTableProvider).locationOf(id));
    final bool canAcknowledge = item.needsAction && !item.isUnavailable && !_acknowledged;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: titleOf(context, item),
          children: <Widget>[
            Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: stateLabel(context, item), warn: item.needsAction)]),
            if (item.isUnavailable)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space8),
                child: Semantics(
                  liveRegion: true,
                  container: true,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(context.t('mob.ntf.detail.closed.title'), style: theme.textTheme.titleSmall),
                      Text(context.t('mob.ntf.detail.unavailable.body'), style: theme.textTheme.bodyMedium),
                    ],
                  ),
                ),
              )
            else ...<Widget>[
              FactLine(label: context.t('mob.ntf.detail.priority.label'), value: priorityLabel(context, item.priority)),
              if (item.readAt != null) FactLine(label: context.t('mob.ntf.detail.readAt.label'), value: formatMoment(item.readAt!)),
              if (item.acknowledgedAt != null) FactLine(label: context.t('mob.ntf.detail.acknowledgedAt.label'), value: formatMoment(item.acknowledgedAt!)),
              if (item.acknowledgedAt == null) Text(context.t('mob.ntf.detail.readNote'), style: theme.textTheme.bodySmall),
            ],
            if (_markFailed)
              Semantics(
                liveRegion: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.ntf.detail.read.error'), style: theme.textTheme.bodyMedium),
                    TextButton(onPressed: () => _send(item), child: Text(context.t('mob.ntf.detail.read.retry'))),
                  ],
                ),
              ),
          ],
        ),
        if (recordLocation != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
            child: OutlinedButton(onPressed: () => context.push(recordLocation), child: Text(context.t('mob.ntf.detail.open.action'))),
          ),
        if (canAcknowledge)
          SectionCard(
            title: context.t('mob.ntf.detail.ack.required'),
            children: <Widget>[
              TextField(controller: _comment, maxLength: 1000, maxLines: 3, readOnly: _acknowledging, decoration: InputDecoration(labelText: context.t('mob.ntf.detail.ack.comment'))),
              if (_acknowledgeError != null) Semantics(liveRegion: true, child: Text(_acknowledgeError!, style: theme.textTheme.bodyMedium)),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(
                onPressed: item.isUnread || _acknowledging ? null : () => _acknowledge(item),
                child: Text(context.t('mob.ntf.detail.ack.action')),
              ),
            ],
          ),
        if (_acknowledged) SectionCard(title: context.t('mob.ntf.detail.ack.done'), children: const <Widget>[]),
      ],
    );
  }

}
