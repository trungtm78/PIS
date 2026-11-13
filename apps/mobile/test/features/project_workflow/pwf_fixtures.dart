/// The JSON the workflow screens read, as the server answers it (`openapi.json`: `PwfWorkflowDetail`, `PwfTaskDetail`, `PwfMyTaskPage`,
/// `PwfDeadlinePreference`, `MyStaffScorePage`), and the state of one task on a fake server, so a test can move it the way another person would.
library;

const String kProjectId = '3b1c2f10-0000-4000-8000-000000000001';
const String kTaskId = '7f3a0000-0000-4000-8000-000000000011';
const String kAsOf = '2026-11-12T03:00:00Z';

Map<String, Object?> band(String kind, {int? days, String unit = 'WORKING', String? reason}) => <String, Object?>{
      'band': kind,
      'remaining_days': days,
      'unit': unit,
      'overdue': days != null && days < 0,
      if (reason != null) 'reason': reason,
    };

Map<String, Object?> taskRow(
  String id,
  String name, {
  String phase = 'P2',
  String status = 'IN_PROGRESS',
  Map<String, Object?>? official,
  String? finish = '2026-11-14',
  String kind = 'TASK',
  bool required = true,
  bool excluded = false,
  String? assignee = 'Trần Văn B',
  int version = 3,
  int? missingYear,
}) =>
    <String, Object?>{
      'id': id,
      'task_code': 'T-${id.substring(id.length - 2)}',
      'name': name,
      'phase_code': phase,
      'kind': kind,
      'required': required,
      'priority': 'NORMAL',
      'status': status,
      'excluded': excluded,
      'tracked': true,
      'state': 'SCHEDULED',
      'planned_start': '2026-11-01',
      'planned_finish': finish,
      'baseline_finish': finish,
      'missing_year': missingYear,
      'total_float': 0,
      'critical': false,
      'band': official ?? band('YELLOW', days: 2),
      'assignee': assignee == null ? null : <String, Object?>{'membership_id': '9d000000-0000-4000-8000-000000000001', 'display_name': assignee},
      'return_count': 0,
      'version': version,
    };

/// A workflow with three stages: the first done, the second open, the third not started.
Map<String, Object?> workflowJson({bool unverified = false, String status = 'ACTIVE', List<Map<String, Object?>>? tasks, Map<String, Object?>? counts}) => <String, Object?>{
      'id': '5e000000-0000-4000-8000-000000000001',
      'project_id': kProjectId,
      'template_code': 'PUBLIC_INVESTMENT',
      'template_rule_version': 1,
      'template_hash': 'abc',
      'unverified': unverified,
      'status': status,
      'planned_start_date': '2026-09-01',
      'schedule_version': 1,
      'adopted_on': null,
      'open_phase': 'P2',
      'phases': <Object?>[
        <String, Object?>{'code': 'P1', 'name': 'Chuẩn bị đầu tư', 'order': 1, 'gates': <Object?>[], 'required_total': 3, 'required_done': 3, 'open': false},
        <String, Object?>{'code': 'P2', 'name': 'Thực hiện đầu tư', 'order': 2, 'gates': <Object?>[], 'required_total': 4, 'required_done': 1, 'open': true},
        <String, Object?>{'code': 'P3', 'name': 'Kết thúc đầu tư', 'order': 3, 'gates': <Object?>[], 'required_total': 2, 'required_done': 0, 'open': false},
      ],
      'tasks': tasks ??
          <Object?>[
            taskRow('7f3a0000-0000-4000-8000-000000000001', 'Quyết định chủ trương đầu tư', phase: 'P1', status: 'DONE', official: band('NONE', reason: 'NO_DUE'), finish: '2026-09-20'),
            taskRow('7f3a0000-0000-4000-8000-000000000011', 'Lập hồ sơ mời thầu gói thầu xây lắp', official: band('RED', days: -2), finish: '2026-11-10'),
            taskRow('7f3a0000-0000-4000-8000-000000000012', 'Thẩm định kế hoạch lựa chọn nhà thầu', official: band('YELLOW', days: 2), finish: '2026-11-14', assignee: null),
            taskRow('7f3a0000-0000-4000-8000-000000000013', 'Ký hợp đồng thi công', official: band('GREEN', days: 9), finish: '2026-11-23', kind: 'MILESTONE'),
            taskRow('7f3a0000-0000-4000-8000-000000000014', 'Nghiệm thu giai đoạn 1', official: band('UNKNOWN', reason: 'CALENDAR_UNAVAILABLE'), finish: null, missingYear: 2027),
            taskRow('7f3a0000-0000-4000-8000-000000000021', 'Quyết toán dự án', phase: 'P3', status: 'NOT_STARTED', official: band('NONE', reason: 'FAR'), finish: '2027-03-01'),
            taskRow('7f3a0000-0000-4000-8000-000000000099', 'Việc của nhánh không có', phase: 'P3', status: 'NOT_STARTED', excluded: true),
          ],
      'gates': <Object?>[],
      'counts_by_band': counts ?? <String, Object?>{'NONE': 2, 'GREEN': 1, 'YELLOW': 1, 'RED': 1, 'UNKNOWN': 1},
      'can_manage': false,
      'can_propose_reschedule': false,
      'version': 4,
      'as_of': kAsOf,
    };

