import 'package:flutter/material.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';

import '../support/scripted_server.dart';

const String idZalo = '3f2b6c1e-0000-4000-8000-0000000000a1';
const String idInternal = '3f2b6c1e-0000-4000-8000-0000000000a2';
const String idResolved = '3f2b6c1e-0000-4000-8000-0000000000a3';
const String idClosed = '3f2b6c1e-0000-4000-8000-0000000000a4';
const String idWhatsapp = '3f2b6c1e-0000-4000-8000-0000000000a5';
const String accountZalo = '3f2b6c1e-0000-4000-8000-0000000000b1';
const String accountWhatsapp = '3f2b6c1e-0000-4000-8000-0000000000b2';
const String accountInternal = '3f2b6c1e-0000-4000-8000-0000000000b3';
const String idProject = '3f2b6c1e-0000-4000-8000-0000000000c1';
const String idIssue = '3f2b6c1e-0000-4000-8000-0000000000c2';
const String idMessageIn = '3f2b6c1e-0000-4000-8000-0000000000d1';
const String idMessageOut = '3f2b6c1e-0000-4000-8000-0000000000d2';
const String idMessageNote = '3f2b6c1e-0000-4000-8000-0000000000d3';
const String idColleague = '3f2b6c1e-0000-4000-8000-0000000000e1';

/// The text of the messages: personal data that only the read of one message returns.
const String textIn = 'Tôi cần biết khi nào nhận được tiền bồi thường';
const String textOut = 'Chúng tôi sẽ trả lời trong hôm nay';
const String textNote = 'Đã gọi cho hộ dân, hẹn chiều thứ sáu';

Map<String, Object?> conversationJson(
  String id, {
  String contact = 'Nguyễn Văn An',
  String channel = 'ZALO_OA',
  String account = accountZalo,
  String status = 'InProgress',
  int version = 7,
  String? assignee = 'Trần Thị Bình',
  String? unit = 'Ban QLDA giao thông',
  String? window = '2026-11-04T02:00:00Z',
  List<Map<String, Object?>> links = const <Map<String, Object?>>[],
  int messages = 3,
}) =>
    <String, Object?>{
      'id': id,
      'channel_account_id': account,
      'channel': channel,
      'account_name': 'Zalo OA Ban QLDA',
      'contact_id': '3f2b6c1e-0000-4000-8000-0000000000f1',
      'contact_name': contact,
      'status': status,
      'priority': 'NORMAL',
      if (assignee != null) 'assignee_name': assignee,
      if (unit != null) 'queue_unit_name': unit,
      'last_inbound_at': '2026-11-03T02:00:00Z',
      if (window != null) 'window_expires_at': window,
      'sla_first_response_due_at': '2026-11-03T04:00:00Z',
      'message_count': messages,
      'created_at': '2026-11-03T01:00:00Z',
      'version': version,
      'resource_links': links,
    };

Map<String, Object?> link(String type, String id, {bool converted = false}) => <String, Object?>{'resource_type': type, 'resource_id': id, 'linked_at': '2026-11-03T01:30:00Z', 'converted': converted};

Map<String, Object?> page(List<Map<String, Object?>> items, {String? next}) => <String, Object?>{'items': items, 'next_cursor': next, 'as_of': '2026-11-03T03:00:00Z'};

Map<String, Object?> messageJson(String id, String direction, {String? delivery, String at = '2026-11-03T02:00:00Z'}) => <String, Object?>{
      'id': id,
      'conversation_id': idZalo,
      'direction': direction,
      'kind': direction == 'INTERNAL_NOTE' ? 'NOTE' : 'TEXT',
      if (delivery != null) 'delivery_status': delivery,
      'classification': 'PERSONAL',
      'created_at': at,
    };

List<Map<String, Object?>> standardMessages() => <Map<String, Object?>>[
      messageJson(idMessageIn, 'INBOUND', at: '2026-11-03T02:00:00Z'),
      messageJson(idMessageOut, 'OUTBOUND', delivery: 'Delivered', at: '2026-11-03T02:10:00Z'),
      messageJson(idMessageNote, 'INTERNAL_NOTE', at: '2026-11-03T02:20:00Z'),
    ];

Map<String, Object?> accepted({int version = 8, String status = 'QUEUED'}) => <String, Object?>{'operation_id': 'o-1', 'status': status, 'resource_version': version};

/// The server of the conversations: the list, one conversation, its messages, the text of each message.
ScriptedServer conversationServer({List<Map<String, Object?>>? conversations, Map<String, Object?>? conversation, List<Map<String, Object?>>? messages}) {
  final ScriptedServer server = ScriptedServer();
  final Map<String, Object?> one = conversation ?? conversationJson(idZalo);
  server.on('GET', '/resources/conversation', (_) => page(conversations ?? <Map<String, Object?>>[one]));
  server.on('GET', '/resources/conversation/:id', (_) => one);
  server.on('GET', '/resources/channel_message', (_) => page(messages ?? standardMessages()));
  server.on('GET', '/resources/channel_message/:id', (call) {
    final String id = call.url.pathSegments.last;
    final String? text = <String, String>{idMessageIn: textIn, idMessageOut: textOut, idMessageNote: textNote}[id];
    return <String, Object?>{...standardMessages().firstWhere((Map<String, Object?> m) => m['id'] == id), 'text': text};
  });
  return server;
}

/// The screens a record opens in, as the project detail of another story: a stub that takes the id.
const MobileFeature recordsFeature = MobileFeature(id: 'records', screens: <ScreenSpec>[ScreenSpec(screenId: 'MOB-10', pathSuffix: '/:projectId', builder: _record)]);

Widget _record(BuildContext context, ScreenContext screen) => Text('project ${screen.pathParameters.values.single}');
