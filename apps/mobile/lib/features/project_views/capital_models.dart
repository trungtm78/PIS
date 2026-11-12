import '../../core/format/format.dart';
import '../read_support/wire.dart';

/// A capital plan the reader may see, as the choice of the screen lists it.
final class PlanChoice {
  const PlanChoice({required this.id, required this.code, required this.year, required this.revision, required this.published});

  final String id;
  final String code;
  final int? year;
  final int revision;
  final bool published;
}

/// A plan of the register, or null when the row is not one.
PlanChoice? parsePlanChoice(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = text(row?['plan_code']);
  final String? status = text(row?['status']);
  if (row == null || id == null || code == null || status == null) return null;
  return PlanChoice(id: id, code: code, year: whole(row['plan_year']), revision: whole(row['revision']) ?? 1, published: status == 'PUBLISHED');
}

/// The plan to open when the reader named none: the published plan of the newest year, its newest revision.
PlanChoice? defaultPlan(List<PlanChoice> plans) {
  final List<PlanChoice> published = <PlanChoice>[for (final PlanChoice plan in plans) if (plan.published) plan];
  if (published.isEmpty) return null;
  published.sort((PlanChoice a, PlanChoice b) => (b.year ?? 0).compareTo(a.year ?? 0) != 0 ? (b.year ?? 0).compareTo(a.year ?? 0) : b.revision.compareTo(a.revision));
  return published.first;
}

/// One line of a plan: a project's share of one fund source. The amount already holds its CTMTQG part, so the part is shown
/// as "of which" and never added.
final class CapitalLine {
  const CapitalLine({
    required this.id,
    required this.projectCode,
    required this.projectName,
    required this.sourceKey,
    required this.sourceLabel,
    required this.allocatedVnd,
    required this.ctmtqgVnd,
    this.disbursedVnd,
  });

  final String id;
  final String projectCode;
  final String projectName;
  final String sourceKey;
  final String sourceLabel;
  final String allocatedVnd;
  final String ctmtqgVnd;

  /// What was disbursed, or null when the answer does not say: "no figure", which is not zero.
  final String? disbursedVnd;
}

CapitalLine? _line(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? project = asRecord(row?['project']);
  final Json? source = asRecord(row?['fund_source']);
  final String? id = filled(row?['id']);
  final String? sourceKey = filled(source?['business_key']);
  final String? allocated = unsignedDong(row?['amount_vnd']);
  if (row == null || id == null || project == null || sourceKey == null || allocated == null) return null;
  return CapitalLine(
    id: id,
    projectCode: text(project['code']) ?? '',
    projectName: text(project['name']) ?? '',
    sourceKey: sourceKey,
    sourceLabel: filled(source?['label']) ?? sourceKey,
    allocatedVnd: allocated,
    ctmtqgVnd: unsignedDong(row['ctmtqg_subset_vnd']) ?? '0',
    disbursedVnd: unsignedDong(row['disbursed_vnd']),
  );
}

/// The lines of one fund source: what was allocated, the part of it that is CTMTQG, and what was disbursed.
final class SourceTotals {
  const SourceTotals({required this.key, required this.label, required this.lines, required this.allocatedVnd, required this.ctmtqgVnd, required this.disbursedVnd});

  final String key;
  final String label;
  final List<CapitalLine> lines;
  final String allocatedVnd;
  final String ctmtqgVnd;

  /// The sum of the disbursements that are known; null when none of the lines says.
  final String? disbursedVnd;
}

/// A plan with its lines in the scope of the reader.
final class CapitalPlan {
  const CapitalPlan({this.plan, required this.plans, required this.lines, required this.truncated, this.asOf});

  /// The plan whose lines are shown; null when the reader may see no published plan.
  final PlanChoice? plan;
  final List<PlanChoice> plans;
  final List<CapitalLine> lines;
  final bool truncated;
  final String? asOf;

  /// The lines by fund source, in the order the sources first appear.
  List<SourceTotals> get bySource {
    final Map<String, List<CapitalLine>> grouped = <String, List<CapitalLine>>{};
    for (final CapitalLine line in lines) {
      grouped.putIfAbsent(line.sourceKey, () => <CapitalLine>[]).add(line);
    }
    return <SourceTotals>[
      for (final MapEntry<String, List<CapitalLine>> entry in grouped.entries)
        SourceTotals(
          key: entry.key,
          label: entry.value.first.sourceLabel,
          lines: entry.value,
          allocatedVnd: sumDong(<String>[for (final CapitalLine line in entry.value) line.allocatedVnd]),
          ctmtqgVnd: sumDong(<String>[for (final CapitalLine line in entry.value) line.ctmtqgVnd]),
          disbursedVnd: entry.value.every((CapitalLine line) => line.disbursedVnd == null)
              ? null
              : sumDong(<String>[for (final CapitalLine line in entry.value) ?line.disbursedVnd]),
        ),
    ];
  }

  /// What is allocated in all: the sum of the amounts, which already hold the CTMTQG parts.
  String get allocatedVnd => sumDong(<String>[for (final CapitalLine line in lines) line.allocatedVnd]);

  String get ctmtqgVnd => sumDong(<String>[for (final CapitalLine line in lines) line.ctmtqgVnd]);

  String? get disbursedVnd => lines.every((CapitalLine line) => line.disbursedVnd == null) ? null : sumDong(<String>[for (final CapitalLine line in lines) ?line.disbursedVnd]);
}

/// The plan from `{plans: [...], lines: {plan, items, next_cursor, as_of?} | null}`, or null when it is not one. `plans` is the
/// register of plans (the choice), `lines` the answer for the chosen plan (null when there is no published plan to open).
CapitalPlan? parseCapitalPlan(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['plans'] is! List) return null;
  final List<PlanChoice> plans = <PlanChoice>[for (final Object? item in listOf(body['plans'])) ?parsePlanChoice(item)];
  final Object? answer = body['lines'];
  if (answer == null) return CapitalPlan(plans: plans, lines: const <CapitalLine>[], truncated: false, asOf: filled(body['as_of']));
  final Json? lines = asRecord(answer);
  final PlanChoice? chosen = parsePlanChoice(lines?['plan']);
  if (lines == null || chosen == null || lines['items'] is! List) return null;
  return CapitalPlan(
    plan: chosen,
    plans: plans,
    lines: <CapitalLine>[for (final Object? item in listOf(lines['items'])) ?_line(item)],
    truncated: filled(lines['next_cursor']) != null,
    asOf: filled(lines['as_of']) ?? filled(body['as_of']),
  );
}
