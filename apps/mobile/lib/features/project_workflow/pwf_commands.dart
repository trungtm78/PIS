import '../../core/navigation/feature.dart' show ScreenTarget;
import '../../core/offline/queue/queued_command.dart';

/// The commands of the work on a task that the phone queues offline (`docs/mob-sync.md`). Each stands for one operation of the workflow
/// and is carried out by the server exactly as if it had been sent online. A decision of another person (an approval, a return) and a
/// signing are not among them: they are made online, on the version the person is looking at.
const String kPwfStartCommand = 'pwf.task.start';
const String kPwfChecklistCommand = 'pwf.task.checklist.complete';
const String kPwfEvidenceCommand = 'pwf.task.evidence.attach';
const String kPwfCompleteCommand = 'pwf.task.complete';
const String kPwfExceptionCommand = 'pwf.task.exception.request';

const List<String> kPwfQueuedCommands = <String>[kPwfStartCommand, kPwfChecklistCommand, kPwfEvidenceCommand, kPwfCompleteCommand, kPwfExceptionCommand];

/// The commands that change the version of the task: the server checks the version the phone saw (`If-Match`). Evidence and a request for an
/// exception are written beside the task and leave its version alone.
const Set<String> kPwfVersionedCommands = <String>{kPwfStartCommand, kPwfChecklistCommand, kPwfCompleteCommand};

/// The exception kinds a doer may ask for: the delay is "ask for more time" (a day range that the KPI does not count against the person once it
/// is approved by someone else), the pause stops the clock, a waiver covers a requirement that cannot be met.
const List<String> kPwfExceptionKinds = <String>['EXTERNAL_DELAY', 'PAUSE', 'WAIVE_REQUIREMENT'];

/// The shortest reason the workflow accepts for an exception, a return or a response (`min_reason_length` of the rules).
const int kPwfMinReasonLength = 20;

bool isPwfCommand(QueuedCommand command) => command.commandType.startsWith('pwf.task.');

/// The task a queued command is about. The queue keeps it beside the payload ([QueuedCommand.subjectRef]): a command the server has taken keeps no payload, and its receipt
/// still has to say which task the version it produced belongs to. The payload is the way for a command that was queued before the queue kept the task apart.
String? pwfTaskOf(QueuedCommand command) {
  final String? subject = command.subjectRef;
  if (subject != null) return subject;
  final Object? id = command.payload?['task_id'];
  return id is String ? id : null;
}

/// The newest version of the task the phone knows: the one it last read, or a newer one that the server answered to a command of the person that it has since taken (a
/// receipt keeps the version that command produced). A screen that could not read the task again after the command still bases the next one on the right version.
int pwfKnownVersion(Iterable<QueuedCommand> commands, String taskId, int readVersion) => commands
    .where((QueuedCommand c) => isPwfCommand(c) && c.state == CommandState.accepted && pwfTaskOf(c) == taskId)
    .fold<int>(readVersion, (int most, QueuedCommand c) => c.serverVersion != null && c.serverVersion! > most ? c.serverVersion! : most);

/// The commands of a task that go back to the queue when the person sends their work again on the version `serverVersion` the server holds, with the version each is based on, in the
/// order they were made. From the first command in conflict on, the commands that have not been taken follow; each is based on the server's version plus the versioned commands
/// before it (the ones before the first conflict that are still waiting count too). A command the server refused for good is left out and counts for nothing: the commands after it
/// were based on a version the server never reached, so their new base can be lower than their old one.
List<({String id, int baseServerVersion})> pwfResendPlan(List<QueuedCommand> commands, String taskId, int serverVersion) {
  final List<QueuedCommand> mine = pwfCommandsOf(commands, taskId);
  final int first = mine.indexWhere((QueuedCommand c) => c.state == CommandState.conflict);
  if (first < 0) return const <({String id, int baseServerVersion})>[];
  int before = mine.take(first).where((QueuedCommand c) => c.state != CommandState.rejected && kPwfVersionedCommands.contains(c.commandType)).length;
  final List<({String id, int baseServerVersion})> steps = <({String id, int baseServerVersion})>[];
  for (final QueuedCommand command in mine.skip(first)) {
    if (command.state != CommandState.conflict && command.state != CommandState.queued) continue;
    steps.add((id: command.id, baseServerVersion: serverVersion + before));
    if (kPwfVersionedCommands.contains(command.commandType)) before += 1;
  }
  return steps;
}

