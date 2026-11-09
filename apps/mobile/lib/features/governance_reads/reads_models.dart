import '../read_support/wire.dart';

/// A delegation of authority as the register lists it. Only what is safe to show: the period, the state, the reason and how many permissions
/// it carries; the members are ids and are not drawn.
final class DelegationLine {
  const DelegationLine({required this.id, required this.status, required this.validFrom, required this.validUntil, required this.permissions, this.reason});

  final String id;
  final String status;
  final String validFrom;
  final String validUntil;
  final int permissions;
  final String? reason;
}

/// An absence of a recipient of alerts, with how well its alerts are covered.
final class AbsenceLine {
  const AbsenceLine({required this.id, required this.kind, required this.validFrom, required this.validUntil, required this.phase, required this.coverage, this.name, this.reason});

  final String id;
  final String? name;
  final String kind;
  final String validFrom;
  final String validUntil;

  /// `SCHEDULED`, `ACTIVE` or `OVER`.
  final String phase;

  /// `COVERED`, `PARTIAL`, `UNCOVERED` or `NOT_APPLICABLE`.
  final String coverage;
  final String? reason;
}

/// A replacement asked for or in force for an absence.
final class CoverLine {
  const CoverLine({required this.id, required this.status, required this.validFrom, required this.validUntil, required this.inForce, this.absent, this.deputy});

  final String id;
  final String status;
  final String validFrom;
  final String validUntil;
  final bool inForce;
  final String? absent;
  final String? deputy;
}

/// What MOB-75 shows. Each part is read on its own: a part the server refused or could not answer is null and the screen says so, it is
/// never drawn as an empty list.
final class DelegationsView {
  const DelegationsView({required this.grants, required this.absences, required this.covers, this.ruleCode, this.ruleVersion, this.unverified = false, this.asOf});

  final List<DelegationLine>? grants;
  final List<AbsenceLine>? absences;
  final List<CoverLine>? covers;
  final String? ruleCode;
  final String? ruleVersion;
  final bool unverified;
  final String? asOf;
}

DelegationLine? _grant(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? from = filled(row?['valid_from']);
  final String? until = filled(row?['valid_until']);
  if (row == null || id == null || from == null || until == null) return null;
  return DelegationLine(id: id, status: text(row['status']) ?? '', validFrom: from, validUntil: until, permissions: listOf(row['permissions']).length, reason: filled(row['reason']));
}

AbsenceLine? _absence(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  return AbsenceLine(
    id: id,
    name: filled(row['name']),
    kind: text(row['kind']) ?? '',
    validFrom: text(row['valid_from']) ?? '',
    validUntil: text(row['valid_until']) ?? '',
    phase: text(row['phase']) ?? '',
    coverage: text(row['coverage']) ?? '',
    reason: filled(row['reason']),
  );
}

CoverLine? _cover(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  return CoverLine(
    id: id,
    status: text(row['status']) ?? '',
    validFrom: text(row['valid_from']) ?? '',
    validUntil: text(row['valid_until']) ?? '',
    inForce: row['in_force'] == true,
    absent: filled(asRecord(row['absent'])?['name']),
    deputy: filled(asRecord(row['deputy'])?['name']),
  );
}

/// The view from the two answers (`grants`: the delegation register, `absences`: `listAlertAbsences`), each null when it was not read.
/// Null when neither was read, so the screen shows the contract mismatch and not an empty page.
DelegationsView? parseDelegations({required Object? grants, required Object? absences}) {
  final Json? grantRecord = asRecord(grants);
  final Json? absenceRecord = asRecord(absences);
  final bool grantsOk = grantRecord != null && grantRecord['items'] is List;
  final bool absencesOk = absenceRecord != null && absenceRecord['items'] is List;
  if (!grantsOk && !absencesOk) return null;
  final Json? rule = asRecord(absenceRecord?['rule']);
  return DelegationsView(
    grants: grantsOk ? <DelegationLine>[for (final Object? item in listOf(grantRecord['items'])) ?_grant(item)] : null,
    absences: absencesOk ? <AbsenceLine>[for (final Object? item in listOf(absenceRecord['items'])) ?_absence(item)] : null,
    covers: absencesOk ? <CoverLine>[for (final Object? item in listOf(absenceRecord['pending_covers'])) ?_cover(item)] : null,
    ruleCode: filled(rule?['code']),
    ruleVersion: filled(rule?['version']),
    unverified: rule?['unverified'] == true,
    asOf: filled(absenceRecord?['as_of']) ?? filled(grantRecord?['as_of']),
  );
}

