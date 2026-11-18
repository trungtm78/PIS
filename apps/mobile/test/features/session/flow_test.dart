import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/state/screen_state.dart';
import 'package:machvon_mobile/features/session/auth/oidc_client.dart';
import 'package:machvon_mobile/features/session/flow.dart';

/// A flow as a screen owns it: it goes with the screen (auto-dispose).
final NotifierProvider<FlowNotifier, FlowState> _flow = NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

void main() {
  group('L2 a flow whose screen went while its action ran', () {
    late ProviderContainer container;
    setUp(() => container = ProviderContainer());
    tearDown(() => container.dispose());

    /// Starts [action] on a flow a screen listens to, takes the screen away (the provider is disposed) and gives the future of the run.
    Future<T?> runThenLeave<T>(Future<T> Function() action) async {
      final ProviderSubscription<FlowState> screen = container.listen<FlowState>(_flow, (FlowState? previous, FlowState next) {});
      final FlowNotifier notifier = container.read(_flow.notifier);
      // A write to the state of a disposed notifier would complete this future with the error ("after it has been disposed").
      final Future<T?> running = notifier.run(action);
      expect(container.read(_flow).busy, isTrue);
      screen.close();
      // An auto-dispose provider nobody listens to goes at the next turn of the scheduler.
      await container.pump();
      expect(container.exists(_flow), isFalse, reason: 'the notifier is disposed before the action ends');
      return running;
    }

    test('an action that succeeds after the screen went returns its result and touches no state', () async {
      final Completer<String> action = Completer<String>();
      final Future<String?> running = runThenLeave<String>(() => action.future);
      await Future<void>.delayed(Duration.zero);
      action.complete('signed in');
      expect(await running, 'signed in', reason: 'the sign-in did happen: the caller is told, and nothing is thrown');
    });

    test('an action that fails after the screen went is dropped: nothing is thrown, no other provider is read', () async {
      final Completer<String> action = Completer<String>();
      final Future<String?> running = runThenLeave<String>(() => action.future);
      await Future<void>.delayed(Duration.zero);
      action.completeError(const OidcException(OidcFailure.tokenExchangeFailed));
      expect(await running, isNull, reason: 'neither the failure nor "after it has been disposed" reaches the caller');
    });

    test('a flow whose screen stays keeps its states: loading while it runs, the failure with its code, nothing after a success', () async {
      final ProviderSubscription<FlowState> screen = container.listen<FlowState>(_flow, (FlowState? previous, FlowState next) {});
      addTearDown(screen.close);
      final FlowNotifier notifier = container.read(_flow.notifier);
      final Completer<int> first = Completer<int>();
      final Future<int?> running = notifier.run<int>(() => first.future);
      expect(container.read(_flow).state, ScreenState.loading);
      expect(await notifier.run<int>(() async => 2), isNull, reason: 'a second tap while it runs does nothing');
      first.complete(1);
      expect(await running, 1);
      expect(container.read(_flow).state, ScreenState.defaultState);

      expect(await notifier.run<int>(() async => throw const OidcException(OidcFailure.tokenExchangeFailed)), isNull);
      expect(container.read(_flow).state, ScreenState.error);
      expect(container.read(_flow).problem?.code, 'OIDC_TOKEN_EXCHANGE_FAILED');

      expect(await notifier.run<int>(() async => throw const OidcException(OidcFailure.browserCancelled)), isNull);
      expect(container.read(_flow).state, ScreenState.defaultState, reason: 'closing the browser is not a failure');
    });
  });
}