/// Where a command of the work on a task that came back in conflict is settled: the screen of the task (MOB-79), which shows the task as it is now and sends the work again on its
/// version. Null when the command names no task.
ScreenTarget? pwfConflictScreen(QueuedCommand command) {
  final String? task = pwfTaskOf(command);
  return task == null ? null : ScreenTarget('MOB-79', pathSuffix: '/${Uri.encodeComponent(task)}');
}

/// The commands of one task that have not reached the server for good: waiting, being sent, sent with no answer, refused or in conflict.
List<QueuedCommand> pwfCommandsOf(Iterable<QueuedCommand> commands, String taskId) => <QueuedCommand>[
      for (final QueuedCommand command in commands)
        if (isPwfCommand(command) && pwfTaskOf(command) == taskId && !command.state.isSettled) command,
    ]..sort((QueuedCommand a, QueuedCommand b) => a.createdAt.compareTo(b.createdAt));

/// The version a new command on the task is based on: what the phone read, plus one for each versioned command that is queued before it and
/// will be carried out first (start, a checklist item and complete each add one). A command whose predecessor is refused, or whose task was
/// changed by someone else meanwhile, comes back as a conflict; it is never written over (R39).
int pwfBaseVersion(int readVersion, Iterable<QueuedCommand> pendingOfTask) =>
    readVersion + pendingOfTask.where((QueuedCommand c) => c.state.isPending && kPwfVersionedCommands.contains(c.commandType)).length;

/// The payloads. A field the person left empty is left out, so the server applies its own default.
Map<String, Object?> pwfStartPayload(String taskId, {String? note, String? earlyStartReason}) => <String, Object?>{
      'task_id': taskId,
      if (_has(note)) 'note': note!.trim(),
      if (_has(earlyStartReason)) 'early_start_reason': earlyStartReason!.trim(),
    };

Map<String, Object?> pwfChecklistPayload(String taskId, String itemCode, {String? note}) => <String, Object?>{
      'task_id': taskId,
      'item_code': itemCode,
      if (_has(note)) 'note': note!.trim(),
    };

Map<String, Object?> pwfCompletePayload(String taskId, {String? note}) => <String, Object?>{
      'task_id': taskId,
      if (_has(note)) 'note': note!.trim(),
    };

Map<String, Object?> pwfEvidencePayload(
  String taskId, {
  required String evidenceKind,
  String? itemCode,
  String? legalDocType,
  String? formTemplateCode,
  String? externalRef,
  String? note,
}) =>
    <String, Object?>{
      'task_id': taskId,
      'evidence_kind': evidenceKind,
      if (_has(itemCode)) 'item_code': itemCode,
      if (_has(legalDocType)) 'legal_doc_type': legalDocType,
      if (_has(formTemplateCode)) 'form_template_code': formTemplateCode,
      if (_has(externalRef)) 'external_ref': externalRef!.trim(),
      if (_has(note)) 'note': note!.trim(),
    };

Map<String, Object?> pwfExceptionPayload(String taskId, {required String kind, required String reason, String? validFrom, String? validTo, List<String> items = const <String>[]}) =>
    <String, Object?>{
      'task_id': taskId,
      'kind': kind,
      'reason': reason.trim(),
      if (validFrom != null) 'valid_from': validFrom,
      if (validTo != null) 'valid_to': validTo,
      if (items.isNotEmpty) 'items': items,
    };

bool _has(String? value) => value != null && value.trim().isNotEmpty;

/// What a person has to write before a reason is sent: the server enforces it, the phone says so first.
bool pwfReasonIsLongEnough(String reason) => reason.trim().length >= kPwfMinReasonLength;
