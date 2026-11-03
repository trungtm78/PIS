import 'package:flutter/services.dart';

/// Whether the provider's signing SDK can be used now.
enum SdkAvailability {
  /// Present, initialised and able to sign.
  ready,

  /// The SDK is not part of this build (no native module answers the channel).
  notInstalled,

  /// Present but cannot sign now (no service, a licence or an integrity check the SDK refused, the secure element is busy).
  unavailable,
}

/// The certificate the SDK holds on the phone and would sign with.
final class SdkIdentity {
  const SdkIdentity({required this.subjectDn, this.fingerprintSha256});

  /// The distinguished name of the holder, as the certificate carries it.
  final String subjectDn;
  final String? fingerprintSha256;
}

/// What the SDK produced for a digest: the CMS signature, the digest it signed, and the identity it signed as.
final class SdkSignature {
  const SdkSignature({required this.cmsBase64, required this.digestHex, required this.signer});

  /// The detached CMS (DER, PAdES-B-B or B-T) in base64: a signature, never key material.
  final String cmsBase64;

  /// SHA-256 (lower-case hex) of what the SDK signed: it must be the digest the server locked.
  final String digestHex;
  final SdkIdentity signer;
}

/// Why the SDK did not sign. The vendor's own text and codes never reach the screen or a log: the kind is all the phone keeps.
enum SdkFailureKind {
  /// The SDK cannot be reached or initialised now; trying again may work.
  unavailable,

  /// The signer refused or closed the SDK's own confirmation (PIN, biometric): nothing was signed.
  cancelled,

  /// The certificate in the SDK is revoked, expired or suspended (the vendor checked its status).
  certificateNotActive,

  /// No certificate is enrolled in the SDK for this signer.
  noCertificate,

  /// Anything else the SDK could not do.
  failed,
}

final class SdkException implements Exception {
  const SdkException(this.kind);

  final SdkFailureKind kind;

  @override
  String toString() => 'SdkException(${kind.name})';
}

/// The provider's digital-signature SDK as the phone uses it: the adapter behind [SigningPort]. The SDK itself (a vendor library for
/// Android and for iOS, chosen under D05, SPIKE-CA-SANDBOX) is native code that cannot be built or tried here; this is the whole of
/// what the application needs from it, so that everything above it is real and tested on the host and the native module only has to
/// answer these three calls.
abstract interface class VendorSigningSdk {
  Future<SdkAvailability> availability();

  /// The certificate the SDK would sign with, or null when none is enrolled. It is the holder's own, so its name is shown to them.
  Future<SdkIdentity?> identity();

  /// Signs [digestHex] (SHA-256, 64 lower-case hex digits) with the certificate of the SDK. The SDK shows its own confirmation (PIN or
  /// biometric) and [reason] on it. The document is never given to the SDK, only its digest.
  Future<SdkSignature> signDigest({required String digestHex, required String reason});
}

/// The channel the native module of the SDK answers on. The contract (what the Android and iOS wrappers implement):
///
///  * `availability` -> `"ready"`, `"not_installed"` or `"unavailable"`;
///  * `identity` -> `null`, or `{subject_dn: String, fingerprint_sha256?: String}`;
///  * `signDigest {digest_hex, reason}` -> `{cms_base64, digest_hex, subject_dn, fingerprint_sha256?}`, or a `PlatformException`
///    whose code is `SDK_UNAVAILABLE`, `USER_CANCELLED`, `CERTIFICATE_NOT_ACTIVE`, `NO_CERTIFICATE` or anything else (failed).
///
/// A phone whose build holds no native module answers nothing (`MissingPluginException`), which is "not installed".
const String vendorSigningChannelName = 'vn.machvon.app/vendor_signing';

final class MethodChannelVendorSigningSdk implements VendorSigningSdk {
  const MethodChannelVendorSigningSdk({MethodChannel channel = const MethodChannel(vendorSigningChannelName)}) : _channel = channel;

  final MethodChannel _channel;

  @override
  Future<SdkAvailability> availability() async {
    try {
      switch (await _channel.invokeMethod<String>('availability')) {
        case 'ready':
          return SdkAvailability.ready;
        case 'not_installed':
          return SdkAvailability.notInstalled;
        default:
          return SdkAvailability.unavailable;
      }
    } on MissingPluginException {
      return SdkAvailability.notInstalled;
    } on PlatformException {
      return SdkAvailability.unavailable;
    }
  }