/// The state of one task on the fake server.
class TaskState {
  TaskState({this.status = 'IN_PROGRESS', this.version = 3, this.checklistDone = const <String>{}, this.canApprove = false, this.assignee = true, this.approverRole = 'Chủ trì'});

  String status;
  int version;
  Set<String> checklistDone;
  bool canApprove;
  bool assignee;
  String? approverRole;
  final List<Map<String, Object?>> evidence = <Map<String, Object?>>[];
  final List<Map<String, Object?>> exceptions = <Map<String, Object?>>[];

  bool get inProgress => status == 'IN_PROGRESS';
}

Map<String, Object?> taskDetailJson(TaskState state, {Map<String, Object?>? official, List<Map<String, Object?>>? blockers, bool withChecklist = true}) {
  final bool mine = state.assignee;
  return <String, Object?>{
    ...taskRow(kTaskId, 'Lập hồ sơ mời thầu gói thầu xây lắp', status: state.status, official: official ?? band('RED', days: -2), finish: '2026-11-10', version: state.version),
    'responsible_role': 'Chuyên viên đấu thầu',
    'approver_role': state.approverRole,
    'duration_working_days': 10,
    'baseline_start': '2026-11-01',
    'finish_variance_days': 2,
    'late_start': null,
    'late_finish': null,
    'free_float': 0,
    'actual_start': state.status == 'NOT_STARTED' ? null : '2026-11-02',
    'actual_finish': state.status == 'DONE' ? '2026-11-11' : null,
    'remaining_working_days': 3,
    'percent_complete': 40,
    'reschedule_count': 0,
    'estimate_vnd': null,
    'actual_vnd': null,
    'milestone_id': null,
    'predecessors': <Object?>[],
    'checklist': withChecklist
        ? <Object?>[
            <String, Object?>{'item_code': 'C1', 'name': 'Dự thảo hồ sơ mời thầu', 'required': true, 'evidence_kinds': <Object?>[], 'done': state.checklistDone.contains('C1'), 'done_by': null, 'done_at': null},
            <String, Object?>{'item_code': 'C2', 'name': 'Biên bản họp tổ chuyên gia', 'required': true, 'evidence_kinds': <Object?>['DOCUMENT'], 'done': state.checklistDone.contains('C2'), 'done_by': null, 'done_at': null},
          ]
        : <Object?>[],
    'legal_doc_types': <Object?>[
      <String, Object?>{'code': 'INVESTMENT_DECISION', 'satisfied': true},
      <String, Object?>{'code': 'BID_PLAN', 'satisfied': false},
    ],
    'form_templates': <Object?>[<String, Object?>{'code': 'FORM_BID', 'satisfied': false, 'document_id': null}],
    'evidence': state.evidence,
    'completion': <String, Object?>{
      'ok': (blockers ?? const <Map<String, Object?>>[]).isEmpty,
      'blockers': blockers ?? <Object?>[],
      'coverable': <Object?>[],
    },
    'exceptions': state.exceptions,
    'assignments': <Object?>[],
    'history': <Object?>[
      <String, Object?>{'id': 'h1', 'kind': 'START', 'at': '2026-11-02T01:00:00Z', 'actor': null, 'reason': null},
      <String, Object?>{'id': 'h2', 'kind': 'RETURNED', 'at': '2026-11-05T02:30:00Z', 'actor': null, 'reason': 'Thiếu phụ lục kỹ thuật'},
    ],
    'can_start': mine && state.status == 'NOT_STARTED',
    'can_complete': mine && state.status == 'IN_PROGRESS',
    'can_approve': state.canApprove && state.status == 'AWAITING_APPROVAL',
    'can_return': state.canApprove && state.status == 'AWAITING_APPROVAL',
    'can_request_exception': mine && (state.status == 'IN_PROGRESS' || state.status == 'NOT_STARTED'),
    'can_resume': mine && state.status == 'ON_HOLD',
    'can_assign': false,
    'as_of': kAsOf,
  };
}

