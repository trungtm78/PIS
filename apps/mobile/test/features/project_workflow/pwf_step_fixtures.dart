/// The members of the step table (PWF-5) that every answer of the workflow may now carry, all optional (R67), as a server of 1.0.15 answers them.
library;

import 'pwf_fixtures.dart';

/// The new members of a task of the workflow: the tier of the colour with its thresholds, the time limit with its unit, the unit that receives the task, whether
/// anybody has taken it, the extension it may be given and the star of the whole file.
Map<String, Object?> stepFields({
  String tier = 'STEP',
  Map<String, Object?>? thresholds,
  Map<String, Object?>? duration,
  int? effective = 6,
  String? unit = 'Phòng Kế hoạch',
  bool unclaimed = false,
  Map<String, Object?>? extension,
  bool overall = false,
  bool withUnit = true,
  bool withExtension = true,
}) =>
    <String, Object?>{
      'band_tier': tier,
      'band_thresholds': thresholds ?? <String, Object?>{'green_days': 5, 'yellow_days': 2, 'red_days': 0},
      'duration': duration ?? <String, Object?>{'value': 10, 'unit': 'WORKING_DAY', 'roll_to_working_day': false},
      'effective_working_days': effective,
      if (withUnit) ...<String, Object?>{
        'receiving_unit_id': '0d000000-0000-4000-8000-000000000001',
        'receiving_unit_name': unit,
        'receiving_units': <Object?>[
          <String, Object?>{'unit_ref': 'PROJECT_OWNER', 'unit_id': '0d000000-0000-4000-8000-000000000001', 'unit_name': unit, 'role': 'Chuyên viên', 'part': 'LEAD'},
        ],
        'unclaimed': unclaimed,
      },
      if (withExtension) 'extension': extension ?? <String, Object?>{'allowed': true, 'max_times': 2, 'max_value': 5, 'unit': 'WORKING_DAY', 'times_used': 1, 'value_used': 2},
      'is_overall_deadline': overall,
    };

/// The deadline of the whole file, as `PwfWorkflowDetail.overall_deadline` carries it.
Map<String, Object?> overallJson({String band = 'YELLOW', int? days = 2, String due = '2026-11-14', String tier = 'POLICY', String id = '7f3a0000-0000-4000-8000-000000000012'}) => <String, Object?>{
      'task_id': id,
      'task_code': 'T-12',
      'task_name': 'Thẩm định kế hoạch lựa chọn nhà thầu',
      'due_on': due,
      'band': band,
      'band_tier': tier,
      'remaining_days': days,
    };
