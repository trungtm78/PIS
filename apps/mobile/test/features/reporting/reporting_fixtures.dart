import 'package:machvon_mobile/features/reporting/model/report_cells.dart';
import 'package:machvon_mobile/features/reporting/model/report_context.dart';
import 'package:machvon_mobile/features/reporting/model/report_form.dart';

// The fixtures of the weekly report (FX-DIS-001, FX-DIS-002): the six cells 100/200/30/70/0/20 million with the CTMTQG of 40
// million inside the cell of the year plan, central budget; the total is 420 million, not 460.

const String projectId = '7a1f0000-0000-4000-8000-000000000001';
const String periodId = '7a1f0000-0000-4000-8000-000000000002';
const String planId = '7a1f0000-0000-4000-8000-000000000003';
const String reportId = '7a1f0000-0000-4000-8000-000000000004';

const Map<String, String> fx001 = <String, String>{
  'CURRENT_YEAR:CENTRAL': '100000000',
  'CURRENT_YEAR:LOCAL': '200000000',
  'CARRYOVER:CENTRAL': '30000000',
  'CARRYOVER:LOCAL': '70000000',
  'OTHER:CENTRAL': '0',
  'OTHER:LOCAL': '20000000',
};

/// A form that passes the review: FX-DIS-001 in the cells, the four volumes, next month registered.
ReportForm completeForm({String reportType = kWeekly}) {
  ReportForm form = ReportForm(projectId: projectId, periodId: periodId, planVersionId: planId, reportType: reportType, basis: reportType == kMonthly ? 'PERIOD' : 'YTD');
  for (final CellKey key in kCells) {
    form = form.withCell(key, CellEntry(cumulative: fx001[key.id]!, ctmtqg: key.id == 'CURRENT_YEAR:CENTRAL' ? '40000000' : '', nextMonth: '50000000'));
  }
  return form.copyWith(construction: '300000000', acceptance: '250000000', treasury: '200000000', preparing: '10000000', causes: reportType == kMonthly ? 'Mưa kéo dài làm chậm thi công' : '');
}

/// What the choice of the period gave: the project and the period, nothing from the server yet.
const ReportContext chosenOnly = ReportContext(
  projectCode: 'DA-2026-002',
  projectName: 'Đường vành đai 3',
  periodCode: 'W2026-45',
  periodType: 'WEEK',
  periodStart: '2026-10-31',
  periodEnd: '2026-11-06',
  fiscalYear: 2026,
  periodStatus: 'OPEN',
);

/// The same with what the server allocated (the cells: 100 + 200 + 0 + 0 + 50 + 50 million) and what the period before had reached.
ReportContext withReference({Map<String, String>? previous, Map<String, String>? allocated}) => chosenOnly.withReference(
      cells: <String, CellReference>{
        for (final CellKey key in kCells)
          key.id: CellReference(allocated: (allocated ?? _allocated)[key.id]!, previous: (previous ?? const <String, String>{})[key.id]),
      },
      at: '2026-11-03T03:00:00.000Z',
    );

const Map<String, String> _allocated = <String, String>{
  'CURRENT_YEAR:CENTRAL': '500000000',
  'CURRENT_YEAR:LOCAL': '300000000',
  'CARRYOVER:CENTRAL': '0',
  'CARRYOVER:LOCAL': '100000000',
  'OTHER:CENTRAL': '50000000',
  'OTHER:LOCAL': '50000000',
};