/// One indicator of the register, as the server defines it.
final class KpiDefinition {
  const KpiDefinition({required this.code, required this.name, required this.version, required this.unverified, this.formula, this.numerator, this.denominator, this.unit, this.period, this.source, this.owner, this.certification});

  final String code;
  final String name;
  final String version;
  final bool unverified;
  final String? formula;
  final String? numerator;
  final String? denominator;
  final String? unit;
  final String? period;
  final String? source;
  final String? owner;

  /// The status of the certification of the version in force (`CERTIFIED`, ...), null when the version has none.
  final String? certification;
}

final class KpiRegister {
  const KpiRegister({required this.items, this.asOf});

  final List<KpiDefinition> items;
  final String? asOf;
}

KpiRegister? parseKpiRegister(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['definitions'] is! List) return null;
  final List<KpiDefinition> items = <KpiDefinition>[];
  for (final Object? entry in listOf(row['definitions'])) {
    final Json? item = asRecord(entry);
    final String? code = filled(item?['code']);
    final String? name = filled(item?['name']);
    if (item == null || code == null || name == null) continue;
    items.add(KpiDefinition(
      code: code,
      name: name,
      version: item['version']?.toString() ?? '',
      unverified: item['unverified'] == true,
      formula: filled(item['formula']),
      numerator: filled(item['numerator']),
      denominator: filled(item['denominator']),
      unit: filled(item['unit']),
      period: filled(item['period']),
      source: filled(item['source']),
      owner: filled(item['owner']),
      certification: filled(asRecord(item['certification'])?['status']),
    ));
  }
  return KpiRegister(items: items, asOf: filled(row['as_of']));
}

/// One form of the report catalogue.
final class ReportForm {
  const ReportForm({required this.code, required this.name, required this.version, required this.edition, required this.receiver, required this.periodKind, required this.official, required this.registered, required this.issuable, this.demoMark});

  final String code;
  final String name;
  final String version;
  final String edition;
  final String receiver;
  final String periodKind;
  final String official;
  final bool registered;
  final bool issuable;

  /// The mark of a demo form; a demo form is always labelled as such.
  final String? demoMark;
}

final class ReportCatalogue {
  const ReportCatalogue({required this.items, required this.demoMode, this.asOf});

  final List<ReportForm> items;
  final bool demoMode;
  final String? asOf;
}

ReportCatalogue? parseReportCatalogue(Object? raw) {
  final Json? row = asRecord(raw);
  if (row == null || row['items'] is! List) return null;
  final List<ReportForm> items = <ReportForm>[];
  for (final Object? entry in listOf(row['items'])) {
    final Json? item = asRecord(entry);
    final String? code = filled(item?['code']);
    final String? name = filled(item?['name']);
    if (item == null || code == null || name == null) continue;
    items.add(ReportForm(
      code: code,
      name: name,
      version: text(item['version']) ?? '',
      edition: text(item['edition']) ?? '',
      receiver: text(item['receiver']) ?? '',
      periodKind: text(item['period_kind']) ?? '',
      official: text(item['official']) ?? '',
      registered: item['registered'] == true,
      issuable: item['issuable'] == true,
      demoMark: filled(item['demo_mark']),
    ));
  }
  return ReportCatalogue(items: items, demoMode: row['demo_mode'] == true, asOf: filled(row['as_of']));
}
