import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart' show apiClientProvider;
import '../command_support/command_outcome.dart';
import '../read_support/attempts.dart';

/// The two commands of the step table that are made ONLINE only (PWF-5): taking a task ("Nhận việc", R71) and asking for more time for a step (R72).
/// Neither is queued and neither is sent from a copy kept on the device, as the approval and the return of a task are not (`PwfDecisionCommands`):
///  * taking a task is first come first served, and the one who is second is refused (`PWF_TASK_ALREADY_CLAIMED`); a claim that waited in a queue for hours would
///    be judged against a team that has since changed, and the person would believe they hold a task they may not;
///  * a request for more time is a proposal on the version of the whole workflow, which a copy of the screen cannot name.
/// Each goes with the idempotency key of the person's intention (a second tap, a retry after a lost answer reuses it, so the server records one command); a final
/// refusal ends the intention, so the same request made again after the cause is gone is a new command with a new key.
class PwfStepCommands {
  PwfStepCommands({required this.client, required this.isOnline});

  final MachvonApiClient client;
  final bool Function() isOnline;
  final AttemptRegistry _claimAttempts = AttemptRegistry();
  final AttemptRegistry _extensionAttempts = AttemptRegistry();

  /// `claimProjectTask`: the server checks the unit, the role and that nobody holds the task, in one transaction. The task has no version to send (the claim does not change it).
  Future<CommandOutcome> claim(String taskId, {bool retryAfterUnknown = false}) => sendCommand(
        isOnline: isOnline,
        attempts: _claimAttempts,
        intention: '$taskId|CLAIM',
        retryAfterUnknown: retryAfterUnknown,
        call: (CommandAttempt attempt) => client.claimProjectTask(const PwfTaskClaim(), taskId: taskId, attempt: attempt),
      );

  /// `proposeProjectReschedule` with one line of `extensions`: [value] more of the unit of the step, on the version of the workflow the person was looking at.
  Future<CommandOutcome> requestExtension({required String projectId, required int workflowVersion, required String taskCode, required int value, required String reason, bool retryAfterUnknown = false}) {
    final String why = reason.trim();
    return sendCommand(
      isOnline: isOnline,
      attempts: _extensionAttempts,
      intention: '$projectId|$workflowVersion|EXTEND|$taskCode|$value|$why',
      retryAfterUnknown: retryAfterUnknown,
      call: (CommandAttempt attempt) => client.proposeProjectReschedule(
        PwfRescheduleRequest(reason: why, extensions: <PwfRescheduleRequestExtensionsItem>[PwfRescheduleRequestExtensionsItem(taskCode: taskCode, addValue: value)]),
        projectId: projectId,
        ifMatchVersion: workflowVersion,
        attempt: attempt,
      ),
    );
  }
}

final Provider<PwfStepCommands> pwfStepCommandsProvider = Provider<PwfStepCommands>(
  (Ref ref) => PwfStepCommands(client: ref.watch(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline),
);