Map<String, Object?> myTask(
  String id,
  String name, {
  Map<String, Object?>? official,
  Map<String, Object?>? personal,
  String? due = '2026-11-14',
  String status = 'IN_PROGRESS',
  String project = 'DA-CB-017',
  int version = 3,
}) =>
    <String, Object?>{
      'task_id': id,
      'task_code': 'T-${id.substring(id.length - 2)}',
      'name': name,
      'project_id': kProjectId,
      'project_code': project,
      'status': status,
      'due_date': due,
      'official_band': official ?? band('GREEN', days: 4),
      'personal_band': personal ?? official ?? band('GREEN', days: 4),
      'critical': false,
      'version': version,
    };

Map<String, Object?> myTasksJson({List<Map<String, Object?>>? items, String? next, int? total}) {
  final List<Map<String, Object?>> rows = items ??
      <Map<String, Object?>>[
        // Official yellow, but the person asked to be told earlier, so their band is red.
        myTask('7f3a0000-0000-4000-8000-000000000031', 'Trình thẩm định báo cáo nghiên cứu khả thi', official: band('YELLOW', days: 2), personal: band('RED', days: 2), due: '2026-11-14'),
        myTask('7f3a0000-0000-4000-8000-000000000032', 'Nộp báo cáo giải ngân tháng 10', official: band('RED', days: -1), personal: band('RED', days: -1), due: '2026-11-11', project: 'DA-CB-023'),
        myTask('7f3a0000-0000-4000-8000-000000000033', 'Cập nhật kế hoạch vốn năm 2027', official: band('GREEN', days: 6), personal: band('YELLOW', days: 6), due: '2026-11-20'),
        myTask('7f3a0000-0000-4000-8000-000000000034', 'Lập báo cáo đánh giá dự án', official: band('NONE', reason: 'FAR'), personal: band('NONE', reason: 'FAR'), due: '2027-01-15'),
        myTask('7f3a0000-0000-4000-8000-000000000035', 'Hồ sơ đã nộp', status: 'DONE', official: band('NONE', reason: 'NO_DUE'), due: '2026-11-05'),
      ];
  return <String, Object?>{'items': rows, 'next_cursor': next, 'total': total ?? rows.length, 'as_of': kAsOf};
}

