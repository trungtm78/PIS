import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/security/device_integrity.dart';

class _Source implements DeviceIntegritySource {
  _Source(this.answer);

  final Future<IntegritySignals> Function() answer;

  @override
  Future<IntegritySignals> read() => answer();
}

final RegExp _reasonShape = RegExp(r'^[A-Z][A-Z0-9_]{2,63}$');

/// Every combination of the five signals.
Iterable<IntegritySignals> _allSignals() sync* {
  for (int bits = 0; bits < 32; bits += 1) {
    yield IntegritySignals(
      rooted: bits & 1 != 0,
      jailbroken: bits & 2 != 0,
      debuggerAttached: bits & 4 != 0,
      hookingFramework: bits & 8 != 0,
      emulator: bits & 16 != 0,
    );
  }
}

void main() {
  group('TK-MOB-041-2 AC-ST-MOB-041-1 the root and jailbreak policy decides by the tenant mode and never blocks the application', () {
    test('a phone with no signal is left alone in every mode', () {
      for (final IntegrityMode mode in IntegrityMode.values) {
        final IntegrityDecision decision = decideIntegrity(const IntegritySignals(), mode, releaseBuild: true);
        expect(decision.level, IntegrityLevel.proceed, reason: mode.name);
        expect(decision.reasonCodes, isEmpty);
        expect(decision.restrictions, isEmpty);
      }
    });

    test('a rooted or jailbroken phone: off changes nothing, warn tells the person, restrict also needs the server for the irreversible actions', () {
      for (final IntegritySignals signals in const <IntegritySignals>[
        IntegritySignals(rooted: true),
        IntegritySignals(jailbroken: true),
        IntegritySignals(hookingFramework: true),
      ]) {
        expect(decideIntegrity(signals, IntegrityMode.off, releaseBuild: true).level, IntegrityLevel.proceed);
        final IntegrityDecision warned = decideIntegrity(signals, IntegrityMode.warn, releaseBuild: true);
        expect(warned.level, IntegrityLevel.warn);
        expect(warned.restrictions, isEmpty, reason: 'a warning restricts nothing');
        final IntegrityDecision restricted = decideIntegrity(signals, IntegrityMode.restrictSensitive, releaseBuild: true);
        expect(restricted.level, IntegrityLevel.restrict);
        expect(restricted.restrictions, IntegrityRestriction.values.toSet());
        expect(restricted.restricts(IntegrityRestriction.signing), isTrue);
        expect(restricted.restricts(IntegrityRestriction.approvals), isTrue);
        expect(restricted.restricts(IntegrityRestriction.biometricUnlock), isTrue);
      }
    });

    test('the reason codes name the signal and nothing else', () {
      expect(decideIntegrity(const IntegritySignals(rooted: true), IntegrityMode.warn, releaseBuild: true).reasonCodes, <String>{kReasonRooted});
      expect(decideIntegrity(const IntegritySignals(jailbroken: true), IntegrityMode.warn, releaseBuild: true).reasonCodes, <String>{kReasonJailbroken});
      expect(decideIntegrity(const IntegritySignals(hookingFramework: true), IntegrityMode.warn, releaseBuild: true).reasonCodes, <String>{kReasonHooking});
      expect(
        decideIntegrity(const IntegritySignals(rooted: true, hookingFramework: true), IntegrityMode.warn, releaseBuild: true).reasonCodes,
        <String>{kReasonRooted, kReasonHooking},
      );
    });

    test("a debugger counts in a release build only: a developer's own debugger is not a signal", () {
      const IntegritySignals attached = IntegritySignals(debuggerAttached: true);
      expect(decideIntegrity(attached, IntegrityMode.restrictSensitive, releaseBuild: false).level, IntegrityLevel.proceed);
      expect(decideIntegrity(attached, IntegrityMode.restrictSensitive, releaseBuild: false).reasonCodes, isEmpty);
      final IntegrityDecision release = decideIntegrity(attached, IntegrityMode.warn, releaseBuild: true);
      expect(release.level, IntegrityLevel.warn);
      expect(release.reasonCodes, <String>{kReasonDebugger});
    });

    test('an emulator is named and changes nothing: the testers work on it', () {
      for (final IntegrityMode mode in IntegrityMode.values) {
        final IntegrityDecision decision = decideIntegrity(const IntegritySignals(emulator: true), mode, releaseBuild: true);
        expect(decision.level, IntegrityLevel.proceed, reason: mode.name);
        expect(decision.reasonCodes, <String>{kReasonEmulator});
      }
    });

    test('over every combination of signals, mode and build: nothing blocks, restrictions come only from the strictest mode, codes have the telemetry shape', () {
      int seen = 0;
      for (final IntegritySignals signals in _allSignals()) {
        for (final IntegrityMode mode in IntegrityMode.values) {
          for (final bool release in const <bool>[true, false]) {
            final IntegrityDecision decision = decideIntegrity(signals, mode, releaseBuild: release);
            seen += 1;
            final String where =
                'rooted=${signals.rooted} jailbroken=${signals.jailbroken} debugger=${signals.debuggerAttached} hooking=${signals.hookingFramework} emulator=${signals.emulator} ${mode.name} release=$release';
            expect(decision.blocksUse, isFalse, reason: where);
            expect(decision.restrictions.isNotEmpty, decision.level == IntegrityLevel.restrict, reason: where);
            if (mode != IntegrityMode.restrictSensitive) expect(decision.restrictions, isEmpty, reason: where);
            if (mode == IntegrityMode.off) expect(decision.level, IntegrityLevel.proceed, reason: where);
            expect(decision.reasonCodes.every(_reasonShape.hasMatch), isTrue, reason: where);
          }
        }
      }
      expect(seen, 32 * 3 * 2);
    });

    test('a check that could not run concludes nothing', () {
      for (final IntegrityMode mode in IntegrityMode.values) {
        final IntegrityDecision decision = decideIntegrity(const IntegritySignals.unavailable(), mode, releaseBuild: true);
        expect(decision.level, IntegrityLevel.proceed, reason: mode.name);
        expect(decision.reasonCodes, <String>{kReasonUnknown});
        expect(decision.restrictions, isEmpty);
      }
    });

    test('the tenant policy value is parsed so that an unknown value never relaxes the check and never blocks', () {
      expect(IntegrityMode.parse('off'), IntegrityMode.off);
      expect(IntegrityMode.parse('warn'), IntegrityMode.warn);
      expect(IntegrityMode.parse('restrict_sensitive'), IntegrityMode.restrictSensitive);
      expect(IntegrityMode.parse('block'), IntegrityMode.warn, reason: 'there is no blocking mode to ask for');
      expect(IntegrityMode.parse(null), IntegrityMode.warn);
      expect(IntegrityMode.values.map((IntegrityMode m) => m.name), <String>['off', 'warn', 'restrictSensitive']);
    });
  });

  group('TK-MOB-041-2 the integrity service reads the port and survives a broken detector', () {
    test('it applies the policy to what the source says', () async {
      final DeviceIntegrityService service = DeviceIntegrityService(source: _Source(() async => const IntegritySignals(rooted: true)));
      final IntegrityDecision decision = await service.assess(IntegrityMode.restrictSensitive);
      expect(decision.level, IntegrityLevel.restrict);
      expect(decision.reasonCodes, <String>{kReasonRooted});
    });

    test('a source that throws is "unknown", the application goes on', () async {
      final DeviceIntegrityService service = DeviceIntegrityService(source: _Source(() async => throw StateError('plugin crashed')));
      final IntegrityDecision decision = await service.assess(IntegrityMode.restrictSensitive);
      expect(decision.level, IntegrityLevel.proceed);
      expect(decision.reasonCodes, <String>{kReasonUnknown});
    });

    test('a source that does not answer in time is "unknown"', () async {
      final Completer<IntegritySignals> never = Completer<IntegritySignals>();
      final DeviceIntegrityService service = DeviceIntegrityService(source: _Source(() => never.future), timeout: const Duration(milliseconds: 20));
      final IntegrityDecision decision = await service.assess(IntegrityMode.restrictSensitive);
      expect(decision.level, IntegrityLevel.proceed);
      expect(decision.reasonCodes, <String>{kReasonUnknown});
    });

    test('the build kind reaches the policy: a debugger in a debug build is not a signal', () async {
      final DeviceIntegrityService debug = DeviceIntegrityService(
        source: _Source(() async => const IntegritySignals(debuggerAttached: true)),
        releaseBuild: false,
      );
      expect((await debug.assess(IntegrityMode.restrictSensitive)).level, IntegrityLevel.proceed);
      final DeviceIntegrityService release = DeviceIntegrityService(source: _Source(() async => const IntegritySignals(debuggerAttached: true)));
      expect((await release.assess(IntegrityMode.restrictSensitive)).level, IntegrityLevel.restrict);
    });
  });
}
