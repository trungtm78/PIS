import 'package:machvon_api_client/machvon_api_client.dart';

/// Reads the answer of an operation with the decoder the contract generated for it.
///
/// A response that does not match the contract (a renamed or retyped field) throws [ContractMismatch] naming the member;
/// the screen shows it as an error with the code `CONTRACT_MISMATCH` and the build of the contract tests goes red. An
/// operation without a decoder (it answers with no body) returns null.
Object? decodeAnswer(String operationId, Object? json) {
  final Decoder<Object?>? decoder = responseDecoders[operationId];
  if (decoder == null) return null;
  return decoder(json, operationId);
}
