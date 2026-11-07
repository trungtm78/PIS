const String asOf = '2026-11-12T03:00:00.000Z';

Map<String, Object?> node(String id, String kind, {String? parent, String? method = 'OPEN_BIDDING', String? step, String? substate, String? terminal, String? label, int? order, int count = 0, String value = '0', int share = 0, double? median, String basis = 'WORKING_DAYS', int late = 0}) => <String, Object?>{
      'id': id,
      'parent_id': parent,
      'kind': kind,
      'method': method,
      'step_code': step,
      'substate': substate,
      'terminal': terminal,
      'label': label,
      'order': order,
      'count': count,
      'value_vnd': value,
      'share_count_bp': share,
      'share_value_bp': share,
      'median_days': median,
      'median_basis': basis,
      'late_count': late,
      'path': <String>['ROOT', id],
      'route': <String>[],
    };

/// Ten packages of one method: one not started, four at "Lập hồ sơ mời thầu" (two late), three at "Đánh giá hồ sơ dự thầu" (one on hold), one completed, one cancelled.
Map<String, Object?> treeJson({int total = 10}) => <String, Object?>{
      'period': <String, Object?>{'from': '2026-10-13', 'to': '2026-11-12'},
      'total': <String, Object?>{'count': total, 'value_vnd': '5000000000'},
      'nodes': total == 0
          ? <Object?>[node('ROOT', 'ROOT', method: null)]
          : <Object?>[
              node('ROOT', 'ROOT', method: null, count: total, value: '5000000000', share: 10000),
              node('M:OPEN_BIDDING', 'METHOD', parent: 'ROOT', label: 'Quy trình đấu thầu rộng rãi', count: 10, value: '5000000000', share: 10000),
              node('T:OPEN_BIDDING:NOT_STARTED', 'TERMINAL', parent: 'M:OPEN_BIDDING', terminal: 'NOT_STARTED', count: 1, value: '300000000', share: 1000),
              node('S:OPEN_BIDDING:DOC_PREPARE', 'STEP', parent: 'M:OPEN_BIDDING', step: 'DOC_PREPARE', label: 'Lập hồ sơ mời thầu', order: 1, count: 4, value: '1800000000', share: 4000, median: 6, late: 2),
              node('S:OPEN_BIDDING:DOC_PREPARE:ON_HOLD', 'SUBSTATE', parent: 'S:OPEN_BIDDING:DOC_PREPARE', step: 'DOC_PREPARE', substate: 'ON_HOLD', order: 1),
              node('S:OPEN_BIDDING:DOC_PREPARE:LATE', 'SUBSTATE', parent: 'S:OPEN_BIDDING:DOC_PREPARE', step: 'DOC_PREPARE', substate: 'LATE', order: 1, count: 2, value: '900000000', share: 2000, late: 2),
              node('S:OPEN_BIDDING:DOC_PREPARE:ON_TRACK', 'SUBSTATE', parent: 'S:OPEN_BIDDING:DOC_PREPARE', step: 'DOC_PREPARE', substate: 'ON_TRACK', order: 1, count: 2, value: '900000000', share: 2000),
              node('S:OPEN_BIDDING:EVALUATE', 'STEP', parent: 'M:OPEN_BIDDING', step: 'EVALUATE', label: 'Đánh giá hồ sơ dự thầu', order: 2, count: 3, value: '1500000000', share: 3000, median: 9.5, basis: 'CALENDAR_DAYS'),
              node('S:OPEN_BIDDING:EVALUATE:ON_HOLD', 'SUBSTATE', parent: 'S:OPEN_BIDDING:EVALUATE', step: 'EVALUATE', substate: 'ON_HOLD', order: 2, count: 1, value: '500000000', share: 1000),
              node('S:OPEN_BIDDING:EVALUATE:ON_TRACK', 'SUBSTATE', parent: 'S:OPEN_BIDDING:EVALUATE', step: 'EVALUATE', substate: 'ON_TRACK', order: 2, count: 2, value: '1000000000', share: 2000),
              node('T:OPEN_BIDDING:COMPLETED', 'TERMINAL', parent: 'M:OPEN_BIDDING', terminal: 'COMPLETED', count: 1, value: '700000000', share: 1000),
              node('T:OPEN_BIDDING:CANCELLED', 'TERMINAL', parent: 'M:OPEN_BIDDING', terminal: 'CANCELLED', count: 1, value: '700000000', share: 1000),
            ],
      'edges': total == 0
          ? <Object?>[]
          : <Object?>[
              <String, Object?>{'from': 'T:OPEN_BIDDING:NOT_STARTED', 'to': 'S:OPEN_BIDDING:DOC_PREPARE', 'kind': 'ADVANCE', 'count': 3},
              <String, Object?>{'from': 'S:OPEN_BIDDING:DOC_PREPARE', 'to': 'S:OPEN_BIDDING:EVALUATE', 'kind': 'ADVANCE', 'count': 2},
              <String, Object?>{'from': 'S:OPEN_BIDDING:EVALUATE', 'to': 'S:OPEN_BIDDING:DOC_PREPARE', 'kind': 'RETURN', 'count': 1},
            ],
      'kpis': <String, Object?>{'running': 7, 'late': 2, 'stalled': 1, 'on_hold': 1, 'no_owner': 1, 'median_days': 6},
      'truncated': false,
      'as_of': asOf,
    };

