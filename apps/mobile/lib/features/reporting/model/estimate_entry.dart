import 'package:machvon_api_client/machvon_api_client.dart';

import '../../read_support/wire.dart';
import 'report_cells.dart';

const int kAssumptionMax = 2000;
const int kReasonMax = 2000;

/// The thirteen months of the plan year: the twelve months and the month of adjustment (CAP 3.1 F7).
const int kAdjustmentMonth = 13;

/// The estimate of the disbursement at the end of a month that a person is entering (CAP-13, MOB-56): the month, the source, the
/// amount of whole dong and the assumption it rests on. An estimate is a promise like a registration; it is shown beside what was
/// registered and what the Treasury paid and is never added to it.
final class EstimateEntry {
  const EstimateEntry({this.month = '', this.source = 'CURRENT_YEAR:CENTRAL', this.amount = '', this.assumption = '', this.reason = ''});

  factory EstimateEntry.fromJson(Map<String, Object?> json) => EstimateEntry(
        month: text(json['month']) ?? '',
        source: text(json['source']) ?? 'CURRENT_YEAR:CENTRAL',
        amount: text(json['amount']) ?? '',
        assumption: text(json['assumption']) ?? '',
        reason: text(json['reason']) ?? '',
      );

  final String month;

  /// A cell id (`CURRENT_YEAR:CENTRAL`): the source and the budget the estimate is for.
  final String source;
  final String amount;
  final String assumption;
  final String reason;

  bool get isEmpty => month.isEmpty && amount.isEmpty && assumption.isEmpty && reason.isEmpty;

  CellKey get cell => kCells.firstWhere((CellKey key) => key.id == source, orElse: () => kCells.first);

  EstimateEntry copyWith({String? month, String? source, String? amount, String? assumption, String? reason}) => EstimateEntry(
        month: month ?? this.month,
        source: source ?? this.source,
        amount: amount ?? this.amount,
        assumption: assumption ?? this.assumption,
        reason: reason ?? this.reason,
      );

  Map<String, Object?> toJson() => <String, Object?>{'month': month, 'source': source, 'amount': amount, 'assumption': assumption, 'reason': reason};
}

enum EstimateProblem { monthRequired, amountRequired, amountInvalid, assumptionRequired, assumptionTooLong, assumptionInvalid, reasonTooLong }

// A tab or a line break is not a control character here, as the server judges the text.
final RegExp _control = RegExp(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]');

int? monthOfEntry(String value) {
  final int? month = RegExp(r'^\d{1,2}$').hasMatch(value) ? int.parse(value) : null;
  return month != null && month >= 1 && month <= kAdjustmentMonth ? month : null;
}

/// What is wrong with an estimate before anything is sent; the server judges the same rules again. An estimate says what it rests
/// on, so the assumption is not optional.
Map<String, EstimateProblem> reviewEstimate(EstimateEntry entry) {
  final Map<String, EstimateProblem> problems = <String, EstimateProblem>{};
  if (monthOfEntry(entry.month) == null) problems['month'] = EstimateProblem.monthRequired;
  if (entry.amount.trim().isEmpty) {
    problems['amount'] = EstimateProblem.amountRequired;
  } else if (digitsOf(entry.amount) == null) {
    problems['amount'] = EstimateProblem.amountInvalid;
  }
  final String words = entry.assumption.trim();
  if (words.isEmpty) {
    problems['assumption'] = EstimateProblem.assumptionRequired;
  } else if (words.length > kAssumptionMax) {
    problems['assumption'] = EstimateProblem.assumptionTooLong;
  } else if (_control.hasMatch(words)) {
    problems['assumption'] = EstimateProblem.assumptionInvalid;
  }
  if (entry.reason.trim().length > kReasonMax) problems['reason'] = EstimateProblem.reasonTooLong;
  return problems;
}

/// The body of `registerDisbursementSchedule` for an estimate that passed [reviewEstimate]: one month, one source, the amount as exact dong.
CapScheduleInput estimateBody(EstimateEntry entry, {required String projectId, required int planYear}) {
  final String reason = entry.reason.trim();
  return CapScheduleInput(
    projectId: projectId,
    planYear: planYear,
    granularity: 'MONTH',
    month: monthOfEntry(entry.month),
    kind: 'FORECAST',
    bucket: entry.cell.bucket,
    budgetLevel: entry.cell.level,
    amountVnd: digitsOf(entry.amount)!,
    assumption: entry.assumption.trim(),
    revisionReason: reason.isEmpty ? null : reason,
  );
}
