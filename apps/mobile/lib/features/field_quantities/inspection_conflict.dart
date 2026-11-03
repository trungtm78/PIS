import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/drafts/conflict_adapter.dart';
import '../../core/offline/queue/queued_command.dart';
import '../read_support/wire.dart';
import 'inspection_models.dart';

/// How an `inspection.result` that came back in conflict finds the inspection the server holds (MOB-42): the answers to the checklist
/// are compared item by item (by code), and the overall result and its words. The inspection itself is not a figure to choose between.
const ConflictAdapter inspectionResultConflictAdapter = ConflictAdapter(
  read: _readInspection,
  listIdentity: <String, List<String>>{
    'checklist': <String>['code'],
  },
  ignore: <String>{'inspection_id'},
);

Future<ServerCopy> _readInspection(MachvonApiClient client, QueuedCommand command) async {
  final Object? id = command.payload?['inspection_id'];
  if (id is! String) throw StateError('the command names no inspection');
  final Json? view = asRecord(await client.getInspection(id: id));
  final Inspection? inspection = parseInspection(view);
  if (view == null || inspection == null) throw const ContractMismatch('getInspection', 'does not hold what the screen needs');
  return ServerCopy(
    version: inspection.version,
    fields: <String, Object?>{
      if (view['result'] != null) 'result': view['result'],
      if (view['result_note'] != null) 'result_note': view['result_note'],
      'checklist': <Object?>[
        for (final Object? item in listOf(view['checklist']))
          if (asRecord(item) case final Json row when row['code'] is String)
            <String, Object?>{'code': row['code'], if (row['outcome'] != null) 'outcome': row['outcome'], if (row['note'] != null) 'note': row['note']},
      ],
    },
  );
}
