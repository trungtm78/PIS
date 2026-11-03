import '../read_support/wire.dart';

/// The states of a conversation, as the server names them (`ConversationView.status`).
enum ConversationStatus { newConversation, assigned, inProgress, pendingCustomer, resolved, closed }

const Map<String, ConversationStatus> _statusByWire = <String, ConversationStatus>{
  'New': ConversationStatus.newConversation,
  'Assigned': ConversationStatus.assigned,
  'InProgress': ConversationStatus.inProgress,
  'PendingCustomer': ConversationStatus.pendingCustomer,
  'Resolved': ConversationStatus.resolved,
  'Closed': ConversationStatus.closed,
};

/// The wire name of a status, for the filter of the list.
String statusWire(ConversationStatus status) => _statusByWire.entries.firstWhere((MapEntry<String, ConversationStatus> entry) => entry.value == status).key;

/// The channels on which a conversation is with a person outside the system. A conversation on any other channel has nobody
/// outside to answer: it is internal, and a message written in it can only be a note for the colleagues.
const Set<String> externalChannels = <String>{'EMAIL', 'SMS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'};

bool isExternalChannel(String channel) => externalChannels.contains(channel);

/// The kinds of record a conversation can point to (`resource_links`).
enum LinkedKind { project, issue, contract }

final class RecordLink {
  const RecordLink({required this.kind, required this.id, required this.converted});

  final LinkedKind kind;
  final String id;

  /// The issue a conversion made, as opposed to one linked by hand.
  final bool converted;
}

/// One conversation of the inbox, or the one a thread shows. The names of the contact and of the colleagues are personal data: a
/// conversation is read for the screen and not kept.
final class ConversationItem {
  const ConversationItem({
    required this.id,
    required this.channelAccountId,
    required this.channel,
    required this.accountName,
    required this.contactName,
    required this.status,
    required this.messageCount,
    required this.version,
    this.assigneeName,
    this.queueUnitName,
    this.lastInboundAt,
    this.windowExpiresAt,
    this.firstResponseDueAt,
    this.links = const <RecordLink>[],
  });

  final String id;
  final String channelAccountId;
  final String channel;
  final String accountName;
  final String contactName;
  final ConversationStatus status;
  final int messageCount;

  /// The version the screen saw: every command on the conversation is sent under it.
  final int version;
  final String? assigneeName;
  final String? queueUnitName;
  final String? lastInboundAt;

  /// Until when the tenant may answer freely, as the server says. The phone never works it out from its own clock.
  final String? windowExpiresAt;
  final String? firstResponseDueAt;
  final List<RecordLink> links;

  bool get isExternal => isExternalChannel(channel);
}

const Map<String, LinkedKind> _kindByWire = <String, LinkedKind>{'project': LinkedKind.project, 'issue': LinkedKind.issue, 'contract': LinkedKind.contract};

RecordLink? _parseLink(Object? raw) {
  final Json? row = asRecord(raw);
  final LinkedKind? kind = _kindByWire[text(row?['resource_type'])];
  final String? id = filled(row?['resource_id']);
  if (row == null || kind == null || id == null) return null;
  return RecordLink(kind: kind, id: id, converted: row['converted'] == true);
}

/// A conversation, or null when the answer lacks what the screen cannot do without (the id, a known state, the version).
ConversationItem? parseConversation(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final ConversationStatus? status = _statusByWire[text(row?['status'])];
  final int? version = whole(row?['version']);
  if (row == null || id == null || status == null || version == null) return null;
  return ConversationItem(
    id: id,
    channelAccountId: text(row['channel_account_id']) ?? '',
    channel: text(row['channel']) ?? '',
    accountName: text(row['account_name']) ?? '',
    contactName: text(row['contact_name']) ?? '',
    status: status,
    messageCount: count(row['message_count']),
    version: version,
    assigneeName: filled(row['assignee_name']),
    queueUnitName: filled(row['queue_unit_name']),
    lastInboundAt: filled(row['last_inbound_at']),
    windowExpiresAt: filled(row['window_expires_at']),
    firstResponseDueAt: filled(row['sla_first_response_due_at']),
    links: <RecordLink>[for (final Object? link in listOf(row['resource_links'])) ?_parseLink(link)],
  );
}

