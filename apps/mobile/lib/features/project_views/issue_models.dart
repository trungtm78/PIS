import '../../core/format/format.dart';
import '../read_support/wire.dart';

/// The counts of one row of the weekly matrix.
final class IssueTotals {
  const IssueTotals({required this.opening, required this.opened, required this.resolved, required this.closing, required this.overdue});

  final int opening;
  final int opened;
  final int resolved;
  final int closing;
  final int overdue;
}

IssueTotals _totals(Json row) => IssueTotals(
      opening: count(row['opening']),
      opened: count(row['opened']),
      resolved: count(row['resolved']),
      closing: count(row['closing']),
      overdue: count(row['overdue']),
    );

/// One unit in one category of issue.
final class IssueRow {
  const IssueRow({required this.unitName, required this.categoryLabel, required this.totals});

  final String unitName;
  final String categoryLabel;
  final IssueTotals totals;
}

/// The issues of a week by unit and by group (`getIssueWeeklyMatrix`): what was open at the start of the week (`opening`),
/// what was raised and what was resolved in it, and what is still open at its end (`closing`, the "backlog").
final class IssueMatrix {
  const IssueMatrix({required this.week, required this.from, required this.to, required this.rows, required this.totals, required this.asOf});

  final String week;
  final String from;
  final String to;
  final List<IssueRow> rows;
  final IssueTotals totals;
  final String asOf;
}

/// The matrix, or null when the answer lacks the week, the rows or the totals.
IssueMatrix? parseIssueMatrix(Object? raw) {
  final Json? body = asRecord(raw);
  final String? week = filled(body?['week']);
  final Json? totals = asRecord(body?['totals']);
  final String? asOf = filled(body?['as_of']);
  if (body == null || week == null || totals == null || asOf == null || body['rows'] is! List) return null;
  final List<IssueRow> rows = <IssueRow>[];
  for (final Object? item in listOf(body['rows'])) {
    final Json? row = asRecord(item);
    if (row == null) continue;
    rows.add(IssueRow(
      unitName: text(asRecord(row['unit'])?['name']) ?? '',
      categoryLabel: text(asRecord(row['category'])?['label']) ?? '',
      totals: _totals(row),
    ));
  }
  return IssueMatrix(week: week, from: text(body['from']) ?? '', to: text(body['to']) ?? '', rows: rows, totals: _totals(totals), asOf: asOf);
}

// ---- the weeks ------------------------------------------------------------------------------------------------------

const int _dayMs = 86400000;
final RegExp _weekPattern = RegExp(r'^(\d{4})-W(\d{2})$');

int _firstMonday(int year) {
  final DateTime fourth = DateTime.utc(year, 1, 4);
  return fourth.millisecondsSinceEpoch - ((fourth.weekday + 6) % 7) * _dayMs;
}

/// The ISO week a Vietnam calendar day lies in (`2026-W44`); the year of a week is the year of its Thursday.
String isoWeekOf(String dayText) {
  final DateTime date = DateTime.parse('${dayText}T00:00:00Z');
  final int thursday = date.millisecondsSinceEpoch - ((date.weekday + 6) % 7) * _dayMs + 3 * _dayMs;
  final int year = DateTime.fromMillisecondsSinceEpoch(thursday, isUtc: true).year;
  final int number = (thursday - _firstMonday(year)) ~/ (7 * _dayMs) + 1;
  return '$year-W${number.toString().padLeft(2, '0')}';
}

/// The Monday of a week named `YYYY-Www`, or null for a name that is not one or a week the year does not have.
String? mondayOf(String week) {
  final RegExpMatch? match = _weekPattern.firstMatch(week);
  if (match == null) return null;
  final int year = int.parse(match.group(1)!);
  final int number = int.parse(match.group(2)!);
  if (year < 2000 || year > 2100 || number < 1 || number > 53) return null;
  final DateTime monday = DateTime.fromMillisecondsSinceEpoch(_firstMonday(year) + (number - 1) * 7 * _dayMs, isUtc: true);
  final String text = monday.toIso8601String().substring(0, 10);
  return isoWeekOf(text) == week ? text : null;
}

/// The week `by` weeks after (before, when negative) the one named; the same week for a name that is not one.
String shiftWeek(String week, int by) {
  final String? monday = mondayOf(week);
  if (monday == null) return week;
  final DateTime moved = DateTime.parse('${monday}T00:00:00Z').add(Duration(days: 7 * by));
  return isoWeekOf(moved.toIso8601String().substring(0, 10));
}

/// The week of the Vietnam calendar day of an instant.
String currentWeek(DateTime now) => isoWeekOf(vietnamDayOf(now));
