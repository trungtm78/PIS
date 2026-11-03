import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// The master-data type of the issue categories (MDM-17), the same as the web.
const String kIssueCategoryType = 'ISSUE_CATEGORY';

/// A choice in a list of the form: what is sent, and what the person reads.
final class Choice {
  const Choice({required this.id, required this.label});

  final String id;
  final String label;
}

/// What the form of MOB-28 offers: the projects and the units the person may report for, and the categories in force. They are
/// read from the server and kept on the device with their `as_of`, so the form can be filled in without a network.
final class IssueLookups {
  const IssueLookups({
    required this.projects,
    required this.units,
    required this.categories,
  });

  final List<Choice> projects;
  final List<Choice> units;
  final List<Choice> categories;

  bool get isEmpty => projects.isEmpty || units.isEmpty || categories.isEmpty;
}

Choice? _codeAndName(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? code = filled(row?['code']);
  if (row == null || id == null || code == null) return null;
  final String? name = filled(row['name']);
  return Choice(id: id, label: name == null ? code : '$code · $name');
}

Choice? _category(Object? raw) {
  final Json? row = asRecord(raw);
  final String? versionId = filled(row?['version_id']);
  final String? key = filled(row?['business_key']);
  if (row == null ||
      versionId == null ||
      key == null ||
      row['status'] != 'EFFECTIVE')
    return null;
  final String? label = filled(row['label']);
  return Choice(id: versionId, label: label == null ? key : '$key · $label');
}

/// The lookups, or null when an answer is not the page of items the contract says.
IssueLookups? parseIssueLookups(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null ||
      body['projects'] is! List ||
      body['units'] is! List ||
      body['categories'] is! List)
    return null;
  return IssueLookups(
    projects: <Choice>[
      for (final Object? item in listOf(body['projects']))
        if (_codeAndName(item) case final Choice choice) choice,
    ],
    units: <Choice>[
      for (final Object? item in listOf(body['units']))
        if (_codeAndName(item) case final Choice choice) choice,
    ],
    categories: <Choice>[
      for (final Object? item in listOf(body['categories']))
        if (_category(item) case final Choice choice) choice,
    ],
  );
}

/// Reads the three lists the form offers, as one answer (so it is kept as one copy on the device).
Future<Json> readIssueLookups(MachvonApiClient client) async {
  final Json projects = await readMerged(client, 'get_resources_project');
  final Json units = await readMerged(
    client,
    'get_resources_organization_unit',
  );
  final Json categories = await readMerged(
    client,
    'searchMasterRecords',
    query: <String, Object?>{'master_type': kIssueCategoryType},
  );
  return <String, Object?>{
    'projects': projects['items'],
    'units': units['items'],
    'categories': categories['items'],
  };
}
