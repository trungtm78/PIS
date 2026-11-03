import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// A contract the person may work on (`get_resources_contract`): the contracts of the units they belong to, or, for a contractor who
/// was invited as a guest, only the contracts they were invited to. The scope is the server's; a contract outside it is a 404 that
/// is the same as one that does not exist.
final class ContractLine {
  const ContractLine({
    required this.id,
    required this.code,
    required this.status,
    this.title,
    this.projectName,
    this.contractorName,
    this.completionDue,
  });

  final String id;
  final String code;
  final String status;
  final String? title;
  final String? projectName;
  final String? contractorName;

  /// The day the work is due to be complete, `YYYY-MM-DD`.
  final String? completionDue;

  String get label => title == null ? code : '$code · $title';
}

ContractLine? parseContract(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  final String? status = filled(row?['status']);
  if (row == null || id == null || code == null || status == null) return null;
  return ContractLine(
    id: id,
    code: code,
    status: status,
    title: filled(row['title']),
    projectName: filled(row['project_name']),
    contractorName: filled(row['contractor_name']),
    completionDue: day(row['completion_due']),
  );
}

/// The contracts of a page of the register, as the screen lists them: the ones that have what a line needs.
List<ContractLine>? parseContracts(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return <ContractLine>[
    for (final Object? item in listOf(body['items']))
      if (parseContract(item) case final ContractLine line) line,
  ];
}

Future<Json> readContracts(MachvonApiClient client) =>
    readMerged(client, 'get_resources_contract');

/// A payment milestone of a contract: a line of its bill of quantities that names a milestone and a due day (CTR 4, BR-CTR-02).
final class Milestone {
  const Milestone({
    required this.lineId,
    required this.code,
    required this.description,
    this.dueOn,
  });

  final String lineId;
  final String code;
  final String description;
  final String? dueOn;
}

/// The milestones of a contract from the lines of its BOQ: the lines of the revision in force that name a milestone, in the order of
/// the due day (a line without one last).
List<Milestone>? parseMilestones(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<Milestone> found = <Milestone>[];
  for (final Object? item in listOf(body['items'])) {
    final Json? row = asRecord(item);
    final String? id = filled(row?['id']);
    final String? code = filled(row?['milestone_code']);
    // A line of a revision that is not in force is not a milestone yet.
    if (row == null ||
        id == null ||
        code == null ||
        row['revision_status'] != 'EFFECTIVE')
      continue;
    found.add(
      Milestone(
        lineId: id,
        code: code,
        description: filled(row['description']) ?? '',
        dueOn: day(row['milestone_due_on']),
      ),
    );
  }
  found.sort(
    (Milestone a, Milestone b) =>
        (a.dueOn ?? '9999-99-99').compareTo(b.dueOn ?? '9999-99-99'),
  );
  return found;
}

Future<Json> readMilestones(MachvonApiClient client, String contractId) =>
    readMerged(
      client,
      'get_resources_boq_line',
      query: <String, Object?>{'contract_id': contractId},
    );
