import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/security/device_integrity.dart';
import '../../core/security/integrity_state.dart';
import '../../core/session/session.dart';
import 'telemetry.dart';

/// Reads the signals of the phone once per session, applies the mode of the tenant and keeps the decision in [integrityProvider] (which is emptied when the session ends)
/// (ST-MOB-041, INTEG-01, decision D-SEC-01). It runs when a person is signed in and again when the mode the server asks for
/// changes; nobody signed in reads nothing and empties it. The first decision of a session is reported to the telemetry, one `device.integrity` event
/// for each stable reason code and nothing else about the phone; later ones (the mode changed) update the decision without
/// counting the phone twice.
///
/// A detector that fails or does not answer is "unknown" and changes nothing: the application never stops because of a signal.
final FutureProvider<void> integrityMonitorProvider = FutureProvider<void>((Ref ref) async {
  final bool signedIn = ref.watch(sessionProvider.select((SessionSnapshot s) => s.isSignedIn));
  final IntegrityMode mode = ref.watch(integrityModeProvider);
  final IntegrityController controller = ref.read(integrityProvider.notifier);
  if (!signedIn) {
    // Not while this provider is being built: other providers are not to be changed from inside a build.
    await Future<void>.value();
    if (ref.mounted) controller.reset();
    return;
  }
  final IntegrityDecision decision = await ref.read(deviceIntegrityServiceProvider).assess(mode);
  if (!ref.mounted) return;
  if (controller.apply(decision)) {
    final TelemetryService telemetry = ref.read(telemetryProvider);
    for (final String code in decision.reasonCodes) {
      telemetry.record('device.integrity', <String, Object>{'reason_code': code});
    }
  }
});
