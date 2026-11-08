import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../../core/navigation/route_catalogue.dart';
import '../../core/navigation/tab_badges.dart';
import '../../core/session/session.dart';
import '../notification_inbox/notification_commands.dart';
import '../notification_inbox/push_registration.dart';
import 'alerts.dart';

/// The counts of the alerts of the person (`getMyWorkCounts`), and the number on the Notifications tab that follows them. Null until the
/// server has answered: the tab then shows no number (never a 0 that was not read). It reads again when the application opens, when it
/// comes back to the foreground, when a push arrives and when an alert was claimed, given or snoozed here. A failed read keeps the last
/// number; a sign-out clears it.
///
/// The tab shows what is asked of the person now: the urgent and the to-do alerts, not the ones only watched.
class AlertBadge extends Notifier<AlertCounts?> with WidgetsBindingObserver {
  int _generation = 0;
  bool _disposed = false;

  @override
  AlertCounts? build() {
    _disposed = false;
    WidgetsBinding.instance.addObserver(this);
    ref.onDispose(() {
      _disposed = true;
      WidgetsBinding.instance.removeObserver(this);
    });
    final StreamSubscription<void> pushes = ref.read(pushArrivalsProvider).listen((_) => onPush());
    ref.onDispose(pushes.cancel);
    ref.listen<SessionSnapshot>(sessionProvider, (SessionSnapshot? previous, SessionSnapshot next) {
      if (!next.isSignedIn) {
        _generation += 1;
        state = null;
        ref.read(tabBadgeProvider.notifier).set(AppTab.inbox, 0);
      } else if (previous?.tenantId != next.tenantId || previous?.userId != next.userId || previous?.isSignedIn != true) {
        unawaited(refresh());
      }
    });
    ref.listen<int>(alertsChangedProvider, (int? previous, int next) => unawaited(refresh()));
    Future<void>.microtask(refresh);
    return null;
  }

  /// A push arrived: what the server holds changed, so the alerts and the notifications are read again.
  void onPush() {
    ref.read(notificationsChangedProvider.notifier).bump();
    ref.read(alertsChangedProvider.notifier).bump();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (lifecycle == AppLifecycleState.resumed) unawaited(refresh());
  }

  Future<void> refresh() async {
    if (_disposed || !ref.read(sessionProvider).isSignedIn) return;
    final int generation = ++_generation;
    try {
      final AlertCounts? counts = parseAlertCounts(await ref.read(apiClientProvider).getMyWorkCounts(query: const <String, Object?>{'view': 'mine'}));
      if (_disposed || generation != _generation || counts == null) return;
      state = counts;
      ref.read(tabBadgeProvider.notifier).set(AppTab.inbox, counts.needsDoing);
    } on ApiError {
      return;
    }
  }
}

final NotifierProvider<AlertBadge, AlertCounts?> alertBadgeProvider = NotifierProvider<AlertBadge, AlertCounts?>(AlertBadge.new);
