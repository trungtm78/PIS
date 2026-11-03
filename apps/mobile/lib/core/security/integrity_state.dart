import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'device_integrity.dart';
import 'pinning_policy.dart';

/// The name of the channel the two platforms answer the integrity signals on (`MainActivity.kt`, `AppDelegate.swift`).
const String kDeviceIntegrityChannel = 'vn.machvon/device_integrity';

/// The platform side through a method channel: `read` answers `{rooted, jailbroken, debuggerAttached, hookingFramework, emulator}`,
/// each a boolean. A platform with no such side (a host, a build without it), an error, or an answer that is not that map is
/// "unknown": nothing is concluded from it (D-SEC-01).
final class MethodChannelIntegritySource implements DeviceIntegritySource {
  const MethodChannelIntegritySource({MethodChannel channel = const MethodChannel(kDeviceIntegrityChannel)}) : _channel = channel;

  final MethodChannel _channel;

  @override
  Future<IntegritySignals> read() async {
    final Map<Object?, Object?>? answer;
    try {
      answer = await _channel.invokeMapMethod<Object?, Object?>('read');
    } on MissingPluginException {
      return const IntegritySignals.unavailable();
    } on PlatformException {
      return const IntegritySignals.unavailable();
    }
    if (answer == null) return const IntegritySignals.unavailable();
    final Map<Object?, Object?> signals = answer;
    const List<String> names = <String>['rooted', 'jailbroken', 'debuggerAttached', 'hookingFramework', 'emulator'];
    if (names.any((String name) => signals[name] is! bool)) return const IntegritySignals.unavailable();
    return IntegritySignals(
      rooted: signals['rooted'] == true,
      jailbroken: signals['jailbroken'] == true,
      debuggerAttached: signals['debuggerAttached'] == true,
      hookingFramework: signals['hookingFramework'] == true,
      emulator: signals['emulator'] == true,
    );
  }
}

/// Where the signals come from. Tests override it.
final Provider<DeviceIntegritySource> deviceIntegritySourceProvider = Provider<DeviceIntegritySource>((Ref ref) => const MethodChannelIntegritySource());

final Provider<DeviceIntegrityService> deviceIntegrityServiceProvider = Provider<DeviceIntegrityService>(
  (Ref ref) => DeviceIntegrityService(source: ref.watch(deviceIntegritySourceProvider), releaseBuild: kReleaseMode),
);

/// The mode the server asks for (the field `integrity_mode` of the version policy). Until the server says, and when it says
/// something this application does not know, the mode is `warn` (D-SEC-01): a modified phone is told, and nothing is blocked.
class IntegrityModeNotifier extends Notifier<IntegrityMode> {
  @override
  IntegrityMode build() => IntegrityMode.warn;

  void set(IntegrityMode mode) => state = mode;
}

final NotifierProvider<IntegrityModeNotifier, IntegrityMode> integrityModeProvider =
    NotifierProvider<IntegrityModeNotifier, IntegrityMode>(IntegrityModeNotifier.new);

/// What the policy decided for the phone in this session, and whether the person was told.
final class IntegrityStatus {
  const IntegrityStatus({
    this.decision = const IntegrityDecision(level: IntegrityLevel.proceed),
    this.assessed = false,
    this.warningDismissed = false,
  });

  final IntegrityDecision decision;

  /// The phone was assessed in this session.
  final bool assessed;
  final bool warningDismissed;

  /// The person is told once per session: while the decision is a warning or a restriction and they did not close the notice.
  bool get warningVisible => decision.level != IntegrityLevel.proceed && !warningDismissed;

  IntegrityStatus copyWith({IntegrityDecision? decision, bool? assessed, bool? warningDismissed}) => IntegrityStatus(
        decision: decision ?? this.decision,
        assessed: assessed ?? this.assessed,
        warningDismissed: warningDismissed ?? this.warningDismissed,
      );
}

class IntegrityController extends Notifier<IntegrityStatus> {
  @override
  IntegrityStatus build() => const IntegrityStatus();

  /// Takes the decision of an assessment. Returns true when this is the first assessment of the session (the one that is reported).
  bool apply(IntegrityDecision decision) {
    final bool first = !state.assessed;
    state = state.copyWith(decision: decision, assessed: true);
    return first;
  }

  void dismissWarning() => state = state.copyWith(warningDismissed: true);

  /// Nobody is signed in any more: the next session starts from nothing, so nothing is known, restricted or dismissed. The session
  /// depends on this state through the biometric unlock, so the state does not depend on the session: the monitor calls this.
  void reset() => state = const IntegrityStatus();
}

final NotifierProvider<IntegrityController, IntegrityStatus> integrityProvider = NotifierProvider<IntegrityController, IntegrityStatus>(IntegrityController.new);

/// The pinning mode the server asks for (the field `pinning_mode` of the version policy); it can only relax what the build has
/// (D-SEC-02), and null means the server said nothing.
class RemotePinningModeNotifier extends Notifier<PinningMode?> {
  @override
  PinningMode? build() => null;

  void set(PinningMode? mode) => state = mode;
}

final NotifierProvider<RemotePinningModeNotifier, PinningMode?> remotePinningModeProvider =
    NotifierProvider<RemotePinningModeNotifier, PinningMode?>(RemotePinningModeNotifier.new);

/// The pinning policy in force: the one of the build, lowered by the server and never tightened by it. For the pilot the build's
/// policy is `off` ([kPinningPolicy]), so this is `off` whatever the server says; the three HTTP sites ask this provider when
/// the conditions of D-SEC-02 for raising it are met.
final Provider<PinningPolicy> pinningPolicyProvider = Provider<PinningPolicy>(
  (Ref ref) => kPinningPolicy.loweredBy(ref.watch(remotePinningModeProvider)),
);
