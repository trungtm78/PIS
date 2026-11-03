import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'signing_models.dart';
import 'vendor_sdk.dart';
import 'vendor_signing_port.dart';

/// What a signing session asks the phone for when it is completed: the session and the digest the server locked for it.
final class SigningChallenge {
  const SigningChallenge({required this.sessionId, required this.digestHex, this.expectedSubject, this.expectedFingerprint, this.label = ''});

  final String sessionId;

  /// The distinguished name of the certificate the server registered for this signer: a signature made with another certificate is not
  /// sent (the server would refuse it, and the signer should not have to find out after the fact).
  final String? expectedSubject;

  /// The SHA-256 fingerprint of that certificate (lower-case hexadecimal): the server compares a signature with it, and the name alone
  /// does not say which certificate made the signature. Null when the server did not say.
  final String? expectedFingerprint;

  /// What the signer is told they are signing, on the confirmation the SDK shows (the title of the document); it is not signed.
  final String label;

  /// SHA-256 (lower-case hex) of the bytes the signature covers; the server computed it, the phone never signs anything else.
  final String digestHex;
}

/// What the phone adds to complete a session. The proof is the signature (or the one-time code that releases the signature at the
/// provider); nothing a biometric prompt answers can be put in it.
final class SigningProof {
  const SigningProof({this.otpConfirmation, this.cmsSignature, this.clientDigestHex});

  /// The one-time code the signer received on their own device (the remote certificate authority).
  final String? otpConfirmation;

  /// The CMS signature a vendor SDK made over the digest (base64), with the digest it signed.
  final String? cmsSignature;
  final String? clientDigestHex;
}

/// Whether a port can start a signature now. Asked before a session is opened, so that nothing is created on the server for a signature
/// that cannot be made.
enum Readiness {
  ready,

  /// The provider's SDK cannot be used now (retryable, nothing was started).
  unavailable,

  /// The SDK holds no certificate for this signer.
  noCertificate,

  /// The certificate in the SDK is not the one registered for the signer.
  identityMismatch,
}

/// Why a proof was not made, for the words of the screen. Nothing was sent to the server in any of these cases.
enum PortFailureKind {
  /// The SDK cannot be used now (retryable: the session on the server stays open until it lapses).
  unavailable,

  /// The certificate of the SDK is revoked, expired or suspended.
  certificateNotActive,

  /// The SDK signed as someone other than the registered certificate.
  identityMismatch,

  /// The SDK signed something other than the digest the server locked.
  digestMismatch,

  /// The SDK failed in another way.
  failed,
}

final class SigningPortException implements Exception {
  const SigningPortException(this.kind);

  final PortFailureKind kind;

  @override
  String toString() => 'SigningPortException(${kind.name})';
}

/// How the signer proves a signature. The leader signs a document in two steps on the server (open a session that fixes the digest,
/// complete it with the proof), and this port is the second step's input: today the remote certificate authority confirms with a
/// one-time code typed by the signer (CXN-DOC-07, the same as the web DOC-22), later a vendor SDK on the phone signs the digest itself
/// (ST-MOB-032). The screen does not know which: it asks the port.
abstract interface class SigningPort {
  /// The adapter the session is opened with (`REMOTE_CA`, `LOCAL_AGENT`).
  String get adapterCode;

  /// Whether the signer types a code that the provider sent to their device.
  bool get needsTypedCode;

  /// Whether the signing key is held on the phone behind a biometric or device credential. The unlock only lets the key be used: the
  /// screen asks the system prompt first, a refusal stops everything, and the answer of the prompt is never part of the proof.
  bool get unlocksCredential;

  /// Whether the signature can be started now, for the registered [certificate] of the signer. Nothing is created anywhere by asking.
  Future<Readiness> readiness({SigningCertificate? certificate});

  /// Makes the proof for [challenge], or null when the signer did not give it (no code typed, the SDK was cancelled). Throws
  /// [SigningPortException] when the proof could not be made or must not be sent; nothing has been sent to the server then.
  Future<SigningProof?> prove(SigningChallenge challenge, {String? typedCode});
}

/// The longest one-time code the server takes.
const int otpMaxLength = 64;

/// The remote certificate authority of the web DOC-22: signing is confirmed with the one-time code on the signer's device.
final class RemoteCaOtpPort implements SigningPort {
  const RemoteCaOtpPort();

  @override
  String get adapterCode => 'REMOTE_CA';

  @override
  bool get needsTypedCode => true;

  @override
  bool get unlocksCredential => false;

  @override
  Future<Readiness> readiness({SigningCertificate? certificate}) async => Readiness.ready;

  @override
  Future<SigningProof?> prove(SigningChallenge challenge, {String? typedCode}) async {
    final String code = (typedCode ?? '').trim();
    if (code.isEmpty || code.length > otpMaxLength) return null;
    return SigningProof(otpConfirmation: code);
  }
}

/// The method this build signs with: `--dart-define=MACHVON_SIGNING=vendor_sdk` for the provider's SDK on the phone (ST-MOB-032), anything
/// else for the remote certificate authority confirmed with a one-time code. The choice follows the provider and the contract the
/// organisation has (D05); until then the safe default is the method that needs no native module.
const String signingMethod = String.fromEnvironment('MACHVON_SIGNING', defaultValue: 'remote_ca');

/// The provider's SDK on the phone: the native module behind a channel. A test overrides it.
final Provider<VendorSigningSdk> vendorSigningSdkProvider = Provider<VendorSigningSdk>((Ref ref) => const MethodChannelVendorSigningSdk());

/// How the signature is proved on this phone. A test overrides it.
final Provider<SigningPort> signingPortProvider = Provider<SigningPort>((Ref ref) => signingMethod == 'vendor_sdk' ? VendorSdkSigningPort(ref.watch(vendorSigningSdkProvider)) : const RemoteCaOtpPort());
