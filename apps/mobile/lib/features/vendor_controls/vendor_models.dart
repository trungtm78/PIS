import '../read_support/wire.dart';

/// What the phone reads of the contractor controls (VND-2, `docs/vendor-controls.md`): the grades of risk of the contractors, the grade of one with
/// the factors it is made of, and the performance of its contracts. A grade is a signal with its explanation, never a verdict: the phone shows the
/// tier, the score, the points of each factor and the reasons exactly as the server wrote them, and the rule they came from with the flag when that
/// rule is not yet verified. Deciding a grade is done on the computer by a second person. An answer that lacks what makes a figure citable is refused
/// as a whole (null).

enum VendorTier { low, medium, high, critical }

const Map<String, VendorTier> _tiers = <String, VendorTier>{
  'LOW': VendorTier.low,
  'MEDIUM': VendorTier.medium,
  'HIGH': VendorTier.high,
  'CRITICAL': VendorTier.critical,
};

/// The tier as the contract writes it, for the filter of the list.
const Map<VendorTier, String> kVendorTierCodes = <VendorTier, String>{
  VendorTier.low: 'LOW',
  VendorTier.medium: 'MEDIUM',
  VendorTier.high: 'HIGH',
  VendorTier.critical: 'CRITICAL',
};

/// The rule a grade or a rating was made under: its code and version, and whether its numbers are confirmed.
final class VendorPolicy {
  const VendorPolicy({required this.code, required this.version, required this.unverified, this.asOf});

  final String code;
  final String version;
  final bool unverified;
  final String? asOf;
}

VendorPolicy? parseVendorPolicy(Object? raw) {
  final Json? row = asRecord(raw);
  final String? code = filled(row?['code']);
  final String? version = filled(row?['version']) ?? (row?['version'] is int ? '${row!['version']}' : null);
  if (row == null || code == null || version == null) return null;
  return VendorPolicy(code: code, version: version, unverified: row['unverified'] == true, asOf: filled(row['as_of']));
}

/// One count of the list: the code the server names, how many of how many.
final class VendorFigure {
  const VendorFigure({required this.code, required this.numerator, required this.denominator});

  final String code;
  final int numerator;
  final int denominator;
}

/// One contractor of the list of grades.
final class VendorRiskItem {
  const VendorRiskItem({
    required this.contractorId,
    required this.name,
    required this.reviewOverdue,
    this.tier,
    this.score,
    this.taxId,
    this.nextReviewOn,
    this.pendingTier,
    this.cursor,
  });

  final String contractorId;
  final String name;
  final String? taxId;

  /// Null for a contractor whose grade was never confirmed (a first proposal may be waiting): the screen says it is not graded, it does not hide the contractor.
  final VendorTier? tier;
  final int? score;
  final String? nextReviewOn;
  final bool reviewOverdue;

  /// A grade proposed and not yet confirmed by the second person (the phone only says it is waiting).
  final VendorTier? pendingTier;
  final String? cursor;
}

VendorRiskItem? _item(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['contractor_id']);
  final String? name = filled(row?['legal_name']);
  if (row == null || id == null || name == null) return null;
  return VendorRiskItem(
    contractorId: id,
    name: name,
    taxId: filled(row['tax_identifier']),
    tier: _tiers[row['tier']],
    score: whole(row['score']),
    nextReviewOn: filled(row['next_review_on']),
    reviewOverdue: row['review_overdue'] == true,
    pendingTier: _tiers[row['pending_tier']],
    cursor: filled(row['cursor']),
  );
}

/// A page of the list of grades with the counts and the rule the server names.
final class VendorRiskPage {
  const VendorRiskPage({required this.items, required this.figures, required this.asOf, this.nextCursor, this.policy});

  final List<VendorRiskItem> items;
  final List<VendorFigure> figures;
  final String asOf;
  final String? nextCursor;
  final VendorPolicy? policy;
}

VendorRiskPage? parseVendorRiskPage(Object? raw) {
  final Json? row = asRecord(raw);
  final String? asOf = filled(row?['as_of']);
  if (row == null || asOf == null || row['items'] is! List) return null;
  return VendorRiskPage(
    items: <VendorRiskItem>[for (final Object? entry in listOf(row['items'])) ?_item(entry)],
    figures: <VendorFigure>[
      for (final Object? entry in listOf(row['figures']))
        if (filled(asRecord(entry)?['code']) case final String code) VendorFigure(code: code, numerator: count(asRecord(entry)?['numerator']), denominator: count(asRecord(entry)?['denominator'])),
    ],
    asOf: asOf,
    nextCursor: filled(row['next_cursor']),
    policy: parseVendorPolicy(row['policy']),
  );
}