Map<String, Object?> rowJson(String id, String code, {String title = 'Gói thầu xây lắp', String status = 'IN_PROGRESS', String step = 'DOC_PREPARE', String stepName = 'Lập hồ sơ mời thầu', int order = 1, bool late = false, int lateDays = 0, String? owner = 'Nguyễn Văn An', int days = 5, int left = 3, String value = '450000000', String? holdReason, bool stalled = false}) => <String, Object?>{
      'package_id': id,
      'package_code': code,
      'title': title,
      'value_vnd': value,
      'method': 'OPEN_BIDDING',
      'project': <String, Object?>{'id': 'p-1', 'code': 'DA-001', 'name': 'Đường vành đai 1'},
      'unit': <String, Object?>{'id': 'u-1', 'name': 'Ban QLDA giao thông'},
      'workflow_id': 'w-$id',
      'status': status,
      'step': <String, Object?>{'code': step, 'name': stepName, 'order': order, 'of': 16},
      'visit': 1,
      'entered_on': '2026-11-07',
      'days_in_step': <String, Object?>{'calendar_days': days + 2, 'working_days': days},
      'due_on': '2026-11-15',
      'countdown': <String, Object?>{'days_left': left, 'due_on': '2026-11-15'},
      'late': late,
      'late_days': lateDays,
      'hold_reason': holdReason,
      'owner': owner == null ? null : <String, Object?>{'id': 'm-1', 'name': owner},
      'last_activity_on': '2026-11-10',
      'stalled': stalled,
      'progress_percent': 12,
      'open_required_items': 1,
      'substate': late ? 'LATE' : 'ON_TRACK',
      'sparkline': <Object?>[],
      'version': 3,
      'actions': <String, Object?>{},
    };

Map<String, Object?> rowPage(List<Object?> items, {String? next, bool truncated = false}) => <String, Object?>{'items': items, 'next_cursor': next, 'truncated': truncated, 'as_of': asOf};

Map<String, Object?> person(String name) => <String, Object?>{'id': 'm-$name', 'name': name};

String _vietnamDay(String at) => DateTime.parse(at).toUtc().add(const Duration(hours: 7)).toIso8601String().substring(0, 10);

Map<String, Object?> entryJson(String id, String kind, String at, {String? from, String? to, String? actor, int? working, int? calendar, String? reason, bool change = false, String? subject, List<Object?> evidence = const <Object?>[]}) => <String, Object?>{
      'id': id,
      'kind': kind,
      'at': at,
      'day': _vietnamDay(at),
      'from_step': from,
      'to_step': to,
      'actor': actor == null ? null : person(actor),
      'spent_calendar_days': calendar,
      'spent_working_days': working,
      'reason': reason,
      'evidence': evidence,
      'subject': subject,
      'state_change': change,
    };

