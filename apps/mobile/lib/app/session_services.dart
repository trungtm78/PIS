import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/offline/offline_providers.dart';
import '../core/session/session.dart';
import '../features/release/integrity_monitor.dart';
import '../features/session/session_providers.dart';

/// What must run for as long as a person is signed in, whatever screen is open (ST-MOB-041, SYNC-01 and SEC-01):
///
///  * the queue runner and the upload runner, so a command or an upload that was queued before the phone was killed is sent when
///    the application starts, when the device comes back online and when a wait ends, and not when a screen happens to read them;
///  * the publisher of the sync banner, so the banner and MOB-44 count what the queue really holds;
///  * the sync coordinator, which deletes the local store when the server revokes the scope, and the sign-out that follows
///    (AC-ST-MOB-041-3);
///  * the assessment of the phone (INTEG-01): the integrity signals once per session, under the mode of the tenant.
///
/// Nobody signed in, or a store that cannot be opened, is not an error here: each provider holds its own failure and the screens
/// that need the store show it.
class SessionServices extends ConsumerWidget {
  const SessionServices({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen<bool>(scopeRevocationProvider, (bool? previous, bool revoked) {
      if (!revoked) return;
      ref.read(scopeRevocationProvider.notifier).acknowledge();
      // The store was deleted by the coordinator before the flag was raised: nothing is left to keep or to send.
      unawaited(ref.read(authServiceProvider).signOut(discardPending: true));
    });
    ref.watch(integrityMonitorProvider);
    if (ref.watch(sessionProvider.select((SessionSnapshot s) => s.isSignedIn))) {
      ref.watch(queueRunnerProvider);
      ref.watch(uploadRunnerProvider);
      ref.watch(syncStatusPublisherProvider);
      ref.watch(syncCoordinatorProvider);
    }
    return child;
  }
}