/// One factor of a grade: its points out of its weight, and the readings it was made from.
final class VendorFactor {
  const VendorFactor({required this.factor, required this.points, required this.max, required this.reading});

  final String factor;
  final int points;
  final int max;
  final Map<String, String> reading;
}

VendorFactor? _factor(Object? raw) {
  final Json? row = asRecord(raw);
  final String? factor = filled(row?['factor']);
  final int? points = whole(row?['points']);
  final int? max = whole(row?['max']);
  if (row == null || factor == null || points == null || max == null) return null;
  final Json? reading = asRecord(row['reading']);
  return VendorFactor(
    factor: factor,
    points: points,
    max: max,
    reading: <String, String>{
      if (reading != null)
        for (final MapEntry<String, Object?> entry in reading.entries)
          if (entry.value != null) entry.key: '${entry.value}',
    },
  );
}

/// The grade the rules give now, or the one a person confirmed: the tier, the score, the factors and the reasons, and when it is looked at again.
final class VendorGrade {
  const VendorGrade({
    required this.tier,
    required this.score,
    required this.floored,
    required this.factors,
    required this.reasons,
    required this.dualCheck,
    this.scoreTier,
    this.reviewMonths,
    this.nextReviewOn,
  });

  final VendorTier tier;
  final int score;

  /// The tier the score alone gives, when a rule (a restriction in force) holds the tier higher.
  final VendorTier? scoreTier;
  final bool floored;
  final List<VendorFactor> factors;

  /// The factor codes that added points, the largest first.
  final List<String> reasons;
  final int? reviewMonths;
  final String? nextReviewOn;

  /// A grade at this tier needs a second person to confirm it.
  final bool dualCheck;
}

VendorGrade? _grade(Object? raw) {
  final Json? row = asRecord(raw);
  final VendorTier? tier = _tiers[row?['tier']];
  final int? score = whole(row?['score']);
  if (row == null || tier == null || score == null) return null;
  return VendorGrade(
    tier: tier,
    score: score,
    scoreTier: _tiers[row['score_tier']],
    floored: row['floored'] == true,
    factors: <VendorFactor>[for (final Object? entry in listOf(row['factors'])) ?_factor(entry)],
    reasons: <String>[for (final Object? entry in listOf(row['reasons'])) ?filled(entry)],
    reviewMonths: whole(row['review_months']),
    nextReviewOn: filled(row['next_review_on']),
    dualCheck: row['dual_check'] == true,
  );
}

/// One snapshot of the history: the grade a person confirmed, proposed, replaced or rejected.
final class VendorSnapshot {
  const VendorSnapshot({required this.tier, required this.score, required this.state, required this.asOf, this.assessedBy, this.decidedBy, this.decisionReason, this.ruleVersion, this.ruleUnverified = false});

  final VendorTier tier;
  final int score;

  /// `PROPOSED`, `CONFIRMED`, `SUPERSEDED` or `REJECTED`.
  final String state;
  final String asOf;
  final String? assessedBy;
  final String? decidedBy;
  final String? decisionReason;
  final String? ruleVersion;
  final bool ruleUnverified;
}

VendorSnapshot? _snapshot(Object? raw) {
  final Json? row = asRecord(raw);
  final VendorTier? tier = _tiers[row?['tier']];
  final int? score = whole(row?['score']);
  final String? state = filled(row?['state']);
  final String? asOf = filled(row?['as_of']);
  if (row == null || tier == null || score == null || state == null || asOf == null) return null;
  return VendorSnapshot(
    tier: tier,
    score: score,
    state: state,
    asOf: asOf,
    assessedBy: filled(row['assessed_by_name']),
    decidedBy: filled(row['decided_by_name']),
    decisionReason: filled(row['decision_reason']),
    ruleVersion: filled(row['rule_version']),
    ruleUnverified: row['rule_unverified'] == true,
  );
}

/// The grade of one contractor.
final class VendorRiskDetail {
  const VendorRiskDetail({required this.contractorId, required this.name, required this.history, required this.asOf, this.tier, this.live, this.confirmed, this.pending, this.policy});

  final String contractorId;
  final String name;

  /// The tier the contractor carries now (the confirmed one); null when no grade was ever confirmed.
  final VendorTier? tier;
  final VendorGrade? live;
  final VendorSnapshot? confirmed;
  final VendorSnapshot? pending;
  final List<VendorSnapshot> history;
  final VendorPolicy? policy;
  final String asOf;
}