List<Object?> stepsJson() => <Object?>[
      <String, Object?>{'code': 'PLAN_SELECTION', 'name': 'Lập kế hoạch lựa chọn nhà thầu', 'order': 1, 'standard_working_days': 10, 'responsible_role': 'PROCUREMENT_OFFICER', 'entry_condition': 'a', 'exit_condition': 'b', 'maker_checker': true, 'evidence_kinds': <Object?>[], 'milestone_kind': null},
      <String, Object?>{'code': 'DOC_PREPARE', 'name': 'Lập hồ sơ mời thầu', 'order': 2, 'standard_working_days': 2, 'responsible_role': 'PROCUREMENT_OFFICER', 'entry_condition': 'a', 'exit_condition': 'b', 'maker_checker': false, 'evidence_kinds': <Object?>[], 'milestone_kind': null},
      <String, Object?>{'code': 'EVALUATE', 'name': 'Đánh giá hồ sơ dự thầu', 'order': 3, 'standard_working_days': 4, 'responsible_role': 'EVALUATION_TEAM', 'entry_condition': 'a', 'exit_condition': 'b', 'maker_checker': true, 'evidence_kinds': <Object?>[], 'milestone_kind': 'EVALUATION_DONE'},
      <String, Object?>{'code': 'RESULT_APPROVE', 'name': 'Phê duyệt kết quả', 'order': 4, 'standard_working_days': 6, 'responsible_role': 'DECISION_AUTHORITY', 'entry_condition': 'a', 'exit_condition': 'b', 'maker_checker': true, 'evidence_kinds': <Object?>[], 'milestone_kind': null},
    ];

