import 'dart:async';

/// What the platform says about the phone the application runs on (ST-MOB-041, decision D-SEC-01 of
/// `docs/mobile-security-review.md`). The signals come from a [DeviceIntegritySource]; nothing here knows how a root or a
/// jailbreak is detected, because every detection can be bypassed by the owner of the phone and a person who controls the
/// phone defeats any on-device check. The signals are therefore a *risk input*, never a gate on the identity or the server.
final class IntegritySignals {
  const IntegritySignals({
    this.rooted = false,
    this.jailbroken = false,
    this.debuggerAttached = false,
    this.hookingFramework = false,
    this.emulator = false,
  }) : available = true;

  /// The check could not run or did not answer in time: nothing is known, and nothing is concluded from it.
  const IntegritySignals.unavailable()
      : rooted = false,
        jailbroken = false,
        debuggerAttached = false,
        hookingFramework = false,
        emulator = false,
        available = false;

  final bool available;
  final bool rooted;
  final bool jailbroken;
  final bool debuggerAttached;

  /// A runtime instrumentation framework (Frida, Xposed and the like) is loaded in the process.
  final bool hookingFramework;
  final bool emulator;
}

/// The port to the platform. The adapter (a plugin, or a few lines of Kotlin and Swift) is chosen when a device exists to
/// test it on; the policy below is the same whichever adapter is behind it.
abstract interface class DeviceIntegritySource {
  Future<IntegritySignals> read();
}

/// How strict the tenant wants the application to be on a phone that looks modified. It is set by the server per tenant
/// (never by the phone), and there is no mode that blocks the application: a person must always be able to reach the
/// drafts of their own work and to sign out.
enum IntegrityMode {
  /// Nothing is shown and nothing changes.
  off,

  /// The person is told once per session and the reason code is counted by the telemetry.
  warn,

  /// As [warn], and the actions that cannot be undone (see [IntegrityRestriction]) need the server to agree first.
  restrictSensitive;

  /// The mode of a tenant policy value, or [warn] for a value this application does not know (a server newer than the app
  /// never relaxes the check by accident, and never tightens it into a block).
  static IntegrityMode parse(String? value) => switch (value) {
        'off' => IntegrityMode.off,
        'restrict_sensitive' => IntegrityMode.restrictSensitive,
        _ => IntegrityMode.warn,
      };
}

/// What a modified phone may not do on its own authority.
enum IntegrityRestriction {
  /// Approving or rejecting (already online only; this makes the step-up of the session mandatory).
  approvals,

  /// Starting a signature.
  signing,

  /// Unlocking the stored session with the biometric prompt: the refresh token is released only after the identity
  /// provider has been asked again.
  biometricUnlock,
}

enum IntegrityLevel { proceed, warn, restrict }

/// The outcome of the policy. It has no level that stops the application.
final class IntegrityDecision {
  const IntegrityDecision({required this.level, this.reasonCodes = const <String>{}, this.restrictions = const <IntegrityRestriction>{}});

  final IntegrityLevel level;

  /// Stable codes (upper case, letters, digits and `_`), the only thing that is ever reported about the phone.
  final Set<String> reasonCodes;
  final Set<IntegrityRestriction> restrictions;

  /// The application is never stopped by a signal from the phone.
  bool get blocksUse => false;

  bool restricts(IntegrityRestriction restriction) => restrictions.contains(restriction);
}

const String kReasonRooted = 'DEVICE_ROOTED';
const String kReasonJailbroken = 'DEVICE_JAILBROKEN';
const String kReasonDebugger = 'DEBUGGER_ATTACHED';
const String kReasonHooking = 'HOOKING_FRAMEWORK';
const String kReasonEmulator = 'EMULATOR';
const String kReasonUnknown = 'INTEGRITY_UNKNOWN';

/// Decides what to do about [signals] under [mode]. [releaseBuild] is false in a debug or profile build, where a debugger is
/// the developer's own and is not a signal.
IntegrityDecision decideIntegrity(IntegritySignals signals, IntegrityMode mode, {required bool releaseBuild}) {
  if (!signals.available) {
    return const IntegrityDecision(level: IntegrityLevel.proceed, reasonCodes: <String>{kReasonUnknown});
  }
  final Set<String> reasons = <String>{
    if (signals.rooted) kReasonRooted,
    if (signals.jailbroken) kReasonJailbroken,
    if (signals.hookingFramework) kReasonHooking,
    if (signals.debuggerAttached && releaseBuild) kReasonDebugger,
  };
  final bool modified = reasons.isNotEmpty;
  // An emulator is where the testers work: it is named in the reasons, and it changes nothing.
  final Set<String> named = <String>{...reasons, if (signals.emulator) kReasonEmulator};
  if (!modified || mode == IntegrityMode.off) {
    return IntegrityDecision(level: IntegrityLevel.proceed, reasonCodes: named);
  }
  if (mode == IntegrityMode.warn) {
    return IntegrityDecision(level: IntegrityLevel.warn, reasonCodes: named);
  }
  return IntegrityDecision(level: IntegrityLevel.restrict, reasonCodes: named, restrictions: IntegrityRestriction.values.toSet());
}

/// Reads the source and applies the policy. A source that throws or does not answer within [timeout] is "unknown", and the
/// application goes on (a broken detector must never lock out the people the application is for).
final class DeviceIntegrityService {
  const DeviceIntegrityService({required DeviceIntegritySource source, this.timeout = const Duration(seconds: 2), this.releaseBuild = true})
      : _source = source;

  final DeviceIntegritySource _source;
  final Duration timeout;
  final bool releaseBuild;

  Future<IntegrityDecision> assess(IntegrityMode mode) async {
    IntegritySignals signals;
    try {
      signals = await _source.read().timeout(timeout);
    } on Object {
      signals = const IntegritySignals.unavailable();
    }
    return decideIntegrity(signals, mode, releaseBuild: releaseBuild);
  }
}