/// The conversations of the reader (the queues of their units and those assigned to them: the server decides), newest first.
final class ConversationList {
  const ConversationList({required this.items, required this.more, this.asOf});

  final List<ConversationItem> items;

  /// The list was cut at the pages the phone reads; there are more.
  final bool more;
  final String? asOf;
}

ConversationList? parseConversationList(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  return ConversationList(
    items: <ConversationItem>[for (final Object? item in listOf(row['items'])) ?parseConversation(item)],
    more: filled(row['next_cursor']) != null,
    asOf: filled(row['as_of']),
  );
}

enum Direction { inbound, outbound, internalNote }

const Map<String, Direction> _directionByWire = <String, Direction>{'INBOUND': Direction.inbound, 'OUTBOUND': Direction.outbound, 'INTERNAL_NOTE': Direction.internalNote};

enum Delivery { queued, providerAccepted, delivered, read, failed }

const Map<String, Delivery> _deliveryByWire = <String, Delivery>{
  'Queued': Delivery.queued,
  'ProviderAccepted': Delivery.providerAccepted,
  'Delivered': Delivery.delivered,
  'Read': Delivery.read,
  'Failed': Delivery.failed,
};

/// One message of the list: where it came from and where it stands, never its text. The text is personal data and only the read of
/// one message returns it.
final class ThreadMessage {
  const ThreadMessage({required this.id, required this.direction, required this.createdAt, this.delivery});

  final String id;
  final Direction direction;
  final Delivery? delivery;
  final String createdAt;

  bool get isNote => direction == Direction.internalNote;
}

ThreadMessage? parseThreadMessage(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final Direction? direction = _directionByWire[text(row?['direction'])];
  if (row == null || id == null || direction == null) return null;
  return ThreadMessage(id: id, direction: direction, createdAt: text(row['created_at']) ?? '', delivery: _deliveryByWire[text(row['delivery_status'])]);
}

/// A conversation with its messages, oldest first.
final class ConversationThread {
  const ConversationThread({required this.conversation, required this.messages, required this.moreMessages, this.asOf});

  final ConversationItem conversation;
  final List<ThreadMessage> messages;

  /// The messages were cut at the pages the phone reads; the earlier ones are not shown.
  final bool moreMessages;
  final String? asOf;
}

/// The thread from the two reads the screen makes (`{'conversation': ..., 'messages': ...}`).
ConversationThread? parseThread(Object? raw) {
  final Json? row = asRecord(raw);
  final ConversationItem? conversation = parseConversation(row?['conversation']);
  final Json? messages = asRecord(row?['messages']);
  if (conversation == null || messages == null || messages['items'] is! List) return null;
  return ConversationThread(
    conversation: conversation,
    messages: <ThreadMessage>[for (final Object? item in listOf(messages['items'])) ?parseThreadMessage(item)],
    moreMessages: filled(messages['next_cursor']) != null,
    asOf: filled(messages['as_of']),
  );
}

/// The text of one message from the read of that message: null when the server masked it (a confidential message).
String? parseMessageText(Object? raw) => filled(asRecord(raw)?['text']);

/// A colleague a conversation can be given to (`listConversationAssignees`).
final class Assignee {
  const Assignee({required this.membershipId, required this.displayName});

  final String membershipId;
  final String displayName;
}

List<Assignee> parseAssignees(Object? raw) {
  final Json? row = asRecord(raw);
  return <Assignee>[
    for (final Object? item in listOf(row?['items']))
      if (asRecord(item) case final Json assignee when filled(assignee['membership_id']) != null)
        Assignee(membershipId: filled(assignee['membership_id'])!, displayName: text(assignee['display_name']) ?? ''),
  ];
}
