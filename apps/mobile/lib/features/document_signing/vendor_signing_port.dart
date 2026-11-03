import 'dart:convert';

import 'signing_models.dart';
import 'signing_port.dart';
import 'vendor_sdk.dart';

/// The provider's SDK as a [SigningPort] (ST-MOB-032): the SDK signs the SHA-256 digest the server locked, on the phone, with the
/// certificate it holds, and the CMS signature goes to `completeSigningSession` as `cms_signature` with `client_digest_hex`. The server
/// embeds the signature in the PDF and verifies it at once, so what the phone adds is the checks that must not wait for the server:
///
///  * **readiness** is asked before a session is opened: an SDK that cannot be used, a holder with no certificate in it, or a certificate
///    that is not the registered one, create no session;
///  * **the digest** the SDK says it signed must be the one the server locked, and **the identity** it signed as must be the registered
///    certificate's subject; either differing, nothing is sent (the server would refuse it, and nothing partial is ever left there);
///  * **the SDK's own confirmation** (PIN or biometric) is the signer's act and its answer is not a parameter of anything sent; the
///    application's biometric prompt only unlocks the credential, it is not the signature (MOB.md L3).
///
/// The adapter code is the one the server calls the agent that signs on the signer's own device.
final class VendorSdkSigningPort implements SigningPort {
  const VendorSdkSigningPort(this.sdk, {this.adapter = 'LOCAL_AGENT'});

  final VendorSigningSdk sdk;
  final String adapter;

  @override
  String get adapterCode => adapter;

  @override
  bool get needsTypedCode => false;

  @override
  bool get unlocksCredential => true;

  @override
  Future<Readiness> readiness({SigningCertificate? certificate}) async {
    final SdkAvailability availability = await sdk.availability();
    if (availability != SdkAvailability.ready) return Readiness.unavailable;
    final SdkIdentity? held;
    try {
      held = await sdk.identity();
    } on SdkException catch (error) {
      return error.kind == SdkFailureKind.noCertificate ? Readiness.noCertificate : Readiness.unavailable;
    }
    if (held == null) return Readiness.noCertificate;
    if (certificate != null && !sameSubject(held.subjectDn, certificate.subject)) return Readiness.identityMismatch;
    return Readiness.ready;
  }

  @override
  Future<SigningProof?> prove(SigningChallenge challenge, {String? typedCode}) async {
    final String digest = challenge.digestHex.toLowerCase();
    if (!_digest.hasMatch(digest)) throw const SigningPortException(PortFailureKind.failed);
    final SdkSignature signature;
    try {
      signature = await sdk.signDigest(digestHex: digest, reason: challenge.label);
    } on SdkException catch (error) {
      switch (error.kind) {
        case SdkFailureKind.cancelled:
          return null;
        case SdkFailureKind.unavailable:
          throw const SigningPortException(PortFailureKind.unavailable);
        case SdkFailureKind.certificateNotActive:
        case SdkFailureKind.noCertificate:
          throw const SigningPortException(PortFailureKind.certificateNotActive);
        case SdkFailureKind.failed:
          throw const SigningPortException(PortFailureKind.failed);
      }
    }
    if (signature.digestHex.toLowerCase() != digest) throw const SigningPortException(PortFailureKind.digestMismatch);
    final String? expected = challenge.expectedSubject;
    if (expected != null && !sameSubject(signature.signer.subjectDn, expected)) throw const SigningPortException(PortFailureKind.identityMismatch);
    if (!_isBase64(signature.cmsBase64)) throw const SigningPortException(PortFailureKind.failed);
    return SigningProof(cmsSignature: signature.cmsBase64, clientDigestHex: digest);
  }
}

final RegExp _digest = RegExp(r'^[0-9a-f]{64}$');

bool _isBase64(String value) {
  try {
    return base64.decode(value).isNotEmpty;
  } on FormatException {
    return false;
  }
}
