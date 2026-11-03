import 'package:machvon_api_client/machvon_api_client.dart' show ApiError;

import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../model/report_view.dart';
import 'report_drafts.dart';

/// The two commands of the weekly report that travel through the offline queue (`docs/mob-sync.md`).
const String kSaveCommand = 'report.draft.save';
const String kSubmitCommand = 'report.submit';

/// Where the sending of a draft stands, read from the commands of the queue that were made from it (MOB.md 4).
enum SubmitStage {
  /// No command of the draft is in flight and none was refused.
  idle,

  /// A command waits for the network or for its turn.
  queued,

  /// A command was sent and its answer has not arrived.
  sending,

  /// The answer of a command was lost: the server may have carried it out. It is looked up by its key and never made again.
  unknown,

  /// The server carried out the submit.
  submitted,

  /// The server refused a command with a code of the platform (`PERIOD_LOCKED`, `LICENSE_EXPIRED`, ...); the draft is intact.
  rejected,

  /// The report moved on since the draft was based on it; the person chooses (MOB-42).
  conflict;

  bool get isPending => this == queued || this == sending || this == unknown;
}

/// The stage of the sending of one draft and the command that decides it.
final class SubmitStatus {
  const SubmitStatus(this.stage, [this.command]);

  final SubmitStage stage;
  final QueuedCommand? command;

  bool get isPending => stage.isPending;

  /// The command that is the sending itself, as opposed to the save of the draft that comes before it.
  bool get isSubmit => command?.commandType == kSubmitCommand;

  String? get code => command?.errorCode;

  /// The id of the report the server made or changed, once the submit is accepted.
  String? get reportId => command?.resultRef;
}

/// The stage of the sending of the draft [draftId] from the commands of the queue. Of the commands made after the last discarded one,
/// the last submit decides; without one the last save does, and a save the server accepted leaves the draft ready to submit
/// ([SubmitStage.idle]). With nothing after a discard the draft is ready to submit.
SubmitStatus submitStatusOf(Iterable<QueuedCommand> commands, String draftId) {
  final List<QueuedCommand> mine = <QueuedCommand>[
    for (final QueuedCommand command in commands)
      if (command.draftId == draftId && (command.commandType == kSaveCommand || command.commandType == kSubmitCommand)) command,
  ]..sort((QueuedCommand a, QueuedCommand b) => a.createdAt.compareTo(b.createdAt));
  // A discarded command is a decision of the person that replaced what it stood for: it and everything made before it no longer
  // count, but what was made after it decides, whatever its state (a new save that waits must not be reported as idle).
  final int lastDiscarded = mine.lastIndexWhere((QueuedCommand c) => c.state == CommandState.discarded);
  final List<QueuedCommand> live = mine.sublist(lastDiscarded + 1);
  final QueuedCommand? submit = live.where((QueuedCommand c) => c.commandType == kSubmitCommand).lastOrNull;
  final QueuedCommand? decisive = submit ?? live.lastOrNull;
  if (decisive == null) return const SubmitStatus(SubmitStage.idle);
  switch (decisive.state) {
    case CommandState.queued:
      return SubmitStatus(SubmitStage.queued, decisive);
    case CommandState.sending:
      return SubmitStatus(SubmitStage.sending, decisive);
    case CommandState.unknown:
      return SubmitStatus(SubmitStage.unknown, decisive);
    case CommandState.accepted:
      return decisive.commandType == kSubmitCommand ? SubmitStatus(SubmitStage.submitted, decisive) : const SubmitStatus(SubmitStage.idle);
    case CommandState.rejected:
      return SubmitStatus(SubmitStage.rejected, decisive);
    case CommandState.conflict:
      return SubmitStatus(SubmitStage.conflict, decisive);
    case CommandState.discarded:
      return const SubmitStatus(SubmitStage.idle);
  }
}

/// How a tap on Submit ended.
enum SubmitOutcome {
  /// The draft is not on this phone any more.
  missing,

  /// A command of the draft is already in flight; nothing new was made.
  alreadyPending,

  /// The review found errors that stop the sending; nothing was queued.
  blocked,

  /// The draft was saved to the server and the submit was queued (and sent when the network allowed).
  submitted,

  /// The server holds something other than what the phone saved (somebody changed the report meanwhile): nothing was submitted
  /// and the person decides which copy to keep.
  moved,

  /// The draft is not on the server yet, or its save has not been carried out: the submit waits for the person to try again.
  savePending,
}

final class SubmitResult {
  const SubmitResult(this.outcome, {this.findings = const <Finding>[], this.blocker, this.reportId});

  final SubmitOutcome outcome;

  /// The errors that stopped the sending ([SubmitOutcome.blocked]).
  final List<Finding> findings;

  /// What stopped the last flush, for the notice under the button.
  final FlushBlocker? blocker;

  /// The report on the server the draft stands for, once it exists there. The draft is released when the server accepts the submit, so
  /// this is how a screen still knows which report the result is about.
  final String? reportId;
}

