/// The fixture of the directive screen: three directives in the scope of the reader, one of them late for ten days and raised to the unit head.
const String directivesAsOf = '2026-11-08T03:00:00Z';

Map<String, Object?> directiveRow(
  String id,
  String code,
  String text, {
  String status = 'OPEN',
  String phase = 'DUE_LATER',
  String dueOn = '2026-12-20',
  String unit = 'Ban QLDA giao thông',
  String? person = 'Nguyễn Văn An',
  String? project = 'DA-001',
  int? daysToDue,
  int? overdueDays,
  bool pendingExtension = false,
}) =>
    <String, Object?>{
      'id': id,
      'code': code,
      'seq': 1,
      'meeting': <String, Object?>{'id': 'm-1', 'code': 'GB-2026-014', 'meeting_date': '2026-10-01', 'title': 'Giao ban tuần'},
      'scope_kind': project == null ? 'UNIT' : 'PROJECT',
      'project': project == null ? null : <String, Object?>{'id': 'p-1', 'code': project, 'name': 'Đường vành đai 1'},
      'scope_unit': <String, Object?>{'id': 'u-1', 'code': 'U1', 'name': unit},
      'text': text,
      'assignee_unit': <String, Object?>{'id': 'u-1', 'code': 'U1', 'name': unit},
      'assignee': person == null ? null : <String, Object?>{'membership_id': 'm-9', 'display_name': person},
      'original_due_on': dueOn,
      'due_on': dueOn,
      'extension_count': 0,
      'status': status,
      'stored_status': status == 'OVERDUE' ? 'OPEN' : status,
      'phase': phase,
      'days_to_due': daysToDue,
      'overdue_days': overdueDays,
      'reminder_today': false,
      'escalates_on': null,
      'closed_at': null,
      'evidence_count': 1,
      'open_extension': pendingExtension ? <String, Object?>{'id': 'x-1', 'proposed_due_on': '2026-12-30', 'requested_by': 'm-9', 'version': 1} : null,
      'created_by': <String, Object?>{'membership_id': 'm-2', 'display_name': 'Thư ký'},
      'created_at': '2026-10-01T02:00:00Z',
      'version': 3,
    };

final List<Map<String, Object?>> threeDirectives = <Map<String, Object?>>[
  directiveRow('d-1', 'GB-2026-014/CD-01', 'Hoàn thành thủ tục giải phóng mặt bằng đoạn km3.', status: 'OVERDUE', phase: 'ESCALATED', dueOn: '2026-10-29', overdueDays: 10),
  directiveRow('d-2', 'GB-2026-014/CD-02', 'Báo cáo phương án điều chỉnh tổng mức đầu tư.', phase: 'DUE_SOON', dueOn: '2026-11-10', daysToDue: 2, pendingExtension: true),
  directiveRow('d-3', 'GB-2026-014/CD-03', 'Rà soát hồ sơ quyết toán.', status: 'IN_PROGRESS', dueOn: '2026-12-20', person: null, project: null),
];

Map<String, Object?> directivePage(List<Object?> items, {String? next, String asOf = directivesAsOf}) => <String, Object?>{'items': items, 'next_cursor': next, 'as_of': asOf};

Map<String, Object?> directiveSummary({int overdue = 1, int dueSoon = 1, int escalated = 1, int open = 2, bool unverified = true, bool truncated = false}) => <String, Object?>{
      'total': overdue + open,
      'by_status': <String, Object?>{'OPEN': open - 1, 'IN_PROGRESS': 1, 'DONE': 0, 'OVERDUE': overdue, 'CANCELLED': 0},
      'due_soon': dueSoon,
      'escalated': escalated,
      'by_unit': <Object?>[],
      'truncated': truncated,
      'definitions': <String, Object?>{
        'by_status': 'Chỉ đạo đang mở mà hạn trước ngày hôm nay (giờ Việt Nam).',
        'due_soon': 'Chỉ đạo chưa xong có hạn trong 3 ngày tới.',
        'escalated': 'Chỉ đạo quá hạn từ 7 ngày trở lên.',
        'by_unit': 'Theo đơn vị.',
      },
      'policy': <String, Object?>{'code': 'DEFAULT', 'version': null, 'source': 'DEFAULT', 'unverified': unverified},
      'as_of': directivesAsOf,
    };

Map<String, Object?> directiveDetailJson() => <String, Object?>{
      'directive': directiveRow('d-1', 'GB-2026-014/CD-01', 'Hoàn thành thủ tục giải phóng mặt bằng đoạn km3.', status: 'OVERDUE', phase: 'ESCALATED', dueOn: '2026-10-29', overdueDays: 10)..['original_due_on'] = '2026-10-20',
      'timeline': <Object?>[
        <String, Object?>{'id': 'e-1', 'type': 'CREATED', 'actor': <String, Object?>{'membership_id': 'm-2', 'display_name': 'Thư ký'}, 'occurred_at': '2026-10-01T02:00:00Z', 'note': null, 'progress_pct': null, 'from_due_on': null, 'to_due_on': '2026-10-20', 'to_assignee_unit': <String, Object?>{'id': 'u-1', 'code': 'U1', 'name': 'Ban QLDA giao thông'}},
        <String, Object?>{'id': 'e-2', 'type': 'PROGRESS', 'actor': <String, Object?>{'membership_id': 'm-9', 'display_name': 'Nguyễn Văn An'}, 'occurred_at': '2026-10-10T03:30:00Z', 'note': 'Đã gửi hồ sơ cho sở.', 'progress_pct': 40},
        <String, Object?>{'id': 'e-3', 'type': 'EXTENSION_APPROVED', 'actor': <String, Object?>{'membership_id': 'm-5', 'display_name': 'Trần Thị Bình'}, 'occurred_at': '2026-10-19T03:00:00Z', 'note': 'Đồng ý.', 'from_due_on': '2026-10-20', 'to_due_on': '2026-10-29'},
      ],
      'extensions': <Object?>[
        <String, Object?>{
          'id': 'x-1',
          'from_due_on': '2026-10-20',
          'proposed_due_on': '2026-10-29',
          'reason': 'Chờ ý kiến của sở xây dựng.',
          'status': 'APPROVED',
          'requested_by': <String, Object?>{'membership_id': 'm-9', 'display_name': 'Nguyễn Văn An'},
          'requested_at': '2026-10-18T03:00:00Z',
          'decided_by': <String, Object?>{'membership_id': 'm-5', 'display_name': 'Trần Thị Bình'},
          'decided_at': '2026-10-19T03:00:00Z',
          'decision_reason': 'Đồng ý.',
        },
      ],
      'evidence': <Object?>[
        <String, Object?>{'id': 'v-1', 'document_version_id': 'dv-1', 'title': 'Biên bản bàn giao mặt bằng', 'added_by': <String, Object?>{'membership_id': 'm-9', 'display_name': 'Nguyễn Văn An'}, 'added_at': '2026-10-10T03:30:00Z', 'event_id': 'e-2'},
      ],
      'policy': <String, Object?>{'unverified': true},
      'as_of': directivesAsOf,
    };
