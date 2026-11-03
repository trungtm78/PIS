import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/wire.dart';

/// Reads the contract and the diaries of one day together: the contract (a 404 when it is not one the reader may open, the same
/// answer as a contract that does not exist) and the diaries of the register for that contract and day.
Future<Json> readDiaryDay(
  MachvonApiClient client,
  String contractId,
  String recordDate,
) async {
  final Object? contract = await client.getResourcesContractId(id: contractId);
  final Object? page = await client.getResourcesSiteDiary(
    query: <String, Object?>{
      'contract_id': contractId,
      'from': recordDate,
      'to': recordDate,
      'limit': 50,
    },
  );
  return <String, Object?>{
    'contract': contract,
    'diaries': listOf(asRecord(page)?['items']),
  };
}
