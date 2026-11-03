import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/paged.dart';
import '../read_support/wire.dart';

/// Reads what MOB-63 needs together: the contract (a 404 when the reader may not open it, the same answer as for one that does not
/// exist), the lines of its bill of quantities, the reporting periods, and the quantities recorded so far. A reader who may not
/// read the periods (403) still records: the period is then typed as an identifier, as on the web.
Future<Json> readQuantityContext(MachvonApiClient client, String contractId) async {
  final Object? contract = await client.getResourcesContractId(id: contractId);
  final Json lines = await readMerged(client, 'get_resources_boq_line', query: <String, Object?>{'contract_id': contractId});
  Object? periods;
  try {
    periods = (await readMerged(client, 'get_resources_reporting_period'))['items'];
  } on ApiError catch (error) {
    if (error.status != 403) rethrow;
  }
  final Json measurements = await readMerged(client, 'get_resources_measurement', query: <String, Object?>{'contract_id': contractId});
  return <String, Object?>{'contract': contract, 'lines': lines['items'], if (periods != null) 'periods': periods, 'measurements': measurements['items']};
}
