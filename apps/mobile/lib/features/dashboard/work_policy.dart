import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../read_support/wire.dart';
import 'alerts.dart';

/// The snooze policy as the server publishes it (`getWorkClockPolicies`, the policy of type `SNOOZE_POLICY`). The reasons, the
/// days of each level and the number of snoozes in a row are data of the policy: the phone never holds a number of its own.
final class SnoozePolicyView {
  const SnoozePolicyView({
    required this.reasons,
    required this.noteRequiredFor,
    required this.maxDays,
    required this.maxConsecutive,
    required this.finalNotifies,
    this.version,
    this.unverified = false,
  });

  /// The reason codes a person may give, in the order of the policy.
  final List<String> reasons;

  /// The reason codes that need a written note.
  final Set<String> noteRequiredFor;

  /// The longest snooze, in days, for each level the policy gives a cap for.
  final Map<AlertSeverity, int> maxDays;

  /// How many snoozes in a row an alert may have.
  final int maxConsecutive;

  /// The last allowed snooze tells the next level up.
  final bool finalNotifies;
  final int? version;

  /// The policy is configuration that has not been verified against its legal source yet.
  final bool unverified;

  /// The cap of [severity] in days, or null when the policy gives none for it.
  int? maxDaysOf(AlertSeverity severity) => maxDays[severity];

  bool needsNote(String reasonCode) => noteRequiredFor.contains(reasonCode);
}

/// The snooze policy in the answer of `getWorkClockPolicies` (`{policies: [{type, version, unverified, params}]}`), or null when the
/// answer holds no usable one: no `SNOOZE_POLICY`, no reasons, no whole number of snoozes in a row, or no cap for any level.
SnoozePolicyView? parseSnoozePolicy(Object? raw) {
  for (final Object? entry in listOf(asRecord(raw)?['policies'])) {
    final Json? policy = asRecord(entry);
    if (policy == null || policy['type'] != 'SNOOZE_POLICY') continue;
    final Json? params = asRecord(policy['params']);
    if (params == null) return null;
    final List<String> reasons = <String>[for (final Object? code in listOf(params['reasons'])) ?filled(code)];
    final int? maxConsecutive = whole(params['max_consecutive']);
    final Json? days = asRecord(params['max_days_by_severity']);
    final Map<AlertSeverity, int> maxDays = <AlertSeverity, int>{
      if (days != null)
        for (final MapEntry<String, AlertSeverity> level in const <String, AlertSeverity>{
          'URGENT': AlertSeverity.urgent,
          'ACTION': AlertSeverity.action,
          'WATCH': AlertSeverity.watch,
        }.entries)
          if (whole(days[level.key]) case final int value when value > 0) level.value: value,
    };
    if (reasons.isEmpty || maxConsecutive == null || maxConsecutive < 1 || maxDays.isEmpty) return null;
    return SnoozePolicyView(
      reasons: reasons,
      noteRequiredFor: <String>{for (final Object? code in listOf(params['note_required_for'])) ?filled(code)},
      maxDays: maxDays,
      maxConsecutive: maxConsecutive,
      finalNotifies: params['final_notifies_next_level'] == true,
      version: whole(policy['version']),
      unverified: policy['unverified'] == true,
    );
  }
  return null;
}

/// Reads the snooze policy. An answer that cannot be used is an error, never a default: the sheet shows it with a retry and keeps
/// its button off.
Future<SnoozePolicyView> readSnoozePolicy(MachvonApiClient client) async {
  final SnoozePolicyView? policy = parseSnoozePolicy(await client.getWorkClockPolicies());
  if (policy == null) throw ApiError.unusableAnswer(200, 'work-clock-policies');
  return policy;
}

/// The reader of the policy. It is read each time a sheet opens (the policy is versioned data and may have changed).
class WorkPolicyReader {
  const WorkPolicyReader(this.client);

  final MachvonApiClient client;

  Future<SnoozePolicyView> snooze() => readSnoozePolicy(client);
}

final Provider<WorkPolicyReader> workPolicyReaderProvider = Provider<WorkPolicyReader>((Ref ref) => WorkPolicyReader(ref.watch(apiClientProvider)));

/// A failure is shown with its code and the person retries: Riverpod's automatic retry would hide it behind a spinner.
Duration? _noRetry(int retryCount, Object error) => null;

final FutureProvider<SnoozePolicyView> snoozePolicyProvider = FutureProvider.autoDispose<SnoozePolicyView>(retry: _noRetry, (Ref ref) => ref.watch(workPolicyReaderProvider).snooze());
