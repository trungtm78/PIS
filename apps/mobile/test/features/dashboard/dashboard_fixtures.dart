import 'package:flutter/widgets.dart' show Text;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/features/dashboard/widgets/alert_row.dart';

/// The golden fixtures of the home reads: the same figures as the DIS fixtures FX-DIS-001 and FX-DIS-003.
Map<String, Object?> tile(String metric, {String? value, String? displayValue, String? numerator, String? denominator, String? nullReason, String unit = 'PERCENT', String definition = 'PROPOSED_PENDING_SIGNOFF'}) => <String, Object?>{
      'metric_code': metric,
      'value': value,
      'display_value': displayValue,
      'numerator': numerator,
      'denominator': denominator,
      'null_reason': nullReason,
      'unit': unit,
      'formula': 'disbursed / plan',
      'definition_status': definition,
      'context_token': 'token-$metric',
    };

/// U-BQL1: project 1 disbursed 50 of 100, project 2 disbursed 90 of 900 (millions), so the rate is 140/1000 = 14%, never
/// the average of 50% and 10% (UAT-AC242).
Map<String, Object?> commandCenter({
  String freshness = 'FRESH',
  int projects = 2,
  List<Map<String, Object?>>? tiles,
  String? unitId,
}) =>
    <String, Object?>{
      'snapshot_id': '3f2b6c1e-0000-4000-8000-0000000000a1',
      'as_of_date': '2026-10-31',
      'treasury_cutoff_date': '2026-10-30',
      'freshness': freshness,
      'definition_status': 'PROPOSED_PENDING_SIGNOFF',
      'scope': <String, Object?>{'unit_id': unitId, 'projects': projects, 'scope_hash': 'hash-1'},
      'tiles': tiles ??
          <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', value: '14.0000', numerator: '140000000', denominator: '1000000000'),
            tile('DISBURSEMENT_RATE_TOTAL', value: '12.5000', numerator: '140000000', denominator: '1120000000'),
            tile('DISBURSED_TREASURY', value: '140000000', unit: 'VND'),
          ],
      'projects_without_data': 1,
      'open_warnings': 3,
      'overdue_explanations': 1,
      'pending_reallocations': 2,
      'quality_badge': 'OK',
    };

Map<String, Object?> workItem(String id, String kind, String bucket, {String? dueOn = '2026-11-05', String? original, int late = 0, String screen = 'DIS-03', String title = 'Báo cáo tuần 44'}) => <String, Object?>{
      'id': id,
      'kind': kind,
      'title': title,
      'subtitle': 'Dự án đường vành đai',
      'status': 'OPEN',
      'due_on': dueOn,
      'original_due_on': original ?? dueOn,
      'bucket': bucket,
      'days_late': late,
      'target': <String, Object?>{'screen': screen, 'id': id},
    };

Map<String, Object?> myWork(List<Map<String, Object?>> items, {bool truncated = false}) => <String, Object?>{
      'items': items,
      'counts': <String, Object?>{'total': items.length, 'overdue': items.where((Map<String, Object?> item) => item['bucket'] == 'OVERDUE').length, 'APPROVAL': items.where((Map<String, Object?> item) => item['kind'] == 'APPROVAL').length},
      'next_cursor': null,
      'truncated': truncated,
    };

Map<String, Object?> appropriation(String id, String category, String origin, String amount, {int year = 2026, String status = 'PUBLISHED', String? relation}) => <String, Object?>{
      'id': id,
      'fund_source': <String, Object?>{'version_id': 'v-$id', 'business_key': '$category-$id', 'label': category, 'category': category, 'relation': relation, 'valid_from': '2026-01-01'},
      'origin': origin,
      'plan_year': year,
      'amount_vnd': amount,
      'status': status,
    };

Map<String, Object?> allocationLine(String appropriationId, String ctmtqg, {String status = 'PUBLISHED'}) => <String, Object?>{
      'id': 'line-$appropriationId',
      'plan_status': status,
      'appropriation': <String, Object?>{'id': appropriationId},
      'ctmtqg_subset_vnd': ctmtqg,
    };

Map<String, Object?> page(List<Object?> items, {String? next}) => <String, Object?>{'items': items, 'next_cursor': next};

