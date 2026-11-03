import '../read_support/money.dart';
import '../read_support/wire.dart';

/// The fund source categories of the funding structure, in the order of the screen. CTMTQG is a subset of its parent
/// (NSTW): it is shown as "of which" and is never added to a total (HOME 3 F6, BR-DIS-01).
enum FundCategory { nstw, nsdp, oda, ctmtqg, other }

/// Who assigned the capital (the origin of the appropriation), in the order of the register.
enum CapitalOrigin { pmAssigned, localAdded, carryover, centralSupport, revenueIncrease }

const Map<String, CapitalOrigin> _origins = <String, CapitalOrigin>{
  'PM_ASSIGNED': CapitalOrigin.pmAssigned,
  'LOCAL_ADDED': CapitalOrigin.localAdded,
  'CARRYOVER': CapitalOrigin.carryover,
  'CENTRAL_SUPPORT': CapitalOrigin.centralSupport,
  'REVENUE_INCREASE': CapitalOrigin.revenueIncrease,
};

const Map<String, FundCategory> _categories = <String, FundCategory>{
  'NSTW': FundCategory.nstw,
  'NSDP': FundCategory.nsdp,
  'ODA': FundCategory.oda,
  'CTMTQG': FundCategory.ctmtqg,
};

/// The categories that stand as cards of their own; CTMTQG is not one.
const List<FundCategory> sourceCategories = <FundCategory>[FundCategory.nstw, FundCategory.nsdp, FundCategory.oda, FundCategory.other];

/// The cards that are always drawn, with "no data" when nothing is published for them.
const List<FundCategory> _alwaysDrawn = <FundCategory>[FundCategory.nstw, FundCategory.nsdp, FundCategory.oda];

/// The category that holds CTMTQG as a part of it.
const FundCategory subsetParent = FundCategory.nstw;

/// One appropriation of the register of capital (`listAppropriations`).
final class Appropriation {
  const Appropriation({
    required this.id,
    required this.category,
    required this.isSubsetRelation,
    required this.fundSourceKey,
    required this.origin,
    required this.planYear,
    required this.amountVnd,
    required this.published,
  });

  final String id;
  final FundCategory category;

  /// The fund source says it is a part of another one (`SUBSET_OF`).
  final bool isSubsetRelation;
  final String fundSourceKey;
  final CapitalOrigin origin;
  final int planYear;
  final String amountVnd;
  final bool published;

  /// A part of its parent: what it holds is inside the parent and is never added to it.
  bool get isSubset => isSubsetRelation || category == FundCategory.ctmtqg;
}

Appropriation? _appropriation(Object? raw) {
  final Json? row = asRecord(raw);
  final Json? source = asRecord(row?['fund_source']);
  final CapitalOrigin? origin = _origins[row?['origin']];
  final String? id = filled(row?['id']);
  final String? key = filled(source?['business_key']);
  final int? year = whole(row?['plan_year']);
  final String? amount = unsignedDong(row?['amount_vnd']);
  final String? status = text(row?['status']);
  if (row == null || source == null || origin == null || id == null || key == null || year == null || amount == null || status == null) return null;
  return Appropriation(
    id: id,
    category: _categories[source['category']] ?? FundCategory.other,
    isSubsetRelation: source['relation'] == 'SUBSET_OF',
    fundSourceKey: key,
    origin: origin,
    planYear: year,
    amountVnd: amount,
    published: status == 'PUBLISHED',
  );
}

/// What the funding structure reads: the register, and the allocation lines the part that is CTMTQG is read from (null when
/// they could not be read: the part is then "no data", which is not zero).
final class FundingRegister {
  const FundingRegister({required this.rows, required this.lines});

  final List<Appropriation> rows;
  final List<Object?>? lines;

  /// The years that have capital published, the newest first.
  List<int> get years => <int>{for (final Appropriation row in rows) if (row.published) row.planYear}.toList()..sort((int a, int b) => b.compareTo(a));
}

/// The register from `{appropriations: [...], lines: [...] | null}`, or null when it is not one.
FundingRegister? parseFundingRegister(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['appropriations'] is! List) return null;
  final Object? lines = body['lines'];
  return FundingRegister(
    rows: <Appropriation>[for (final Object? row in listOf(body['appropriations'])) ?_appropriation(row)],
    lines: lines is List ? listOf(lines) : null,
  );
}

