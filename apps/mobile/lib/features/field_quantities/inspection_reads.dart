import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// Reads what MOB-64 needs together: the contract (a 404 when the reader may not open it), its inspections, and its
/// non-conformances (the ones a failed item raised and that stand in the way of an acceptance).
Future<Json> readInspectionContext(MachvonApiClient client, String contractId) async {
  final Object? contract = await client.getResourcesContractId(id: contractId);
  final Object? inspections = await client.listInspections(query: <String, Object?>{'contract_id': contractId});
  final Json nonconformances = await readMerged(client, 'get_resources_quality_nonconformance', query: <String, Object?>{'contract_id': contractId});
  return <String, Object?>{'contract': contract, 'inspections': listOf(asRecord(inspections)?['items']), 'nonconformances': nonconformances['items']};
}
