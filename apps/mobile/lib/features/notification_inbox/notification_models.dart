import '../read_support/wire.dart';

/// The title key the API sends instead of any content once the member lost access to what the notification is about (NOT-02).
const String unavailableTitleKey = 'notification.content.unavailable.title';

final RegExp _titleKey = RegExp(r'^notification\.event\.(.+)\.title$');

/// The shape of the only link a push carries: it names the notification and nothing about what it is about. Opening it asks
/// for the sign-in, the tenant and the permission of the moment (BR-MOB-04, BR-MOB-05).
final RegExp opaqueLinkPattern = RegExp(r'^/r/([A-Za-z0-9_-]{16,64})$');

/// One notification of the member (`listMyNotifications`).
final class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.title,
    required this.priority,
    required this.status,
    required this.ackRequired,
    this.readAt,
    this.acknowledgedAt,
    this.resourceRef,
  });

  final String id;

  /// A message key (`notification.event.<type>.title`) or the unavailable key; never free text.
  final String title;
  final String priority;
  final String status;
  final bool ackRequired;
  final String? readAt;
  final String? acknowledgedAt;

  /// A reference to the source record, sent only while the member may still read it.
  final String? resourceRef;

  /// Read is not acknowledged (BR-MOB-04): unread means the recipient has not opened it.
  bool get isUnread => readAt == null;

  /// It still waits for the recipient's acknowledgement.
  bool get needsAction => ackRequired && acknowledgedAt == null;

  /// The member lost access to the record: nothing of it is shown.
  bool get isUnavailable => title == unavailableTitleKey;

  /// The type of event, read from the title key; null for the unavailable title and for a key that is not an event title.
  String? get eventType => _titleKey.firstMatch(title)?.group(1);
}

NotificationItem? parseNotification(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? title = filled(row?['title']);
  if (row == null || id == null || title == null) return null;
  return NotificationItem(
    id: id,
    title: title,
    priority: text(row['priority']) ?? 'NORMAL',
    status: text(row['status']) ?? '',
    ackRequired: row['ack_required'] == true,
    readAt: filled(row['read_at']),
    acknowledgedAt: filled(row['acknowledged_at']),
    resourceRef: filled(row['resource_ref']),
  );
}

/// The notifications of the member the screen follows pages for, and whether the list ends there.
final class NotificationList {
  const NotificationList({required this.items, required this.complete, this.nextCursor});

  final List<NotificationItem> items;

  /// The pages were followed to their end.
  final bool complete;

  /// Where the list goes on when the pages were not followed to their end.
  final String? nextCursor;

  int get unreadCount => items.where((NotificationItem item) => item.isUnread).length;

  NotificationItem? byId(String id) {
    for (final NotificationItem item in items) {
      if (item.id == id) return item;
    }
    return null;
  }
}

/// The list from `{items: [...], next_cursor}`, or null when it is not one.
NotificationList? parseNotificationList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return NotificationList(items: <NotificationItem>[for (final Object? item in listOf(body['items'])) ?parseNotification(item)], complete: filled(body['next_cursor']) == null, nextCursor: filled(body['next_cursor']));
}

enum InboxView { all, unread, action }

/// What the member narrows the inbox by: the view, the priority and the type of event.
final class NotificationFilter {
  const NotificationFilter({this.view = InboxView.all, this.priority, this.type});

  final InboxView view;

  /// `CRITICAL`, `HIGH`, ... or null for every priority.
  final String? priority;

  /// An event type, or null for every type.
  final String? type;

  bool get isEmpty => view == InboxView.all && priority == null && type == null;
}

List<NotificationItem> applyNotificationFilter(List<NotificationItem> items, NotificationFilter filter) => <NotificationItem>[
      for (final NotificationItem item in items)
        if ((filter.view != InboxView.unread || item.isUnread) &&
            (filter.view != InboxView.action || item.needsAction) &&
            (filter.priority == null || item.priority == filter.priority) &&
            (filter.type == null || item.eventType == filter.type))
          item,
    ];

/// The priorities the filter offers.
const List<String> priorities = <String>['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

// ---- where a record opens ----------------------------------------------------------------------------------------------

final RegExp _recordId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// The id of the notification an opaque link names, or null when the location is not an opaque link of this shape.
String? opaqueIdOf(Uri location) => location.pathSegments.isEmpty || location.pathSegments.first != 'r' ? null : opaqueLinkPattern.firstMatch(location.path)?.group(1);

/// Whether the location is on the opaque path (`/r/...`) whatever follows, so a malformed link is refused and not routed.
bool isOpaquePath(Uri location) => location.pathSegments.isNotEmpty && location.pathSegments.first == 'r';

/// The screen of the phone that opens the record a notification is about, or null when there is none. The reference of the
/// server is a path of the web application (`/prj/prj-03?id=...`); only the records the phone has a screen for open, with an
/// id that is a plain token. An external address, a script or an unknown path never opens (the screen it opens checks the
/// member's access again).
String? recordLocationOf(String? reference, String Function(String screenId) locationOf) {
  if (reference == null || !reference.startsWith('/') || reference.startsWith('//') || reference.contains(r'\')) return null;
  final Uri? parsed = Uri.tryParse(reference);
  if (parsed == null || parsed.hasScheme || parsed.hasAuthority) return null;
  final String? id = parsed.queryParameters['id'];
  if (id == null || !_recordId.hasMatch(id)) return null;
  switch (parsed.path) {
    case '/prj/prj-03':
      return '${locationOf('MOB-10')}/${Uri.encodeComponent(id)}';
    case '/adm/adm-06':
      return '${locationOf('MOB-24')}/${Uri.encodeComponent(id)}';
    default:
      return null;
  }
}
