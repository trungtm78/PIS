/// How a connection that was lost is probed again: the runners of the queue and of the uploads wait [delays] one after the other
/// (the last one repeats) and stop after [maxProbes] in a row; a trigger from outside (connectivity, sign-in, a new command or
/// file) starts the count over.
///
/// The only connectivity signal the application has is the outcome of its own requests, so without a probe a phone that regains
/// its connection while the person stays on an idle screen would never send what waited. The probe is the send itself: when it
/// goes through, the transport reports the connection online.
final class OfflineProbePolicy {
  const OfflineProbePolicy({required this.delays, required this.maxProbes});

  /// No probe: only a trigger from outside sends again.
  static const OfflineProbePolicy none = OfflineProbePolicy(delays: <Duration>[], maxProbes: 0);

  /// 15 s, 30 s, 1 min, 2 min, then every 5 min, twelve probes in a row (about an hour).
  static const OfflineProbePolicy standard = OfflineProbePolicy(
    delays: <Duration>[Duration(seconds: 15), Duration(seconds: 30), Duration(minutes: 1), Duration(minutes: 2), Duration(minutes: 5)],
    maxProbes: 12,
  );

  final List<Duration> delays;
  final int maxProbes;
}