/// The part that is CTMTQG of each appropriation, from the allocation lines of the published plans: the amount of a line
/// already holds its CTMTQG part, so the part is read from the line and never added to it. Every appropriation is in the
/// answer when the lines were read (one that no published line draws on has a known part of zero); when they could not be
/// read the answer is empty: nothing is known, and nothing is not zero.
Map<String, String> ctmtqgAmounts(List<Appropriation> rows, List<Object?>? lines) {
  final Map<String, String> amounts = <String, String>{};
  if (lines == null) return amounts;
  for (final Appropriation row in rows) {
    amounts[row.id] = '0';
  }
  for (final Object? raw in lines) {
    final Json? line = asRecord(raw);
    final String? appropriation = filled(asRecord(line?['appropriation'])?['id']);
    final String? inside = unsignedDong(line?['ctmtqg_subset_vnd']);
    if (line == null || line['plan_status'] != 'PUBLISHED' || appropriation == null || inside == null || !amounts.containsKey(appropriation)) continue;
    amounts[appropriation] = sumDong(<String>[amounts[appropriation]!, inside]);
  }
  return amounts;
}

/// The part that is CTMTQG: the amount, or null when nothing is known; [partial] when some appropriation of the card could
/// not be read.
final class SubsetFigure {
  const SubsetFigure({required this.vnd, required this.partial});

  final String? vnd;
  final bool partial;
}

final class SourceCard {
  const SourceCard({required this.category, required this.vnd, required this.count, required this.subset});

  final FundCategory category;

  /// The capital published for the source, or null when there is none: "no data", never zero.
  final String? vnd;
  final int count;

  /// Only the parent of CTMTQG has one.
  final SubsetFigure? subset;
}

final class OriginCard {
  const OriginCard({required this.origin, required this.vnd, required this.count});

  final CapitalOrigin origin;
  final String? vnd;
  final int count;
}

final class Funding {
  const Funding({required this.year, required this.totalVnd, required this.sources, required this.origins});

  final int year;

  /// What is added: the published capital that is not a part of another source. Null when there is none.
  final String? totalVnd;
  final List<SourceCard> sources;
  final List<OriginCard> origins;
}

String? _total(List<Appropriation> rows) => rows.isEmpty ? null : sumDong(<String>[for (final Appropriation row in rows) row.amountVnd]);

SubsetFigure _subsetFigure(List<Appropriation> parents, List<Appropriation> registered, Map<String, String> subsets) {
  final List<Appropriation> known = <Appropriation>[for (final Appropriation row in parents) if (subsets.containsKey(row.id)) row];
  if (known.isEmpty && registered.isEmpty) return const SubsetFigure(vnd: null, partial: false);
  return SubsetFigure(
    vnd: sumDong(<String>[
      for (final Appropriation row in known) subsets[row.id] ?? '0',
      for (final Appropriation row in registered) row.amountVnd,
    ]),
    partial: known.length < parents.length,
  );
}

/// The funding structure of a year: the published appropriations by source and by origin, each card with the amount that
/// was published or none. CTMTQG is shown as a part of its parent, from the lines of the plans, and is in no total; a source
/// that is a part of another one (CTMTQG registered as a source of its own) is a part of the parent card, never an addition
/// to it.
Funding fundingOf(FundingRegister register, int year) {
  final Map<String, String> subsets = ctmtqgAmounts(register.rows, register.lines);
  final List<Appropriation> published = <Appropriation>[for (final Appropriation row in register.rows) if (row.published && row.planYear == year) row];
  final List<Appropriation> additive = <Appropriation>[for (final Appropriation row in published) if (!row.isSubset) row];
  final List<Appropriation> registeredParts = <Appropriation>[for (final Appropriation row in published) if (row.isSubset) row];
  final List<SourceCard> sources = <SourceCard>[];
  for (final FundCategory category in sourceCategories) {
    final List<Appropriation> own = <Appropriation>[for (final Appropriation row in additive) if (row.category == category) row];
    if (own.isEmpty && !_alwaysDrawn.contains(category)) continue;
    sources.add(SourceCard(
      category: category,
      vnd: _total(own),
      count: own.length,
      subset: category == subsetParent ? _subsetFigure(own, registeredParts, subsets) : null,
    ));
  }
  final List<OriginCard> origins = <OriginCard>[
    for (final CapitalOrigin origin in CapitalOrigin.values)
      OriginCard(
        origin: origin,
        vnd: _total(<Appropriation>[for (final Appropriation row in additive) if (row.origin == origin) row]),
        count: additive.where((Appropriation row) => row.origin == origin).length,
      ),
  ];
  return Funding(year: year, totalVnd: _total(additive), sources: sources, origins: origins);
}
