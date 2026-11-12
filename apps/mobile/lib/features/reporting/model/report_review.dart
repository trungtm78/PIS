import '../../../core/format/format.dart';
import '../../read_support/wire.dart';
import 'report_cells.dart';
import 'report_context.dart';
import 'report_form.dart';

enum Severity { error, warning }

/// One thing the review found: its code, the place on the report it is about (named as the contract names it, so the server's
/// findings and the phone's are read the same way) and the figures it is made of.
final class Finding {
  const Finding({required this.code, required this.field, required this.severity, this.values = const <String, String?>{}, this.blocksSave = false});

  /// A finding the server reported (`review` of `GET /reports/{id}`).
  static Finding? fromServer(Object? raw, Severity severity) {
    final Json? row = asRecord(raw);
    final String? code = text(row?['code']);
    final String? field = text(row?['field']);
    if (row == null || code == null || field == null) return null;
    return Finding(
      code: code,
      field: field,
      severity: severity,
      values: <String, String?>{for (final MapEntry<String, Object?> entry in (asRecord(row['values']) ?? const <String, Object?>{}).entries) entry.key: text(entry.value)},
    );
  }

  final String code;
  final String field;
  final Severity severity;
  final Map<String, String?> values;

  /// The entry cannot even be saved to the server as it is (an amount that is not an amount, a part larger than its whole). The
  /// others only stop the sending.
  final bool blocksSave;

  bool get isError => severity == Severity.error;

}

/// What the server's review of the saved draft says (BR-DIS-07): errors that would stop the sending and warnings that would not.
final class ServerReview {
  const ServerReview({required this.errors, required this.warnings});

  static ServerReview? fromJson(Object? raw) {
    final Json? row = asRecord(raw);
    if (row == null) return null;
    return ServerReview(
      errors: <Finding>[for (final Object? item in listOf(row['errors'])) ?Finding.fromServer(item, Severity.error)],
      warnings: <Finding>[for (final Object? item in listOf(row['warnings'])) ?Finding.fromServer(item, Severity.warning)],
    );
  }

  final List<Finding> errors;
  final List<Finding> warnings;
}

final RegExp _percent = RegExp(r'^[0-9]{1,3}([.,][0-9]{1,2})?$');
// A control character other than the tab and the line breaks makes a text invalid, as the server judges it.
final RegExp _control = RegExp(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]');

String fieldOfCell(CellKey key, String member) => 'funding_lines[${kCells.indexOf(key)}].$member';

/// BR-DIS-01, BR-DIS-03 and BR-DIS-07 as the phone can tell them before the server does, all at once: the entries that are not
/// amounts, a part larger than its whole, the fall that has no explanation, the volumes that are missing and the causes a monthly
/// report needs. [context] is the allocation and the previous figures when the server has given them; without them the rules that
/// need them (a fall, the volume against the allocation) are left to the server. The server remains the authority.
List<Finding> reviewForm(ReportForm form, ReportContext? context) {
  final List<Finding> found = <Finding>[];
  void error(String code, String field, {Map<String, String?> values = const <String, String?>{}, bool blocksSave = false}) =>
      found.add(Finding(code: code, field: field, severity: Severity.error, values: values, blocksSave: blocksSave));
  void warn(String code, String field, Map<String, String?> values) => found.add(Finding(code: code, field: field, severity: Severity.warning, values: values));

  for (final CellKey key in kCells) {
    final CellEntry entry = form.cell(key);
    _amount(entry.cumulative, fieldOfCell(key, 'cumulative_vnd'), mustHave: true, error: error);
    _amount(entry.nextMonth, fieldOfCell(key, 'next_month_vnd'), mustHave: true, error: error);
    _part(key, entry.ctmtqg, entry.cumulative, 'ctmtqg_subset_vnd', error);
    _part(key, entry.nextCtmtqg, entry.nextMonth, 'next_month_ctmtqg_subset_vnd', error);
  }
  final String words = form.explanation.trim();
  if (words.isNotEmpty && (words.length < kExplanationMin || words.length > kExplanationMax || _control.hasMatch(words))) {
    error('EXPLANATION_INVALID', 'negative_delta_explanation', blocksSave: true);
  }
  final bool fall = hasFall(form, context);
  if (fall && words.isEmpty) error('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation');

  final Map<String, String> volumes = <String, String>{
    'construction_vnd': form.construction,
    'acceptance_vnd': form.acceptance,
    'treasury_submitted_vnd': form.treasury,
    'preparing_dossier_vnd': form.preparing,
  };
  bool missingVolume = false;
  for (final MapEntry<String, String> volume in volumes.entries) {
    if (volume.value.trim().isEmpty) {
      missingVolume = true;
    } else if (digitsOf(volume.value) == null) {
      error('VOLUME_INVALID', 'progress.${volume.key}', blocksSave: true);
    }
  }
  if (missingVolume) error('VALIDATION_FAILED', 'progress', values: const <String, String?>{'missing': 'construction_vnd'});
  final String percent = form.percent.trim();
  if (percent.isNotEmpty) {
    if (!_percent.hasMatch(percent)) {
      error('PERCENT_INVALID', 'progress.physical_progress_pct', blocksSave: true);
    } else if (double.parse(percent.replaceAll(',', '.')) > 100) {
      error('PERCENT_RANGE', 'progress.physical_progress_pct', blocksSave: true);
    }
  }
  for (final MapEntry<String, String> note in <String, String>{'results': form.results, 'causes': form.causes, 'solutions': form.solutions, 'proposals': form.proposals}.entries) {
    if (note.value.trim().length > kNoteMax) error('NARRATIVE_TOO_LONG', 'narrative.${note.key}', blocksSave: true);
  }
  if (form.isMonthly && form.causes.trim().isEmpty) error('VALIDATION_FAILED', 'narrative.causes_text', values: const <String, String?>{'missing': 'causes_text'});

  _warnings(form, context, fall: fall, words: words, warn: warn);
  return found;
}