VendorRiskDetail? parseVendorRiskDetail(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['contractor_id']);
  final String? name = filled(row?['contractor_name']);
  final String? asOf = filled(row?['as_of']);
  if (row == null || id == null || name == null || asOf == null) return null;
  return VendorRiskDetail(
    contractorId: id,
    name: name,
    tier: _tiers[row['tier']],
    live: _grade(row['live']),
    confirmed: _snapshot(row['confirmed']),
    pending: _snapshot(row['pending']),
    history: <VendorSnapshot>[for (final Object? entry in listOf(row['history'])) ?_snapshot(entry)],
    policy: parseVendorPolicy(row['policy']),
    asOf: asOf,
  );
}

enum VendorRating { excellent, good, fair, poor }

const Map<String, VendorRating> _ratings = <String, VendorRating>{
  'EXCELLENT': VendorRating.excellent,
  'GOOD': VendorRating.good,
  'FAIR': VendorRating.fair,
  'POOR': VendorRating.poor,
};

/// One adopted rating of a contract with its clocks: when it must be published and how the contractor's response stands.
final class VendorPerformanceLine {
  const VendorPerformanceLine({
    required this.contractCode,
    required this.rating,
    required this.periodLabel,
    required this.publicationClock,
    required this.responseReview,
    this.score,
    this.adoptedOn,
    this.publicationDueOn,
    this.updates = 0,
    this.published = false,
  });

  final String contractCode;
  final VendorRating rating;
  final String periodLabel;
  final String? score;
  final String? adoptedOn;
  final String? publicationDueOn;

  /// `ON_TIME`, `DUE_SOON`, `OVERDUE`, `MET` or `MET_LATE`.
  final String publicationClock;

  /// `NOT_ANSWERED`, `WITHIN_REVIEW`, `DUE_SOON`, `OVERDUE` or `CLOSED`.
  final String responseReview;
  final int updates;
  final bool published;
}

VendorPerformanceLine? _line(Object? raw) {
  final Json? row = asRecord(raw);
  final String? contract = filled(row?['contract_code']);
  final VendorRating? rating = _ratings[row?['rating']];
  final String? period = filled(row?['period_label']);
  final String? clock = filled(row?['publication_clock']);
  final String? review = filled(row?['response_review']);
  if (row == null || contract == null || rating == null || period == null || clock == null || review == null) return null;
  return VendorPerformanceLine(
    contractCode: contract,
    rating: rating,
    periodLabel: period,
    score: filled(row['score']),
    adoptedOn: filled(row['adopted_on']),
    publicationDueOn: filled(row['publication_due_on']),
    publicationClock: clock,
    responseReview: review,
    updates: listOf(row['updates']).length,
    published: asRecord(row['publication']) != null,
  );
}

/// The performance of the contracts of one contractor: the lines, the run of poor ratings and what the rule suggests.
final class VendorPerformance {
  const VendorPerformance({required this.lines, required this.streak, required this.suggestion, required this.asOf, this.policy});

  final List<VendorPerformanceLine> lines;

  /// Poor ratings in a row.
  final int streak;

  /// `NONE`, `REMEDY_PLAN` or `PROPOSE_RESTRICTION`: a suggestion for a person, never an action.
  final String suggestion;
  final VendorPolicy? policy;
  final String asOf;
}

VendorPerformance? parseVendorPerformance(Object? raw) {
  final Json? row = asRecord(raw);
  final String? asOf = filled(row?['as_of']);
  if (row == null || asOf == null || row['lines'] is! List) return null;
  return VendorPerformance(
    lines: <VendorPerformanceLine>[for (final Object? entry in listOf(row['lines'])) ?_line(entry)],
    streak: count(row['streak']),
    suggestion: filled(row['suggestion']) ?? 'NONE',
    policy: parseVendorPolicy(row['policy']),
    asOf: asOf,
  );
}

/// Everything the detail screen shows: the grade, and the performance when the server could give it (its code when it could not).
final class VendorDetailData {
  const VendorDetailData({required this.risk, this.performance, this.performanceError});

  final VendorRiskDetail risk;
  final VendorPerformance? performance;
  final String? performanceError;
}

VendorDetailData? parseVendorDetailData(Object? raw) {
  final Json? row = asRecord(raw);
  final VendorRiskDetail? risk = parseVendorRiskDetail(row?['risk']);
  if (row == null || risk == null) return null;
  final VendorPerformance? performance = parseVendorPerformance(row['performance']);
  final Object? error = row['performance_error'];
  return VendorDetailData(risk: risk, performance: performance, performanceError: performance == null ? (error is String ? error : 'CONTRACT_MISMATCH') : null);
}