/// Sends a draft of the weekly report to the server through the offline queue, exactly once (ST-MOB-012).
///
/// The server judges the submit under the version of the last save, so the sending is two commands in order: the save of the
/// draft as the person entered it (`report.draft.save`, skipped when the server already holds it) and, once the server accepted
/// it, the submit (`report.submit`, one command with its own idempotency key; the draft is released when the server accepts it).
/// Every command is made once: a second tap, a lost answer and a restart find the command that exists and look it up by its key;
/// none of them makes a second one. Nothing is sent from a cache: the report is the draft, validated here and judged again by the server.
class SubmitFlow {
  SubmitFlow({required ReportDrafts drafts, required CommandQueue queue, required bool Function() isOnline})
      : _drafts = drafts,
        _queue = queue,
        _isOnline = isOnline;

  final ReportDrafts _drafts;
  final CommandQueue _queue;
  final bool Function() _isOnline;
  final Set<String> _inFlight = <String>{};

  SubmitStatus statusOf(String draftId) => submitStatusOf(_queue.commands(), draftId);

  /// Hands the draft in. Throws what the server refused while the report was made on it (`ApiError`) and [DraftExists] when the
  /// project already has a draft on the server and this one holds entries.
  Future<SubmitResult> submit(String draftId) async {
    if (!_inFlight.add(draftId)) return const SubmitResult(SubmitOutcome.alreadyPending);
    try {
      return await _submit(draftId);
    } finally {
      _inFlight.remove(draftId);
    }
  }

  Future<SubmitResult> _submit(String draftId) async {
    DraftSnapshot? current = _drafts.read(draftId);
    if (current == null) return const SubmitResult(SubmitOutcome.missing);
    if (statusOf(draftId).isPending) return const SubmitResult(SubmitOutcome.alreadyPending);
    final List<Finding> errors = <Finding>[for (final Finding finding in reviewForm(current.form, current.context)) if (finding.isError) finding];
    if (errors.isNotEmpty) return SubmitResult(SubmitOutcome.blocked, findings: errors);
    current = current.reportId == null ? await _drafts.ensureRecord(draftId) : current;
    _discardRefused(draftId);
    current = _drafts.read(draftId)!;
    FlushResult? flushed;
    if (current.draft.status != DraftStatus.synced) {
      final QueuedCommand save = _queue.enqueue(
        commandType: kSaveCommand,
        payload: current.form.toPayload(current.reportId!),
        baseServerVersion: current.draft.baseServerVersion,
        draftId: draftId,
      );
      // A phone known to be offline queues the command and leaves the sending to the moment the network is back.
      if (!_isOnline()) return SubmitResult(SubmitOutcome.savePending, blocker: FlushBlocker.offline, reportId: current.reportId);
      flushed = await _queue.flush();
      if (_queue.command(save.id)?.state != CommandState.accepted) return SubmitResult(SubmitOutcome.savePending, blocker: flushed.blocker, reportId: current.reportId);
      current = _drafts.read(draftId)!;
    }
    final SubmitOutcome? unverified = await _verifySave(draftId);
    if (unverified != null) return SubmitResult(unverified, reportId: current.reportId);
    current = _drafts.read(draftId)!;
    _queue.enqueue(
      commandType: kSubmitCommand,
      payload: <String, Object?>{'report_id': current.reportId},
      baseServerVersion: current.draft.baseServerVersion,
      draftId: draftId,
      releaseDraft: true,
    );
    if (!_isOnline()) return SubmitResult(SubmitOutcome.submitted, blocker: FlushBlocker.offline, reportId: current.reportId);
    flushed = await _queue.flush();
    return SubmitResult(SubmitOutcome.submitted, blocker: flushed.blocker, reportId: current.reportId);
  }

  /// The submit is judged under the version of the last save. When the answer to that save was lost and found by its key, the phone
  /// knows it was accepted but not the version it made; the server is asked, and the version is taken only if the copy it holds is the
  /// one the phone sent. A copy that differs is somebody else's change, which a submit must never hand in as the person's own; a
  /// server that cannot be asked leaves the submit for later. Null when the submit may go.
  Future<SubmitOutcome?> _verifySave(String draftId) async {
    final DraftSnapshot current = _drafts.read(draftId)!;
    final QueuedCommand? save = _queue.commands(states: <CommandState>{CommandState.accepted}).where((QueuedCommand c) => c.draftId == draftId && c.commandType == kSaveCommand).lastOrNull;
    if (save == null || save.serverVersion != null || current.draft.baseServerVersion > save.baseServerVersion) return null;
    final ReportView view;
    try {
      view = await _drafts.fetch(current.reportId!);
    } on ApiError {
      return SubmitOutcome.savePending;
    }
    if (!sameFigures(view.form, current.form)) return SubmitOutcome.moved;
    _drafts.markSynced(draftId, view.version);
    return null;
  }

  /// A command the server refused, or that found the report moved on, is a decision the person is now replacing with a new
  /// entry of the draft: it leaves the queue so that it is not sent again beside the new one.
  void _discardRefused(String draftId) {
    for (final QueuedCommand command in _queue.commands(states: <CommandState>{CommandState.rejected, CommandState.conflict})) {
      if (command.draftId == draftId && (command.commandType == kSaveCommand || command.commandType == kSubmitCommand)) _queue.discard(command.id);
    }
  }

  /// Sends the refused submit again as a new decision of the person, or looks up the one whose answer was lost.
  Future<FlushResult> resend(String commandId) => _queue.retry(commandId);

  /// Looks up what the server did with the commands whose answer was lost, and sends what is due.
  Future<FlushResult> check() => _queue.flush();
}
