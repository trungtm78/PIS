import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/api/problem.dart';
import '../../core/connectivity/reachability.dart';
import '../../core/di/providers.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../../core/state/screen_state.dart';
import '../../core/state/state_boundary.dart';
import '../../core/state/state_card.dart';

/// Reads what the model said or what it cited. Unlike `DataView` nothing is kept as a copy: the text of a bid is confidential, so it
/// is read again from the server (which judges the person's access at that moment) every time a screen opens, and with no connection
/// the screen says it is offline instead of showing what was read last time. Nothing is written to the device.
typedef FreshReader<T> = Future<T?> Function(MachvonApiClient client);

/// The code of the server's answer for a record that is not in the person's scope or that does not exist: the same answer for both, so
/// that it reveals nothing (a revoked person gets exactly this, UAT-PLAN-43).
const String notFoundCode = 'RESOURCE_NOT_FOUND';

class FreshRead<T> extends ConsumerStatefulWidget {
  const FreshRead({required this.resource, required this.read, required this.builder, this.isEmpty, super.key});

  /// What is being read (a run, a citation, a list): the read is made again when this changes, because a route that keeps its page
  /// while its parameters change would otherwise go on showing the resource that was read first, and let the answer of the old
  /// request fill the new place. Anything with value equality will do.
  final Object resource;

  /// Returns the parsed value, or null when the answer lacks what the screen needs (a contract mismatch, never half a page).
  final FreshReader<T> read;
  final bool Function(T value)? isEmpty;
  final Widget Function(BuildContext context, T value) builder;

  @override
  ConsumerState<FreshRead<T>> createState() => _FreshReadState<T>();
}

class _FreshReadState<T> extends ConsumerState<FreshRead<T>> {
  T? _value;
  ProblemView? _problem;
  bool _notFound = false;
  ScreenState _state = ScreenState.loading;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(FreshRead<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.resource != widget.resource) _load();
  }

  Future<void> _load() async {
    final int generation = ++_generation;
    final SessionSnapshot session = ref.read(sessionProvider);
    if (!session.isSignedIn) {
      _show(generation, ScreenState.signedOut, const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED'));
      return;
    }
    setState(() {
      _value = null;
      _notFound = false;
      _state = ScreenState.loading;
    });
    try {
      final T? value = await widget.read(ref.read(apiClientProvider));
      if (value == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
      if (!mounted || generation != _generation) return;
      setState(() {
        _value = value;
        _problem = null;
        _state = (widget.isEmpty?.call(value) ?? false) ? ScreenState.empty : ScreenState.defaultState;
      });
    } on Object catch (error) {
      if (!mounted || generation != _generation) return;
      if (error is ApiError && error.status == 404) {
        setState(() {
          _notFound = true;
          _problem = ProblemView(state: ScreenState.error, code: error.code, correlationId: error.correlationId);
          _state = ScreenState.error;
        });
        return;
      }
      _show(generation, null, ProblemView.from(error, reachability: ref.read(reachabilityProvider)));
    }
  }

  void _show(int generation, ScreenState? state, ProblemView problem) {
    if (!mounted || generation != _generation) return;
    setState(() {
      _problem = problem;
      _notFound = false;
      _state = state ?? problem.state;
    });
  }

  void _sessionChanged(SessionSnapshot? previous, SessionSnapshot next) {
    if (previous?.tenantId == next.tenantId && previous?.userId == next.userId && previous?.membershipId == next.membershipId && previous?.status == next.status) return;
    _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<SessionSnapshot>(sessionProvider, _sessionChanged);
    if (_notFound) return NotFoundCard(code: _problem?.code ?? notFoundCode, onRetry: _load);
    final T? value = _value;
    return StateBoundary(
      state: _state,
      problem: _problem,
      onRetry: _load,
      keepContent: false,
      child: value == null || _state != ScreenState.defaultState ? const SizedBox.shrink() : widget.builder(context, value),
    );
  }
}

/// A record that is not there for this person: not in their scope, no longer shared with them, or gone. It names nothing about the
/// record and offers the way back (the server decides again on a retry).
class NotFoundCard extends StatelessWidget {
  const NotFoundCard({required this.code, this.onRetry, super.key});

  final String code;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final String title = context.t('mob.ai.notFound.title');
    final String body = context.t('mob.ai.notFound.body');
    return StateCard(
      icon: Icons.lock_outline,
      title: title,
      body: body,
      announcement: '$title. $body $code',
      details: <Widget>[SelectableText(code, textAlign: TextAlign.center)],
      actions: <Widget>[if (onRetry != null) OutlinedButton(onPressed: onRetry, child: Text(context.t('mob.states.retry.action')))],
    );
  }
}
