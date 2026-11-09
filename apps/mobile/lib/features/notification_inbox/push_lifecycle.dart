import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart';
import 'push_device.dart';
import 'push_registration.dart';

/// What the push does for a signed-in session, in one place:
///  * the registration of this device is sent (or sent again) when the session starts, and again whenever the provider rotates the token;
///  * a push that arrives in the foreground is acknowledged as delivered (port) and makes the badge and the lists read again;
///  * a push the person taps, or that started the application, opens the opaque link of its notification (`/r/<id>`): the link guard checks
///    the session and the tenant, and the notification screen reads it under the permission of the moment.
///
/// Every step is best effort: a failing receipt or a malformed payload never breaks the application or the push itself.
final class PushLifecycle {
  PushLifecycle({required this.inbound, required this.receipts, required this.open, required this.register});

  final PushInbound inbound;
  final PushReceiptPort receipts;

  /// Opens a location of the application.
  final void Function(String location) open;

  /// Sends the registration of the device.
  final Future<void> Function() register;
  final List<StreamSubscription<PushPayload>> _subscriptions = <StreamSubscription<PushPayload>>[];
  bool _stopped = false;

  Future<void> _acknowledge(PushPayload payload, PushReceiptEvent event) async {
    try {
      await receipts.acknowledge(payload.notificationId, event);
    } on Object {
      // A receipt that cannot be sent is lost, never retried into the push: the notification is still in the inbox.
    }
  }

  void start() {
    unawaited(register());
    _subscriptions.add(inbound.received.listen((PushPayload payload) => unawaited(_acknowledge(payload, PushReceiptEvent.delivered))));
    _subscriptions.add(inbound.opened.listen((PushPayload payload) {
      unawaited(_acknowledge(payload, PushReceiptEvent.opened));
      open(payload.location);
    }));
    unawaited(_launched());
  }

  Future<void> _launched() async {
    final PushPayload? payload = await inbound.launchedBy();
    if (payload == null || _stopped) return;
    unawaited(_acknowledge(payload, PushReceiptEvent.opened));
    open(payload.location);
  }

  void stop() {
    _stopped = true;
    for (final StreamSubscription<PushPayload> subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();
  }
}

/// Runs the push lifecycle for as long as the session lives; the application root watches it while a person is signed in. On a build
/// without push the inbound is empty and the registration finds no token, so it does nothing.
final Provider<PushLifecycle> pushLifecycleProvider = Provider<PushLifecycle>((Ref ref) {
  ref.watch(pushRefreshListenerProvider);
  final PushRegistration registration = ref.watch(pushRegistrationProvider);
  final PushLifecycle lifecycle = PushLifecycle(
    inbound: ref.watch(pushInboundProvider),
    receipts: ref.watch(pushReceiptPortProvider),
    open: (String location) => ref.read(routerProvider).go(location),
    register: () async {
      await registration.sync();
    },
  );
  lifecycle.start();
  ref.onDispose(lifecycle.stop);
  return lifecycle;
});
