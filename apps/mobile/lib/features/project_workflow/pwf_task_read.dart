import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart' show apiClientProvider;
import '../../core/session/session.dart';
import '../read_support/clock.dart';
import '../read_support/loaded.dart';
import '../read_support/read_cache.dart';
import 'pwf_models.dart';
import 'pwf_step_logic.dart';

/// The task of a row of MOB-78, read for the sheet of its actions: what the person may do on it (`can_claim`, `can_complete`, the blockers) is only in the detail of the
/// task. It follows the rules of BR-MOB-01 like every read of the phone and shares the copy of MOB-79 (the same key), so a task the person has opened has its copy here:
/// the server is asked first; when it cannot be reached the copy of the last read is shown, marked as a copy ([Loaded.fromCache]); a refusal never falls back to a copy and drops it.
final pwfSheetTaskProvider = FutureProvider.autoDispose.family<Loaded<PwfTaskDetail>, String>((Ref ref, String taskId) async {
  final SessionSnapshot session = ref.watch(sessionProvider);
  final String? tenant = session.tenantId;
  final String? user = session.userId;
  final MachvonApiClient client = ref.watch(apiClientProvider);
  final ReadCache cache = ref.read(readCacheProvider);
  final DateTime Function() now = ref.read(clockProvider);
  final String key = 'pwf.task.$taskId';
  final CacheScope? scope = tenant == null || user == null ? null : CacheScope(tenantId: tenant, userId: user);
  try {
    final Object? raw = await client.getProjectTask(taskId: taskId);
    final PwfTaskDetail? value = parsePwfTaskDetail(raw);
    if (value == null) throw const ContractMismatch('getProjectTask', 'does not hold what the screen needs');
    final DateTime fetchedAt = now();
    if (scope != null) await cache.write(scope, key, CacheEntry(raw: raw, asOf: value.asOf, fetchedAt: fetchedAt));
    return Loaded<PwfTaskDetail>(value: value, source: DataSource.network, asOf: value.asOf, fetchedAt: fetchedAt);
  } on ApiError catch (error) {
    if (error.code == networkErrorCode && scope != null) {
      final CacheEntry? entry = await cache.read(scope, key);
      final PwfTaskDetail? copy = entry == null ? null : parsePwfTaskDetail(entry.raw);
      if (entry != null && copy != null) return Loaded<PwfTaskDetail>(value: copy, source: DataSource.cache, asOf: entry.asOf, fetchedAt: entry.fetchedAt);
    } else if (scope != null && (error.status == 403 || error.status == 401)) {
      await cache.forget(scope, key);
    }
    rethrow;
  }
});

/// The schedule of the project, read after the workflow for two sentences only: how far the whole file stands behind its first baseline and which step drives another.
/// It is never needed to show the list, so a read that fails (no connection, no right to the schedule) is the absence of the two sentences, not an error: null.
Future<PwfScheduleHints?> readPwfScheduleHints(MachvonApiClient client, String projectId) async {
  try {
    return parsePwfScheduleHints(await client.getProjectSchedule(projectId: projectId));
  } on Object {
    return null;
  }
}