/// A package at step 3 of 4 since 4 November, 6 working days in a step whose standard is 4, with one required item open and the step overdue.
/// The timeline (newest day first, as the server sends it): the move into step 3 on the 4th, an item done on the 3rd and the start on the 2nd.
Map<String, Object?> detailJson({String status = 'IN_PROGRESS', bool late = true, bool withWorkflow = true}) => <String, Object?>{
      'package': <String, Object?>{'id': 'k-1', 'code': 'G-001', 'title': 'Gói thầu xây lắp số 1', 'value_vnd': '450000000', 'method': 'OPEN_BIDDING', 'status': 'APPROVED'},
      'project': <String, Object?>{'id': 'p-1', 'code': 'DA-001', 'name': 'Đường vành đai 1'},
      'unit_name': 'Ban QLDA giao thông',
      'workflow': !withWorkflow
          ? null
          : <String, Object?>{
              'id': 'w-1',
              'status': status,
              'step': <String, Object?>{'code': 'EVALUATE', 'name': 'Đánh giá hồ sơ dự thầu', 'visit': 3, 'standard_working_days': 4},
              'owner': person('Nguyễn Văn An'),
              'hold_reason': status == 'ON_HOLD' ? 'Chờ ý kiến chủ đầu tư' : null,
              'held_at': null,
              'started_at': '2026-11-02T01:00:00.000Z',
              'ended_at': null,
              'end_reason': null,
              'last_activity_on': '2026-11-04',
              'definition': <String, Object?>{'rule_version': 0, 'hash': 'h', 'unverified': true},
              'entered_on': '2026-11-04',
              'due_on': '2026-11-10',
              'countdown': <String, Object?>{'days_left': -2, 'due_on': '2026-11-10'},
              'days_in_step': <String, Object?>{'calendar_days': 8, 'working_days': 6},
              'late': late,
              'progress': <String, Object?>{'steps_total': 4, 'steps_done': 2, 'current_order': 3, 'items_required': 2, 'items_required_done': 1, 'percent': 52},
              'blockers': <Object?>[
                <String, Object?>{'reason': 'REQUIRED_ITEMS_OPEN', 'count': 1, 'detail': null},
                <String, Object?>{'reason': 'STEP_OVERDUE', 'count': 2, 'detail': '2026-11-10'},
              ],
              'steps': stepsJson(),
              'checklist': <Object?>[
                <String, Object?>{
                  'id': 'i-1',
                  'code': 'CONFLICT_DECLARED',
                  'name': 'Khai báo không có xung đột lợi ích',
                  'required': true,
                  'status': 'DONE',
                  'due_on': '2026-11-06',
                  'completed_at': '2026-11-05T02:00:00.000Z',
                  'completed_by': person('Trần Thị Bình'),
                  'completed_via': 'PERSON',
                  'owner': null,
                  'evidence_required': true,
                  'allowed_kinds': <Object?>['ATTESTATION'],
                  'milestone_kind': null,
                  'evidence': <Object?>[
                    <String, Object?>{'kind': 'ATTESTATION', 'document_id': null, 'milestone_kind': null, 'reference': 'Đã khai báo'},
                  ],
                  'version': 2,
                },
                <String, Object?>{
                  'id': 'i-2',
                  'code': 'EVALUATION_REPORT',
                  'name': 'Báo cáo đánh giá hồ sơ dự thầu',
                  'required': true,
                  'status': 'OPEN',
                  'due_on': '2026-11-10',
                  'completed_at': null,
                  'completed_by': null,
                  'completed_via': null,
                  'owner': person('Lê Văn Cường'),
                  'evidence_required': true,
                  'allowed_kinds': <Object?>['DOCUMENT'],
                  'milestone_kind': 'EVALUATION_DONE',
                  'evidence': <Object?>[],
                  'version': 1,
                },
              ],
              'exceptions': <Object?>[],
              'history': <Object?>[],
              'links': <String, Object?>{
                'milestones': <Object?>[
                  <String, Object?>{'id': 'ms-1', 'kind': 'BID_OPENING', 'actual_at': '2026-11-04T02:00:00.000Z', 'planned_at': null, 'source': 'IMPORT'},
                ],
                'petitions': <String, Object?>{'total': 1, 'open': 1},
                'result': null,
                'contract': null,
              },
              'timeline': <String, Object?>{
                'days': <Object?>[
                  <String, Object?>{
                    'day': '2026-11-04',
                    'entries': <Object?>[entryJson('e3', 'STATE_CHANGE', '2026-11-04T03:00:00.000Z', from: 'DOC_PREPARE', to: 'EVALUATE', actor: 'Nguyễn Văn An', working: 2, calendar: 2, change: true)],
                    'state_changes': 1,
                    'checklist_done': 0,
                  },
                  <String, Object?>{
                    'day': '2026-11-03',
                    'entries': <Object?>[
                      entryJson('e2', 'CHECKLIST_DONE', '2026-11-03T05:00:00.000Z', actor: 'Trần Thị Bình', subject: 'DOC_DRAFTED', evidence: <Object?>[
                        <String, Object?>{'kind': 'DOCUMENT', 'document_id': 'd-1', 'milestone_kind': null, 'reference': null},
                      ]),
                    ],
                    'state_changes': 0,
                    'checklist_done': 1,
                  },
                  <String, Object?>{
                    'day': '2026-11-02',
                    'entries': <Object?>[entryJson('e1', 'START', '2026-11-02T01:00:00.000Z', to: 'DOC_PREPARE', actor: 'Nguyễn Văn An', change: true)],
                    'state_changes': 1,
                    'checklist_done': 0,
                  },
                ],
                'summary': <Object?>[
                  <String, Object?>{'step_code': 'DOC_PREPARE', 'order': 2, 'days': 2, 'basis': 'WORKING_DAYS', 'standard_working_days': 2, 'days_over': 0, 'current': false},
                  <String, Object?>{'step_code': 'EVALUATE', 'order': 3, 'days': 6, 'basis': 'WORKING_DAYS', 'standard_working_days': 4, 'days_over': 2, 'current': true},
                ],
                'gantt': <Object?>[],
                'empty': false,
                'as_of': asOf,
              },
              'version': 7,
            },
      if (!withWorkflow) 'startable': true,
      if (!withWorkflow) 'definition_steps': stepsJson(),
      'as_of': asOf,
    };
