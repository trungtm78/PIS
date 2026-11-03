import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/drafts/conflict_adapter.dart';
import '../../core/offline/queue/queued_command.dart';
import '../read_support/wire.dart';
import 'diary_models.dart';

/// How a `site_diary.append` that came back in conflict finds the diary the server holds (MOB-42): the diary the command names, or,
/// for a diary of a day that had none, the diary of that contract and day. Only the content is compared; the identity of the save
/// and of the diary are not figures the person chooses between. A save that leaves a field out keeps the server's value, so only
/// the fields the draft names are compared.
const ConflictAdapter siteDiaryConflictAdapter = ConflictAdapter(
  read: _readDiary,
  ignore: <String>{
    'diary_id',
    'contract_id',
    'record_date',
    'client_operation_id',
  },
);

Future<ServerCopy> _readDiary(
  MachvonApiClient client,
  QueuedCommand command,
) async {
  final Json payload = command.payload ?? const <String, Object?>{};
  final Object? named = payload['diary_id'];
  String? id = named is String ? named : null;
  if (id == null) {
    final Object? list = await client.getResourcesSiteDiary(
      query: <String, Object?>{
        'contract_id': payload['contract_id'],
        'from': payload['record_date'],
        'to': payload['record_date'],
        'limit': 50,
      },
    );
    for (final Object? item in listOf(asRecord(list)?['items'])) {
      final DiaryRecord? record = parseDiary(item);
      if (record != null && record.status != 'SUPERSEDED') id = record.id;
    }
  }
  if (id == null)
    throw const ContractMismatch(
      'getResourcesSiteDiary',
      'holds no diary of the contract and the day',
    );
  final DiaryRecord? record = parseDiary(
    await client.getResourcesSiteDiaryId(id: id),
  );
  if (record == null)
    throw const ContractMismatch(
      'getResourcesSiteDiaryId',
      'does not hold what the screen needs',
    );
  return ServerCopy(
    version: record.version,
    fields: <String, Object?>{'content': record.content},
  );
}
