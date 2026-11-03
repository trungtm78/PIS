import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Certificate pinning as a policy (ST-MOB-041, decision D-SEC-02 of `docs/mobile-security-review.md`).
///
/// A pin is the SHA-256 of the SubjectPublicKeyInfo of a certificate of the chain, in base64. The policy is data: the check of
/// a chain against it is a pure function, and what the network stack does with the answer (nothing, report, refuse) is decided by
/// [PinningMode]. The release configuration is [kPinningPolicy]; the decision record explains why it is [PinningMode.off] for the
/// pilot and what has to be true before it is raised.
enum PinningMode {
  /// The operating system's trust decides alone.
  off,

  /// A chain without a pinned key is let through and counted (the mismatch is reported, never the chain).
  reportOnly,

  /// A chain without a pinned key is refused.
  enforce;

  /// The stricter of two modes is the one with the higher index; a remote switch can only go down this list.
  bool isStricterThan(PinningMode other) => index > other.index;
}

enum PinDecision { notChecked, matched, reported, refused }

/// A pin is exactly 32 bytes in base64 (44 characters with padding).
bool isValidPin(String pin) {
  if (pin.length != 44) return false;
  try {
    return base64.decode(pin).length == 32;
  } on FormatException {
    return false;
  }
}

/// The pin of a DER-encoded SubjectPublicKeyInfo.
String spkiPin(List<int> subjectPublicKeyInfo) => base64.encode(sha256.convert(subjectPublicKeyInfo).bytes);

final class PinningPolicy {
  const PinningPolicy._(this.mode, this.pins);

  /// Pinning is not used.
  static const PinningPolicy off = PinningPolicy._(PinningMode.off, <String>{});

  /// A policy that checks. A policy that pins needs a key that can take over when the current one is replaced, otherwise one
  /// certificate renewal would lock every installed phone out: at least two different well-formed pins.
  factory PinningPolicy.checking(PinningMode mode, Set<String> pins) {
    if (mode == PinningMode.off) return off;
    for (final String pin in pins) {
      if (!isValidPin(pin)) throw ArgumentError.value(pin, 'pins', 'is not the base64 of a SHA-256 digest');
    }
    if (pins.length < 2) throw ArgumentError.value(pins.length, 'pins', 'a pinning policy needs a current pin and a backup pin');
    return PinningPolicy._(mode, Set<String>.unmodifiable(pins));
  }

  final PinningMode mode;
  final Set<String> pins;

  /// This policy under what the server asks for: the server may relax pinning (to rescue phones after a bad rotation) but never
  /// tighten it, because a tightening would have to come with pins the phone has not been given.
  PinningPolicy loweredBy(PinningMode? remote) {
    if (remote == null || !mode.isStricterThan(remote)) return this;
    return remote == PinningMode.off ? off : PinningPolicy._(remote, pins);
  }

  /// The decision for a chain given as the pins of its certificates (leaf first).
  PinDecision evaluate(Iterable<String> chainPins) {
    if (mode == PinningMode.off) return PinDecision.notChecked;
    if (chainPins.any(pins.contains)) return PinDecision.matched;
    return mode == PinningMode.enforce ? PinDecision.refused : PinDecision.reported;
  }
}

/// The release configuration: decision D-SEC-02, pinning off for the pilot (R4).
const PinningPolicy kPinningPolicy = PinningPolicy.off;
