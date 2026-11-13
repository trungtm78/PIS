import 'dart:convert';

import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/features/project_workflow/pwf_commands.dart';

import '../../support/fake_sync_server.dart';
import '../field_issues/field_world.dart';
import '../support/scripted_server.dart';
import 'pwf_fixtures.dart';

/// One task on a fake server that does what the real one does with the commands a phone queues (`docs/mob-sync.md`, `PwfTaskStore`): a versioned
/// command is carried out only on the version the server holds (a conflict otherwise, never written over), start, a checklist item and complete each
/// move the version by one, evidence and a request for an exception leave it, and a command that the state does not allow is refused with its code.
/// The reads, the decisions made online and the sync endpoints are all behind one switch, as a phone with no signal.
class PwfTaskServer {
  PwfTaskServer(this.state, {FakeSyncServer? sync}) {
    this.sync = sync ?? FakeSyncServer();
    this.sync.decide = _decide;
    api = ScriptedServer()
      ..on('GET', '/project-tasks/:id', (_) => taskDetailJson(state, blockers: blockers))
      ..answer('POST', '/project-tasks/:id/approve-completion', (HttpCall call) async => _decision(call, 'AWAITING_APPROVAL', 'DONE'))
      ..answer('POST', '/project-tasks/:id/return', (HttpCall call) async => _decision(call, 'AWAITING_APPROVAL', 'IN_PROGRESS'))
      ..answer('POST', '/project-tasks/:id/resume', (HttpCall call) async => _decision(call, 'ON_HOLD', 'IN_PROGRESS'));
    field = FieldServer(sync: this.sync, api: api);
  }

  final TaskState state;
  late final FakeSyncServer sync;
  late final ScriptedServer api;
  late final FieldServer field;

  /// What the completion still lacks, as the read says it.
  List<Map<String, Object?>>? blockers;

  /// The commands the server carried out, in order: type and the version it based them on.
  final List<({String type, int base})> applied = <({String type, int base})>[];

  /// The decisions made online, with the version they were based on.
  final List<({String path, String? ifMatch, Map<String, Object?> body})> decisions = <({String path, String? ifMatch, Map<String, Object?> body})>[];

  /// What another person did to the task while the phone was offline.
  void changedByAnotherPerson({String? checklist}) {
    state.version += 1;
    if (checklist != null) state.checklistDone = <String>{...state.checklistDone, checklist};
  }

  ServerOutcome _decide(Map<String, Object?> item) {
    final String type = item['command_type']! as String;
    final int base = item['base_server_version']! as int;
    final Map<String, Object?> payload = item['payload']! as Map<String, Object?>;
    if (kPwfVersionedCommands.contains(type) && base != state.version) return ServerOutcome.conflict(version: state.version);
    String? refusal;
    switch (type) {
      case kPwfStartCommand:
        if (state.status != 'NOT_STARTED') {
          refusal = 'PWF_TASK_STATE_INVALID';
        } else {
          state.status = 'IN_PROGRESS';
          state.version += 1;
        }
      case kPwfChecklistCommand:
        if (!state.inProgress) {
          refusal = 'PWF_TASK_STATE_INVALID';
        } else {
          state.checklistDone = <String>{...state.checklistDone, payload['item_code']! as String};
          state.version += 1;
        }
      case kPwfEvidenceCommand:
        if (!state.inProgress) {
          refusal = 'PWF_TASK_STATE_INVALID';
        } else {
          state.evidence.add(<String, Object?>{
            'id': 'e${state.evidence.length + 1}',
            'item_code': payload['item_code'],
            'evidence_kind': payload['evidence_kind'],
            'document_id': null,
            'legal_doc_type': payload['legal_doc_type'],
            'form_template_code': payload['form_template_code'],
            'external_ref': payload['external_ref'],
            'note': payload['note'],
            'attached_by': 'x',
            'attached_at': kAsOf,
          });
        }
      case kPwfCompleteCommand:
        if (!state.inProgress) {
          refusal = 'PWF_TASK_STATE_INVALID';
        } else {
          state.status = state.approverRole == null ? 'DONE' : 'AWAITING_APPROVAL';
          state.version += 1;
        }
      case kPwfExceptionCommand:
        state.exceptions.add(<String, Object?>{
          'id': 'x${state.exceptions.length + 1}',
          'task_id': kTaskId,
          'kind': payload['kind'],
          'items': <Object?>[],
          'valid_from': payload['valid_from'],
          'valid_to': payload['valid_to'],
          'reason': payload['reason'],
          'evidence_ref': null,
          'status': 'REQUESTED',
          'requested_by': 'x',
          'decided_by': null,
          'decided_at': null,
          'decision_note': null,
          'version': 1,
        });
      default:
        refusal = 'VALIDATION_FAILED';
    }
    if (refusal != null) return ServerOutcome.rejected(refusal);
    applied.add((type: type, base: base));
    return ServerOutcome.accepted(version: state.version);
  }

  HttpResult _decision(HttpCall call, String from, String to) {
    final String? ifMatch = call.headers['if-match'];
    final Map<String, Object?> body = call.body == null ? <String, Object?>{} : jsonDecode(call.body!) as Map<String, Object?>;
    decisions.add((path: call.url.path.replaceFirst('/v1', ''), ifMatch: ifMatch, body: body));
    if (ifMatch != '"${state.version}"') return _problem(409, 'VERSION_CONFLICT');
    if (state.status != from) return _problem(422, 'PWF_TASK_STATE_INVALID');
    state.status = to;
    state.version += 1;
    return HttpResult(status: 200, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(<String, Object?>{'operation_id': 'o1', 'status': to, 'resource_version': state.version}));
  }

  HttpResult _problem(int status, String code) => HttpResult(
        status: status,
        headers: const <String, String>{'content-type': 'application/problem+json'},
        body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code}),
      );
}