void _amount(String typed, String field, {required bool mustHave, required void Function(String code, String field, {Map<String, String?> values, bool blocksSave}) error}) {
  if (typed.trim().isEmpty) {
    if (mustHave) error('CELL_REQUIRED', field, blocksSave: true);
  } else if (digitsOf(typed) == null) {
    error('CELL_INVALID', field, blocksSave: true);
  }
}

void _part(CellKey key, String subset, String whole, String member, void Function(String code, String field, {Map<String, String?> values, bool blocksSave}) error) {
  if (subset.trim().isEmpty) return;
  final String field = fieldOfCell(key, member);
  final String? part = digitsOf(subset);
  if (!takesCtmtqg(key.bucket)) {
    error('CTMTQG_NOT_ALLOWED', field, blocksSave: true);
  } else if (part == null) {
    error('CELL_INVALID', field, blocksSave: true);
  } else {
    final String? parent = digitsOf(whole);
    if (parent != null && BigInt.parse(part) > BigInt.parse(parent)) {
      error('SUBSET_EXCEEDS_PARENT', field, values: <String, String?>{'parent_vnd': parent, 'subset_vnd': part}, blocksSave: true);
    }
  }
}

/// What a cell added since the period before, as typed; null when there is nothing to compare with or the entry is not an amount.
String? deltaOf(CellReference? reference, String typed) {
  final String? now = digitsOf(typed);
  final String? previous = reference?.previous;
  if (now == null || previous == null) return null;
  return differenceDong(now, previous);
}

/// A fall in any cell has to be explained when the report is handed in (BR-DIS-03).
bool hasFall(ReportForm form, ReportContext? context) {
  if (context == null) return false;
  return kCells.any((CellKey key) => deltaOf(context.reference(key), form.cell(key).cumulative)?.startsWith('-') ?? false);
}

/// The warnings the phone can work out without the Treasury: a fall that is explained, a volume above what was allocated and an
/// empty registration while capital is left. The gap with the Treasury is the server's.
void _warnings(ReportForm form, ReportContext? context, {required bool fall, required String words, required void Function(String code, String field, Map<String, String?> values) warn}) {
  if (context == null || !context.hasReference) return;
  final String allocated = context.allocatedTotal!;
  if (fall && words.isNotEmpty) {
    final BigInt total = kCells.fold(BigInt.zero, (BigInt sum, CellKey key) {
      final String? delta = deltaOf(context.reference(key), form.cell(key).cumulative);
      return delta != null && delta.startsWith('-') ? sum + BigInt.parse(delta) : sum;
    });
    warn('NEGATIVE_DELTA', 'negative_delta_explanation', <String, String?>{'delta_vnd': total.toString()});
  }
  final String? construction = digitsOf(form.construction);
  if (construction != null && BigInt.parse(construction) > BigInt.parse(allocated)) {
    warn('VOLUME_EXCEEDS_ALLOCATION', 'progress.construction_vnd', <String, String?>{
      'construction_vnd': construction,
      'allocated_vnd': allocated,
      'ratio_pct': percentOf(BigInt.parse(construction), BigInt.parse(allocated)),
    });
  }
  final BigInt cumulative = BigInt.parse(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]));
  final BigInt nextMonth = BigInt.parse(sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).nextMonth]));
  if (nextMonth == BigInt.zero && BigInt.parse(allocated) > cumulative) {
    warn('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', 'funding_lines', <String, String?>{'remaining_vnd': (BigInt.parse(allocated) - cumulative).toString()});
  }
}

/// `numerator / denominator` as a percent with one decimal, rounded half up (`203.8`); null when the denominator is zero.
String? percentOf(BigInt numerator, BigInt denominator) {
  if (denominator == BigInt.zero) return null;
  final BigInt tenths = (numerator * BigInt.from(2000) + denominator) ~/ (BigInt.two * denominator);
  return '${tenths ~/ BigInt.from(10)}.${tenths % BigInt.from(10)}';
}

final RegExp _fundingField = RegExp(r'^funding_lines\[(\d)\]\.(\w+)$');

/// The cell a finding is about, when its field names one.
CellKey? cellOfFinding(Finding finding) {
  final RegExpMatch? matched = _fundingField.firstMatch(finding.field);
  if (matched == null) return null;
  final int index = int.parse(matched.group(1)!);
  return index < kCells.length ? kCells[index] : null;
}

/// The screen where a finding is put right; null for what no step of the draft can change (the period, the plan version, the
/// state of the report).
String? screenOfFinding(Finding finding) {
  if (finding.field.startsWith('progress')) return 'MOB-14';
  if (finding.field.startsWith('narrative')) return 'MOB-55';
  final RegExpMatch? matched = _fundingField.firstMatch(finding.field);
  if (matched != null) {
    final int index = int.parse(matched.group(1)!);
    if (index >= kCells.length) return null;
    return matched.group(2)!.startsWith('next_month') ? 'MOB-18' : kScreenOfBucket[kCells[index].bucket];
  }
  if (finding.field == 'funding_lines') return finding.code == 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT' ? 'MOB-18' : 'MOB-15';
  if (finding.field == 'negative_delta_explanation') return 'MOB-15';
  return null;
}
