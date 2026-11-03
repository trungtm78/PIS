import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/store/local_store.dart';
import '../../read_support/clock.dart';
import 'report_drafts.dart';
import 'submit_flow.dart';

/// A failure to open the store is shown by the screen with a retry button, not retried on its own (nobody signed in would only
/// repeat itself).
Duration? _noRetry(int retryCount, Object error) => null;

/// The drafts of the weekly report of the signed-in user.
final FutureProvider<ReportDrafts> reportDraftsProvider = FutureProvider<ReportDrafts>(retry: _noRetry, (Ref ref) async {
  final LocalStore store = await ref.watch(localStoreProvider.future);
  return ReportDrafts(store: store, client: ref.watch(apiClientProvider), now: ref.watch(clockProvider));
});

/// The sending of a draft through the queue of the signed-in user.
final FutureProvider<SubmitFlow> submitFlowProvider = FutureProvider<SubmitFlow>(retry: _noRetry, (Ref ref) async {
  final ReportDrafts drafts = await ref.watch(reportDraftsProvider.future);
  final CommandQueue queue = await ref.watch(commandQueueProvider.future);
  return SubmitFlow(drafts: drafts, queue: queue, isOnline: () => ref.read(reachabilityProvider) != Reachability.offline);
});
