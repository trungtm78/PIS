/// Typed client of the MACHVON API for the mobile application.
///
/// The operation table, the request and response classes and one typed method per operation are generated from the OpenAPI
/// contract (`packages/contracts`); the transport is a port, so the platform adapter and the tests plug in their own.
library;

export 'src/api_error.dart';
export 'src/client.dart';
export 'src/command_attempt.dart';
export 'src/commands.generated.dart';
export 'src/operation_descriptor.dart';
export 'src/operations.generated.dart';
export 'src/request_model.dart';
export 'src/requests.generated.dart';
export 'src/response_model.dart';
export 'src/responses.generated.dart';
export 'src/transport.dart';