Map<String, Object?> preferenceJson({int? green, int? yellow, int? red, List<int> reminders = const <int>[], int version = 2, List<String> clamped = const <String>[]}) => <String, Object?>{
      'green_days': green,
      'yellow_days': yellow,
      'red_days': red,
      'reminder_days': reminders,
      'official': <String, Object?>{'green_days': 5, 'yellow_days': 2, 'red_days': 0},
      'clamped': clamped,
      'version': version,
      'as_of': kAsOf,
    };

Map<String, Object?> scoreItem({String state = 'RATED', double? computed = 82.5, double? adjusted, String? rating = 'Tốt', int rated = 6, bool canRespond = true, String periodStatus = 'LOCKED'}) => <String, Object?>{
      'period': <String, Object?>{
        'id': 'p0000000-0000-4000-8000-000000000001',
        'scope_unit_id': 'u0000000-0000-4000-8000-000000000001',
        'period_kind': 'QUARTER',
        'period_from': '2026-07-01',
        'period_to': '2026-09-30',
        'status': periodStatus,
        'policy_code': 'STAFF_SCORING_DEFAULT',
        'policy_rule_id': null,
        'policy_version': 1,
        'snapshot_hash': 'ff',
        'locked_by': null,
        'locked_at': null,
        'response_until': '2026-11-30',
        'official_at': null,
        'supersedes_period_id': null,
        'line_count': 12,
        'open_response_count': 0,
        'version': 2,
        'as_of': kAsOf,
      },
      'line': <String, Object?>{
        'id': 'l0000000-0000-4000-8000-000000000001',
        'period_id': 'p0000000-0000-4000-8000-000000000001',
        'membership_id': 'm0000000-0000-4000-8000-000000000001',
        'display_name': 'Nguyễn Văn An',
        'unit_id_at_period': 'u0000000-0000-4000-8000-000000000001',
        'score_computed': computed,
        'score_adjusted': adjusted,
        'rating': rating,
        'state': state,
        'rated_task_count': rated,
        'effective_weight': 7.5,
        'period_status': periodStatus,
        'contributions': <Object?>[
          <String, Object?>{'task_code': 'T-11', 'task_id': null, 'name': 'Lập hồ sơ mời thầu', 'fraction': 1, 'weight': 2, 'score': 90, 'spans': <Object?>[]},
          <String, Object?>{'task_code': 'T-12', 'task_id': null, 'name': 'Thẩm định kế hoạch', 'fraction': 0.5, 'weight': 1, 'score': 70, 'spans': <Object?>[]},
        ],
        'excluded': <Object?>[
          <String, Object?>{'task_code': 'T-13', 'reason': 'Tạm dừng được duyệt'},
        ],
        'adjustments': adjusted == null
            ? <Object?>[]
            : <Object?>[
                <String, Object?>{'id': 'a1', 'line_id': 'l1', 'points': 2.5, 'reason': 'Việc phát sinh ngoài kế hoạch', 'evidence_ref': null, 'status': 'APPROVED', 'requested_by': 'x', 'decided_by': 'y', 'decided_at': null, 'version': 1},
              ],
        'responses': <Object?>[
          <String, Object?>{'id': 'r1', 'line_id': 'l1', 'body': 'Hai việc bị tính trễ do chờ ý kiến của Sở.', 'status': 'OPEN', 'submitted_at': '2026-10-20T03:00:00Z', 'handled_by': null, 'handled_at': null, 'conclusion': null, 'approval_instance_id': null},
        ],
        'basis': <String, Object?>{'policy_code': 'STAFF_SCORING_DEFAULT', 'policy_version': 1, 'snapshot_hash': 'ff'},
        'can_request_adjustment': false,
        'can_respond': canRespond,
        'version': 3,
        'as_of': kAsOf,
      },
    };

Map<String, Object?> scoresJson({List<Map<String, Object?>>? items}) => <String, Object?>{'items': items ?? <Object?>[scoreItem()], 'next_cursor': null, 'as_of': kAsOf};
