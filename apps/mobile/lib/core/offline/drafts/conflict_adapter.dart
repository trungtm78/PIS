import 'package:machvon_api_client/machvon_api_client.dart';

import '../../api/answer.dart';
import '../queue/queued_command.dart';
import 'draft_conflict.dart';

/// The copy of a record that the server holds, in the shape of the payload of the command that changes it, and the
/// version it has now.
final class ServerCopy {
  const ServerCopy({required this.version, required this.fields});

  final int version;
  final Map<String, Object?> fields;
}

/// A conflict ready for the person: what differs, and the version of the server it was read at. The command goes back to the
/// queue based on that version.
final class LoadedConflict {
  const LoadedConflict({required this.conflict, required this.serverVersion});

  final DraftConflict conflict;
  final int serverVersion;
}

/// How one kind of command finds the server's copy of its record and compares it with the draft of the device. A module
/// that queues commands registers one for each command type that can conflict (a conflict hook of MOB-42); the queue and the
/// screen know nothing about the shape of a report or a diary.
final class ConflictAdapter {
  const ConflictAdapter({
    required this.read,
    this.listIdentity = const <String, List<String>>{},
    this.ignore = const <String>{},
    this.isMoney = defaultIsMoney,
    this.onlyFieldsOfMine = true,
  });

  /// Reads the record through the read operation of its module (the same scope and permission checks as online).
  final Future<ServerCopy> Function(MachvonApiClient client, QueuedCommand command) read;
  final Map<String, List<String>> listIdentity;
  final Set<String> ignore;
  final MoneyPolicy isMoney;
  final bool onlyFieldsOfMine;

  DraftConflict compare(QueuedCommand command, ServerCopy copy) => DraftConflict.compare(
        mine: command.payload ?? const <String, Object?>{},
        server: copy.fields,
        listIdentity: listIdentity,
        ignore: ignore,
        isMoney: isMoney,
        onlyFieldsOfMine: onlyFieldsOfMine,
      );
}

/// The adapters by command type.
final class ConflictAdapters {
  ConflictAdapters(Map<String, ConflictAdapter> adapters) : _adapters = Map<String, ConflictAdapter>.of(adapters);

  /// The adapters of the commands the server carries today that change a report.
  factory ConflictAdapters.standard() => ConflictAdapters(<String, ConflictAdapter>{
        'report.draft.save': reportConflictAdapter,
        'report.submit': reportConflictAdapter,
      });

  final Map<String, ConflictAdapter> _adapters;

  /// Adds the adapter of a command type; one type has one adapter.
  void register(String commandType, ConflictAdapter adapter) {
    if (_adapters.containsKey(commandType)) throw StateError('a conflict adapter is already registered for $commandType');
    _adapters[commandType] = adapter;
  }

  ConflictAdapter? forType(String commandType) => _adapters[commandType];

  /// Reads the server's copy for a command in conflict and compares it with the command's payload.
  Future<LoadedConflict> conflictOf(MachvonApiClient client, QueuedCommand command) async {
    final ConflictAdapter? adapter = _adapters[command.commandType];
    if (adapter == null) throw StateError('no conflict adapter for ${command.commandType}');
    final ServerCopy copy = await adapter.read(client, command);
    return LoadedConflict(conflict: adapter.compare(command, copy), serverVersion: copy.version);
  }
}

/// The weekly report (DIS): `GET /reports/{id}` read as a draft. The volumes of the progress, the narrative and the
/// funding lines have the names the draft uses; the lines are matched by bucket, budget level and source year, so their
/// order is no difference. A save that leaves a field out keeps the server's value, so only the fields the draft names
/// are compared. `client_operation_id` and the attachments are not figures of the report.
const ConflictAdapter reportConflictAdapter = ConflictAdapter(
  read: _readReport,
  listIdentity: <String, List<String>>{
    'funding_lines': <String>['bucket', 'budget_level', 'source_year'],
  },
  ignore: <String>{'report_id', 'client_operation_id', 'attachments'},
);

Future<ServerCopy> _readReport(MachvonApiClient client, QueuedCommand command) async {
  final Object? reportId = command.payload?['report_id'];
  if (reportId is! String) throw StateError('the command names no report');
  final Object? answer = await client.getReportRevision(id: reportId);
  final Map<String, Object?> view = decodeAnswer('getReportRevision', answer)! as Map<String, Object?>;
  final Object? version = view['version'];
  if (version is! int) throw const ContractMismatch('getReportRevision.version', 'is not an integer');
  return ServerCopy(version: version, fields: reportDraftFields(view));
}

/// The fields of a `ReportDraft` as the server's view of a report holds them.
Map<String, Object?> reportDraftFields(Map<String, Object?> view) {
  final Object? progress = view['progress'];
  final Map<String, Object?> volumes = progress is Map<String, Object?> ? progress : const <String, Object?>{};
  return <String, Object?>{
    'report_type': view['report_type'],
    'measurement_basis': view['measurement_basis'],
    'negative_delta_explanation': view['negative_delta_explanation'],
    'funding_lines': <Object?>[
      for (final Object? line in (view['funding_lines'] as List<Object?>?) ?? const <Object?>[])
        if (line is Map<String, Object?>)
          <String, Object?>{
            for (final String key in _fundingLineFields)
              if (line[key] != null) key: line[key],
          },
    ],
    for (final String key in _volumeFields)
      if (volumes[key] != null) key: volumes[key],
    'narrative': view['narrative'],
  };
}

const List<String> _fundingLineFields = <String>[
  'bucket',
  'budget_level',
  'source_year',
  'cumulative_vnd',
  'ctmtqg_subset_vnd',
  'next_month_vnd',
  'next_month_ctmtqg_subset_vnd',
];

const List<String> _volumeFields = <String>[
  'construction_vnd',
  'acceptance_vnd',
  'treasury_submitted_vnd',
  'preparing_dossier_vnd',
  'physical_progress_pct',
];