/// `GET /reports/{id}` as the server answers it for a draft with [form].
Map<String, Object?> serverReport({
  String id = reportId,
  int version = 1,
  int revision = 1,
  String status = 'DRAFT',
  ReportForm? form,
  Map<String, String>? previous,
  Map<String, String>? allocated,
  String? submittedAt,
  bool isLate = false,
  Map<String, Object?>? review,
  String reportType = kWeekly,
}) {
  final ReportForm entered = form ?? ReportForm(projectId: projectId, periodId: periodId, planVersionId: planId, reportType: reportType);
  final Map<String, String> allocation = allocated ?? _allocated;
  final String cumulative = kCells.fold<BigInt>(BigInt.zero, (BigInt sum, CellKey key) => sum + BigInt.parse(entered.cell(key).cumulative)).toString();
  final String ctmtqg = kCells.fold<BigInt>(BigInt.zero, (BigInt sum, CellKey key) => sum + (entered.cell(key).ctmtqg.isEmpty ? BigInt.zero : BigInt.parse(entered.cell(key).ctmtqg))).toString();
  return <String, Object?>{
    'id': id,
    'revision': revision,
    'status': status,
    'is_current': false,
    'version': version,
    'report_type': reportType,
    'measurement_basis': entered.basis,
    'is_late': isLate,
    'negative_delta_explanation': entered.explanation.isEmpty ? null : entered.explanation,
    'submitted_at': submittedAt,
    'project': <String, Object?>{'id': projectId, 'code': 'DA-2026-002', 'name': 'Đường vành đai 3', 'status': 'IMPLEMENTATION'},
    'period': <String, Object?>{
      'id': periodId,
      'code': reportType == kMonthly ? 'M2026-10' : 'W2026-45',
      'period_type': reportType == kMonthly ? 'MONTH' : 'WEEK',
      'fiscal_year': 2026,
      'start_date': '2026-10-31',
      'end_date': '2026-11-06',
      'status': 'OPEN',
    },
    'plan_version': <String, Object?>{'id': planId, 'fiscal_year': 2026, 'revision': 1, 'status': 'PUBLISHED'},
    'funding_lines': <Object?>[
      for (final CellKey key in kCells)
        <String, Object?>{
          'bucket': key.bucket,
          'budget_level': key.level,
          'allocated_vnd': allocation[key.id],
          'cumulative_vnd': entered.cell(key).cumulative,
          if (entered.cell(key).ctmtqg.isNotEmpty) 'ctmtqg_subset_vnd': entered.cell(key).ctmtqg,
          'next_month_vnd': entered.cell(key).nextMonth,
          if ((previous ?? const <String, String>{})[key.id] != null) 'previous_cumulative_vnd': previous![key.id],
        },
    ],
    'totals': <String, Object?>{'allocated_vnd': '1000000000', 'cumulative_vnd': cumulative, 'ctmtqg_vnd': ctmtqg, 'next_month_vnd': '0', 'next_month_ctmtqg_vnd': '0'},
    'progress': entered.construction.isEmpty
        ? null
        : <String, Object?>{
            'construction_vnd': entered.construction,
            'acceptance_vnd': entered.acceptance,
            'treasury_submitted_vnd': entered.treasury,
            'preparing_dossier_vnd': entered.preparing,
            'as_of_date': '2026-11-06',
            'measurement_basis': entered.basis,
          },
    'narrative': entered.causes.isEmpty && entered.results.isEmpty && entered.linkedIssueIds.isEmpty
        ? null
        : <String, Object?>{'results': entered.results, 'causes': entered.causes, 'solutions': entered.solutions, 'proposals': entered.proposals, if (entered.linkedIssueIds.isNotEmpty) 'linked_issue_ids': entered.linkedIssueIds},
    'attachments': <Object?>[],
    'review': status == 'DRAFT' ? (review ?? <String, Object?>{'blocking': false, 'errors': <Object?>[], 'warnings': <Object?>[]}) : null,
  };
}

/// The periods and the projects the choice of a report is made from.
List<Map<String, Object?>> periodRows() => <Map<String, Object?>>[
      <String, Object?>{'id': periodId, 'code': 'W2026-45', 'period_type': 'WEEK', 'start_date': '2026-10-31', 'end_date': '2026-11-06', 'fiscal_year': 2026, 'status': 'OPEN'},
      <String, Object?>{'id': '7a1f0000-0000-4000-8000-000000000012', 'code': 'W2026-44', 'period_type': 'WEEK', 'start_date': '2026-10-24', 'end_date': '2026-10-30', 'fiscal_year': 2026, 'status': 'LOCKED'},
      <String, Object?>{'id': '7a1f0000-0000-4000-8000-000000000013', 'code': 'M2026-10', 'period_type': 'MONTH', 'start_date': '2026-10-01', 'end_date': '2026-10-31', 'fiscal_year': 2026, 'status': 'SOFT_CLOSED'},
    ];

List<Map<String, Object?>> projectRows() => <Map<String, Object?>>[
      <String, Object?>{'id': projectId, 'code': 'DA-2026-002', 'name': 'Đường vành đai 3'},
      <String, Object?>{'id': '7a1f0000-0000-4000-8000-000000000021', 'code': 'DA-2026-003', 'name': 'Cầu Nhật Tân 2'},
    ];
