import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/security/pinning_policy.dart';

String _pinOf(String seed) => base64.encode(sha256.convert(utf8.encode(seed)).bytes);

void main() {
  final String current = _pinOf('current intermediate');
  final String backup = _pinOf('backup intermediate');
  final String stranger = _pinOf('a key nobody pinned');

  group('TK-MOB-041-2 AC-ST-MOB-041-2 the pinning policy is data, checked by a pure function', () {
    test('the pin of a key is the base64 of the SHA-256 of its SubjectPublicKeyInfo', () {
      final List<int> spki = utf8.encode('spki bytes');
      expect(spkiPin(spki), base64.encode(sha256.convert(spki).bytes));
      expect(isValidPin(spkiPin(spki)), isTrue);
    });

    test('only a 32 byte digest in base64 is a pin', () {
      expect(isValidPin(current), isTrue);
      expect(isValidPin(''), isFalse);
      expect(isValidPin('not base64 at all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'), isFalse);
      expect(isValidPin('${'A' * 43}!'), isFalse, reason: '44 characters that are not base64');
      expect(isValidPin(base64.encode(List<int>.filled(31, 1))), isFalse);
      expect(isValidPin(base64.encode(List<int>.filled(33, 1))), isFalse);
      expect(isValidPin(current.substring(0, 43)), isFalse);
    });

    test('a policy that pins needs a backup pin: one renewal of the certificate must not lock out every installed phone', () {
      expect(() => PinningPolicy.checking(PinningMode.enforce, <String>{current}), throwsArgumentError);
      expect(() => PinningPolicy.checking(PinningMode.reportOnly, <String>{}), throwsArgumentError);
      expect(() => PinningPolicy.checking(PinningMode.enforce, <String>{current, 'garbage'}), throwsArgumentError);
      expect(PinningPolicy.checking(PinningMode.enforce, <String>{current, backup}).pins, <String>{current, backup});
    });

    test('the pin set cannot be changed after the policy is made', () {
      final PinningPolicy policy = PinningPolicy.checking(PinningMode.enforce, <String>{current, backup});
      expect(() => policy.pins.add(stranger), throwsUnsupportedError);
    });

    test('off checks nothing, whatever the chain', () {
      expect(PinningPolicy.off.evaluate(<String>[stranger]), PinDecision.notChecked);
      expect(PinningPolicy.checking(PinningMode.off, <String>{}).mode, PinningMode.off);
    });

    test('a chain with a pinned key (any certificate of it, leaf or intermediate) matches in both checking modes', () {
      for (final PinningMode mode in <PinningMode>[PinningMode.reportOnly, PinningMode.enforce]) {
        final PinningPolicy policy = PinningPolicy.checking(mode, <String>{current, backup});
        expect(policy.evaluate(<String>[stranger, current]), PinDecision.matched, reason: mode.name);
        expect(policy.evaluate(<String>[backup]), PinDecision.matched, reason: mode.name);
      }
    });

    test('a chain without a pinned key is reported in report-only and refused in enforce', () {
      expect(PinningPolicy.checking(PinningMode.reportOnly, <String>{current, backup}).evaluate(<String>[stranger]), PinDecision.reported);
      expect(PinningPolicy.checking(PinningMode.enforce, <String>{current, backup}).evaluate(<String>[stranger]), PinDecision.refused);
      expect(PinningPolicy.checking(PinningMode.enforce, <String>{current, backup}).evaluate(const <String>[]), PinDecision.refused);
    });

    test('the server can relax pinning, never tighten it', () {
      final PinningPolicy enforce = PinningPolicy.checking(PinningMode.enforce, <String>{current, backup});
      expect(enforce.loweredBy(null).mode, PinningMode.enforce);
      expect(enforce.loweredBy(PinningMode.enforce).mode, PinningMode.enforce);
      expect(enforce.loweredBy(PinningMode.reportOnly).mode, PinningMode.reportOnly);
      expect(enforce.loweredBy(PinningMode.reportOnly).evaluate(<String>[stranger]), PinDecision.reported);
      expect(enforce.loweredBy(PinningMode.off).mode, PinningMode.off);
      expect(enforce.loweredBy(PinningMode.off).evaluate(<String>[stranger]), PinDecision.notChecked);

      final PinningPolicy report = PinningPolicy.checking(PinningMode.reportOnly, <String>{current, backup});
      expect(report.loweredBy(PinningMode.enforce).mode, PinningMode.reportOnly, reason: 'a request to tighten is ignored');
      expect(PinningPolicy.off.loweredBy(PinningMode.enforce).mode, PinningMode.off, reason: 'there are no pins to enforce');
    });

    test('the modes are ordered from the least to the most strict', () {
      expect(PinningMode.enforce.isStricterThan(PinningMode.reportOnly), isTrue);
      expect(PinningMode.reportOnly.isStricterThan(PinningMode.off), isTrue);
      expect(PinningMode.off.isStricterThan(PinningMode.enforce), isFalse);
      expect(PinningMode.reportOnly.isStricterThan(PinningMode.reportOnly), isFalse);
    });

    test('the release configuration is the recorded decision D-SEC-02: pinning off for the pilot', () {
      expect(kPinningPolicy.mode, PinningMode.off);
      expect(kPinningPolicy.pins, isEmpty);
      expect(kPinningPolicy.evaluate(<String>[stranger]), PinDecision.notChecked);
    });
  });
}