  @override
  Future<SdkIdentity?> identity() async {
    try {
      final Map<Object?, Object?>? raw = await _channel.invokeMapMethod<Object?, Object?>('identity');
      return raw == null ? null : _identityOf(raw);
    } on MissingPluginException {
      throw const SdkException(SdkFailureKind.unavailable);
    } on PlatformException catch (error) {
      throw SdkException(_kindOf(error.code));
    }
  }

  @override
  Future<SdkSignature> signDigest({required String digestHex, required String reason}) async {
    try {
      final Map<Object?, Object?>? raw = await _channel.invokeMapMethod<Object?, Object?>('signDigest', <String, Object?>{'digest_hex': digestHex, 'reason': reason});
      final SdkIdentity? signer = raw == null ? null : _identityOf(raw);
      final Object? cms = raw?['cms_base64'];
      final Object? signed = raw?['digest_hex'];
      if (signer == null || cms is! String || cms.isEmpty || signed is! String) throw const SdkException(SdkFailureKind.failed);
      return SdkSignature(cmsBase64: cms, digestHex: signed.toLowerCase(), signer: signer);
    } on MissingPluginException {
      throw const SdkException(SdkFailureKind.unavailable);
    } on PlatformException catch (error) {
      throw SdkException(_kindOf(error.code));
    }
  }

  static SdkIdentity? _identityOf(Map<Object?, Object?> raw) {
    final Object? subject = raw['subject_dn'];
    if (subject is! String || subject.trim().isEmpty) return null;
    final Object? fingerprint = raw['fingerprint_sha256'];
    return SdkIdentity(subjectDn: subject, fingerprintSha256: fingerprint is String && fingerprint.isNotEmpty ? fingerprint.toLowerCase() : null);
  }

  static SdkFailureKind _kindOf(String code) {
    switch (code) {
      case 'SDK_UNAVAILABLE':
        return SdkFailureKind.unavailable;
      case 'USER_CANCELLED':
        return SdkFailureKind.cancelled;
      case 'CERTIFICATE_NOT_ACTIVE':
        return SdkFailureKind.certificateNotActive;
      case 'NO_CERTIFICATE':
        return SdkFailureKind.noCertificate;
      default:
        return SdkFailureKind.failed;
    }
  }
}

final RegExp _sha256Hex = RegExp(r'^[0-9a-f]{64}$');

/// A SHA-256 fingerprint of a certificate as 64 lower-case hexadecimal digits, whatever the way it was written (upper case, bytes
/// separated by colons or spaces), or null when it is not one: only a fingerprint that is certainly one is ever compared.
String? normalizeFingerprint(String? raw) {
  if (raw == null) return null;
  final String digits = raw.replaceAll(RegExp(r'[:\s]'), '').toLowerCase();
  return _sha256Hex.hasMatch(digits) ? digits : null;
}

/// Whether two distinguished names name the same holder: the same attributes with the same values, in any order, letters of the type
/// in any case, white space around values ignored, `\,` kept as part of a value. (A certificate prints its name most specific first
/// or last depending on the library, RFC 2253 and 4514.)
bool sameSubject(String a, String b) {
  final Set<String> left = _attributes(a);
  final Set<String> right = _attributes(b);
  return left.isNotEmpty && left.length == right.length && left.containsAll(right);
}

Set<String> _attributes(String dn) {
  final List<String> parts = <String>[];
  final StringBuffer current = StringBuffer();
  for (int i = 0; i < dn.length; i += 1) {
    final String char = dn[i];
    if (char == r'\' && i + 1 < dn.length) {
      current.write(dn[i + 1]);
      i += 1;
    } else if (char == ',') {
      parts.add(current.toString());
      current.clear();
    } else {
      current.write(char);
    }
  }
  parts.add(current.toString());
  final Set<String> attributes = <String>{};
  for (final String part in parts) {
    final int equals = part.indexOf('=');
    if (equals <= 0) return <String>{};
    final String type = part.substring(0, equals).trim().toLowerCase();
    final String value = part.substring(equals + 1).trim().replaceAll(RegExp(r'\s+'), ' ');
    if (type.isEmpty || value.isEmpty) return <String>{};
    attributes.add('$type=$value');
  }
  return attributes;
}
