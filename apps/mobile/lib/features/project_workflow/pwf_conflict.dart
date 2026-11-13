import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/offline/drafts/conflict_adapter.dart';
import '../../core/offline/queue/queued_command.dart';
import '../read_support/wire.dart';
import 'pwf_models.dart';

/// How a `pwf.task.*` command that came back in conflict finds the task the server holds (MOB-42). What a person did offline on a task (start it, tick an
/// item, complete it) is not a field to choose between: the screen of the task (MOB-79) is where it is settled, because the person has to see the task as it
/// is now. Here the server's copy gives its version, so that the command can be sent again on it; nothing of the payload is compared (the ids that
/// name the record are not figures).
const ConflictAdapter pwfTaskConflictAdapter = ConflictAdapter(
  read: _readTask,
  ignore: <String>{'task_id', 'item_code'},
);

Future<ServerCopy> _readTask(MachvonApiClient client, QueuedCommand command) async {
  final Object? id = command.payload?['task_id'];
  if (id is! String) throw StateError('the command names no task');
  final PwfTaskDetail? task = parsePwfTaskDetail(asRecord(await client.getProjectTask(taskId: id)));
  if (task == null) throw const ContractMismatch('getProjectTask', 'does not hold what the screen needs');
  return ServerCopy(version: task.version, fields: <String, Object?>{'status': task.status.name});
}
