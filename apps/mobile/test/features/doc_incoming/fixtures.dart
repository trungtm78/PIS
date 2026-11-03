import 'package:machvon_mobile/core/session/session.dart';

import '../../support/harness.dart';
import '../support/scripted_server.dart';

export '../acceptance_handover/fixtures.dart' show page, problem, recorded;

/// The membership the handler of the tests signed in with.
const String kHandler = 'mem-1';

FakeSession handlerSession({SessionMode mode = SessionMode.full}) =>
    FakeSession(SessionSnapshot(status: SessionStatus.signedIn, tenantId: 'tenant-a', userId: 'user-1', membershipId: kHandler, mode: mode));

/// What the server says this reader may do with a letter.
Map<String, Object?> actions({bool start = false, bool resolve = false}) =>
    <String, Object?>{'register': false, 'reject': false, 'assign': false, 'startProcessing': start, 'resolve': resolve};

/// An incoming letter as the server shows it to the handler.
Map<String, Object?> letter(
  int n, {
  String status = 'ASSIGNED',
  String? handler = kHandler,
  int? overdueDays,
  String? due = '2026-10-27',
  String? directive = 'Chuẩn bị ý kiến.',
  int? number = 10,
  String? symbol = '10/REG-DEN-2026',
  Map<String, Object?>? act,
  int version = 3,
  String urgency = 'NORMAL',
  String received = '2026-10-20T01:00:00Z',
  String? fileHash = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12',
  String? summary,
  List<Object?> assignments = const <Object?>[],
}) =>
    <String, Object?>{
      'id': 'in-$n',
      'status': status,
      'channel': 'UPLOAD',
      'title': 'Công văn số $n',
      'doc_type_code': 'CV',
      'classification': 'INTERNAL',
      'received_at': received,
      'register': <String, Object?>{'id': 'r-1', 'code': 'REG-DEN-2026'},
      'number': number,
      'symbol': number == null ? null : symbol,
      'original_symbol': '${n}00/UBND',
      'sender_name': 'Sở Giao thông $n',
      'urgency': urgency,
      'due_on': due,
      'leader_directive': directive,
      'assigned_unit': <String, Object?>{'id': 'u-1', 'name': 'Phòng Quản lý dự án'},
      'assignee': handler == null ? null : <String, Object?>{'user_id': handler, 'display_name': 'Lê Chuyên Viên'},
      'resolution_summary': summary,
      'resolved_at': summary == null ? null : '2026-10-28T08:00:00Z',
      'late_days': summary == null ? null : 1,
      'is_overdue': overdueDays != null,
      'overdue_days': overdueDays,
      'file_sha256': fileHash,
      'version': version,
      'actions': act ?? actions(start: status == 'ASSIGNED', resolve: status == 'PROCESSING'),
      'assignments': assignments,
    };

/// A page of letters; the server filters on one status at a time.
Map<String, Object?> letterPage(List<Map<String, Object?>> items, {String? status, String? next}) => <String, Object?>{
      'items': <Object?>[
        for (final Map<String, Object?> item in items)
          if (status == null || item['status'] == status) item,
      ],
      'next_cursor': next,
      'as_of': '2026-10-28T08:00:00Z',
    };

/// The list and the letters of a server that holds [letters].
void answerLetters(ScriptedServer server, List<Map<String, Object?>> letters) {
  server.on('GET', '/incoming-documents', (call) => letterPage(letters, status: call.url.queryParameters['status']));
  for (final Map<String, Object?> one in letters) {
    server.on('GET', '/incoming-documents/${one['id']}', (_) => one);
  }
}
