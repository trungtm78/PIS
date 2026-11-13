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

/// The task a queued command is about.
String? pwfTaskOf(QueuedCommand command) {
  final Object? id = command.payload?['task_id'];
  return id is String ? id : null;
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