/// One item of the alert centre (`getMyWork` with the fields of the alert contract). [severity] null leaves the field out, as an
/// older server does.
Map<String, Object?> alertItem(
  String id, {
  String? severity = 'ACTION',
  String source = 'APPROVAL',
  String title = 'Phê duyệt kế hoạch vốn',
  String? dueOn = '2026-11-05',
  bool overdue = false,
  int daysLate = 0,
  String lifecycle = 'NEW',
  Map<String, Object?>? claimedBy,
  Map<String, Object?>? assignee,
  Map<String, Object?>? escalation,
  String? consequence,
  String screen = 'ADM-06',
  Map<String, Object?>? extra,
}) =>
    <String, Object?>{
      'id': id,
      'kind': 'APPROVAL',
      'title': title,
      'subtitle': 'Dự án đường vành đai',
      'status': 'OPEN',
      'due_on': dueOn,
      'original_due_on': dueOn,
      'bucket': overdue ? 'OVERDUE' : 'NEAR',
      'overdue': overdue,
      'days_late': daysLate,
      'target': <String, Object?>{'screen': screen, 'id': id},
      'source': source,
      if (severity != null) 'severity': severity,
      'lifecycle': lifecycle,
      'claimed_by': claimedBy,
      'assignee': assignee,
      'escalation': escalation,
      'consequence': consequence,
      'snoozed_until': null,
      ...?extra,
    };

Map<String, Object?> alertWork(List<Map<String, Object?>> items, {List<String> unavailable = const <String>[], String view = 'scope'}) => <String, Object?>{
      'view': view,
      'items': items,
      'counts': <String, Object?>{
        'urgent': items.where((Map<String, Object?> item) => item['severity'] == 'URGENT').length,
        'action': items.where((Map<String, Object?> item) => item['severity'] == 'ACTION' || item['severity'] == null).length,
        'watch': items.where((Map<String, Object?> item) => item['severity'] == 'WATCH').length,
        'total': items.length,
      },
      'unavailable_sources': unavailable,
      'as_of': '2026-11-03T03:00:00Z',
      'next_cursor': null,
      'truncated': false,
    };

Map<String, Object?> alertCounts({int urgent = 0, int action = 0, int watch = 0}) => <String, Object?>{
      'view': 'mine',
      'counts': <String, Object?>{'urgent': urgent, 'action': action, 'watch': watch, 'total': urgent + action + watch},
      'unavailable_sources': <String>[],
      'as_of': '2026-11-03T03:00:00Z',
    };

/// The answer of `getWorkClockPolicies`: the snooze policy (and a clock policy beside it, as the server sends both).
Map<String, Object?> workClockPolicies({
  List<String> reasons = const <String>['WAITING_INFORMATION', 'WAITING_THIRD_PARTY', 'SCHEDULED_ACTION', 'BLOCKED_BY_OTHER_WORK', 'ON_LEAVE', 'OTHER'],
  List<String> noteRequiredFor = const <String>['OTHER'],
  Map<String, Object?> maxDays = const <String, Object?>{'URGENT': 0, 'ACTION': 5, 'WATCH': 14},
  int maxConsecutive = 2,
  bool finalNotifies = true,
}) =>
    <String, Object?>{
      'policies': <Object?>[
        <String, Object?>{'type': 'CLOCK_POLICY', 'version': 1, 'unverified': true, 'params': <String, Object?>{'claim_hours': 4}},
        <String, Object?>{
          'type': 'SNOOZE_POLICY',
          'version': 3,
          'unverified': true,
          'params': <String, Object?>{
            'reasons': reasons,
            'note_required_for': noteRequiredFor,
            'max_days_by_severity': maxDays,
            'max_consecutive': maxConsecutive,
            'final_notifies_next_level': finalNotifies,
          },
        },
      ],
    };

/// Opens the sheet of the alert in row [index] of the list (the whole alert: its lines and its acts), the way a person does: a tap on the title of the row.
Future<void> openAlertSheet(WidgetTester tester, {int index = 0}) async {
  await tester.tap(find.descendant(of: find.byType(AlertRow).at(index), matching: find.byType(Text)).first);
  await tester.pumpAndSettle();
}
