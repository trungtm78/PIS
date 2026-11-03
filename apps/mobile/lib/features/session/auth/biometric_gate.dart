import 'package:local_auth/local_auth.dart';

/// The biometric prompt of the phone. It answers one question, "is the person who holds the phone the one who enrolled
/// here", and the answer unlocks the credential that is already stored in the Keychain or Keystore. It is never sent to the
/// server and is never a signature or an approval: no code path passes its result to a request.
abstract interface class BiometricGate {
  /// Whether the phone has a biometric (or a device credential) enrolled that can unlock the application.
  Future<bool> isAvailable();

  /// Shows the system prompt with [reason]; true only when the person passed it. A refusal, a cancel, a lock-out and an
  /// error are all false.
  Future<bool> authenticate({required String reason});
}

/// The [BiometricGate] on `local_auth`.
final class LocalAuthBiometricGate implements BiometricGate {
  LocalAuthBiometricGate({LocalAuthentication? auth}) : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  @override
  Future<bool> isAvailable() async {
    try {
      return await _auth.isDeviceSupported() && (await _auth.getAvailableBiometrics()).isNotEmpty;
    } on LocalAuthException {
      return false;
    }
  }

  @override
  Future<bool> authenticate({required String reason}) async {
    try {
      return await _auth.authenticate(localizedReason: reason, persistAcrossBackgrounding: true);
    } on LocalAuthException {
      return false;
    }
  }
}
