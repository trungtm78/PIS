import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../api/problem.dart';
import '../l10n/app_strings.dart';
import 'screen_state.dart';
import 'state_card.dart';

/// The error state (MOB-53) and its kin, drawn from a [ProblemView]: a service error, a time-out, no access, an expired
/// licence, an ended session, no connection.
///
/// It always shows the stable error code and, when the failure reached the server, the correlation id the user gives to
/// support (selectable and copyable); it offers retry when [onRetry] is given; and it is one live region, so a screen
/// reader announces it when it appears. It replaces nothing the user typed: put it beside the form, or let
/// `StateBoundary` keep the form mounted behind it.
class ProblemStateView extends StatelessWidget {
  const ProblemStateView({required this.problem, this.onRetry, super.key});

  final ProblemView problem;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final String? reference = problem.correlationId;
    return StateCard(
      icon: _iconOf(problem.state),
      title: _titleOf(context),
      body: _bodyOf(context),
      announcement: <String>[
        _titleOf(context),
        _bodyOf(context),
        '${context.t('mob.problem.code.label')}: ${problem.code}',
        if (reference != null) '${context.t('mob.problem.reference.label')}: $reference',
      ].join('. '),
      details: <Widget>[
        _Fact(label: context.t('mob.problem.code.label'), value: problem.code),
        if (reference != null) _Fact(label: context.t('mob.problem.reference.label'), value: reference),
        Text(
          context.t('mob.problem.support.hint'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
      actions: <Widget>[
        if (onRetry != null) FilledButton(onPressed: onRetry, child: Text(context.t('mob.states.retry.action'))),
        if (reference != null) _CopyReferenceButton(reference: reference),
      ],
    );
  }

  // Each key is written out so the string check can see it is in use.
  String _titleOf(BuildContext context) {
    if (problem.timedOut) return context.t('mob.states.timeout.title');
    switch (problem.state) {
      case ScreenState.denied:
        return context.t('mob.states.denied.title');
      case ScreenState.expired:
        return context.t('mob.states.expired.title');
      case ScreenState.signedOut:
        return context.t('mob.states.signedOut.title');
      case ScreenState.offline:
        return context.t('mob.states.offline.title');
      case ScreenState.defaultState:
      case ScreenState.loading:
      case ScreenState.empty:
      case ScreenState.error:
        return context.t('mob.states.error.title');
    }
  }

  String _bodyOf(BuildContext context) {
    if (problem.timedOut) return context.t('mob.states.timeout.body');
    switch (problem.state) {
      case ScreenState.denied:
        return context.t('mob.states.denied.body');
      case ScreenState.expired:
        return context.t('mob.states.expired.body');
      case ScreenState.signedOut:
        return context.t('mob.states.signedOut.body');
      case ScreenState.offline:
        return context.t('mob.states.offline.body');
      case ScreenState.defaultState:
      case ScreenState.loading:
      case ScreenState.empty:
      case ScreenState.error:
        return context.t('mob.states.error.body');
    }
  }

  IconData _iconOf(ScreenState state) {
    switch (state) {
      case ScreenState.denied:
        return Icons.lock_outline;
      case ScreenState.expired:
      case ScreenState.signedOut:
        return Icons.schedule;
      case ScreenState.offline:
        return Icons.cloud_off_outlined;
      case ScreenState.defaultState:
      case ScreenState.loading:
      case ScreenState.empty:
      case ScreenState.error:
        return Icons.error_outline;
    }
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;
    return Column(
      children: <Widget>[
        Text(label, style: text.bodySmall),
        SelectableText(value, textAlign: TextAlign.center, style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
      ],
    );
  }
}

class _CopyReferenceButton extends StatelessWidget {
  const _CopyReferenceButton({required this.reference});

  final String reference;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      icon: const Icon(Icons.copy, size: MachvonSpace.space20),
      label: Text(context.t('mob.problem.copy.action')),
      onPressed: () async {
        final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
        final String done = context.t('mob.problem.copy.done');
        await Clipboard.setData(ClipboardData(text: reference));
        messenger.showSnackBar(SnackBar(content: Text(done)));
      },
    );
  }
}
