import 'package:machvon_api_client/machvon_api_client.dart';

import '../read_support/attempts.dart';
import 'alerts.dart';

/// How a work action ended: recorded, refused with a stable code (nothing changed), or the answer was lost (the server may or
/// may not have recorded it; sending the same intention again reuses its key).
enum WorkActionOutcome { done, refused, lost }

final class WorkActionResult {
  const WorkActionResult(this.outcome, [this.code]);

  final WorkActionOutcome outcome;
  final String? code;

  bool get ok => outcome == WorkActionOutcome.done;
}

/// The three acts on an alert: take it (`claimWork`), give it to someone by a day (`assignWork`) and remind later (`snoozeWork`).
/// Online only: who holds an alert is the server's word. Each intention keeps its idempotency key across a retry, so a second tap
/// or a lost answer never records the act twice. The server audits every act and refuses a snooze of an urgent alert.
class WorkCommands {
  WorkCommands(this.client);

  final MachvonApiClient client;
  final AttemptRegistry _claims = AttemptRegistry();
  final AttemptRegistry _assignments = AttemptRegistry();
  final AttemptRegistry _snoozes = AttemptRegistry();

  Future<WorkActionResult> claim(AlertItem item) => _run(
        _claims,
        'claim|${item.source}|${item.id}',
        (CommandAttempt attempt) => client.claimWork(WorkActionTarget(source: item.source, sourceId: item.id), attempt: attempt),
      );

  Future<WorkActionResult> assign(AlertItem item, {required String assigneeId, required String dueOn, String? reason}) => _run(
        _assignments,
        'assign|${item.source}|${item.id}|$assigneeId|$dueOn|${reason ?? ''}',
        (CommandAttempt attempt) => client.assignWork(
          WorkActionTarget(source: item.source, sourceId: item.id, assigneeId: assigneeId, dueOn: dueOn, reason: reason),
          attempt: attempt,
        ),
      );

  /// [until] is an instant (ISO 8601, UTC). An urgent alert is not sent: it cannot be snoozed.
  Future<WorkActionResult> snooze(AlertItem item, {required String until, String? reason}) {
    if (!item.canSnooze) return Future<WorkActionResult>.value(const WorkActionResult(WorkActionOutcome.refused, 'URGENT_NOT_SNOOZABLE'));
    return _run(
      _snoozes,
      'snooze|${item.source}|${item.id}|$until|${reason ?? ''}',
      (CommandAttempt attempt) => client.snoozeWork(WorkActionTarget(source: item.source, sourceId: item.id, snoozeUntil: until, reason: reason), attempt: attempt),
    );
  }

  Future<WorkActionResult> _run(AttemptRegistry attempts, String payload, Future<Object?> Function(CommandAttempt attempt) send) async {
    final CommandAttempt attempt = attempts.forPayload(payload);
    try {
      await send(attempt);
      attempts.done();
      return const WorkActionResult(WorkActionOutcome.done);
    } on ApiError catch (error) {
      attempts.ended(error);
      return error.code == networkErrorCode ? const WorkActionResult(WorkActionOutcome.lost) : WorkActionResult(WorkActionOutcome.refused, error.code);
    }
  }
}
