import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/drafts/conflict_adapter.dart';
import '../../../core/offline/drafts/decimal.dart';
import '../../../core/offline/drafts/draft_conflict.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/queue/queue_runner.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../offline_format.dart';
import '../offline_labels.dart';
import '../offline_problem.dart';

/// MOB-42: the version on the device beside the version on the server, field by field, with the difference of every amount
/// (ST-MOB-006, MOB.md 3). The person chooses what to keep for each field; the screen never picks for them, and an amount is
/// decided on its own. Saving puts the command back in the queue on the version of the server, to be sent once.
Widget buildConflictScreen(BuildContext context, ScreenContext screen) => ConflictScreen(commandId: screen.pathParameters['commandId'] ?? '');

class ConflictScreen extends ConsumerStatefulWidget {
  const ConflictScreen({required this.commandId, super.key});

  final String commandId;

  @override
  ConsumerState<ConflictScreen> createState() => _ConflictScreenState();
}

class _ConflictScreenState extends ConsumerState<ConflictScreen> {
  LoadedConflict? _loaded;
  Object? _failure;
  bool _missing = false;
  bool _saving = false;
  final Map<String, FieldChoice> _choices = <String, FieldChoice>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loaded = null;
      _failure = null;
      _missing = false;
    });
    try {
      final CommandQueue queue = await ref.read(commandQueueProvider.future);
      final QueuedCommand? command = queue.command(widget.commandId);
      if (command == null || command.state != CommandState.conflict) {
        if (mounted) setState(() => _missing = true);
        return;
      }
      final LoadedConflict loaded = await ref.read(conflictAdaptersProvider).conflictOf(ref.read(apiClientProvider), command);
      if (mounted) setState(() => _loaded = loaded);
    } on Object catch (error) {
      if (mounted) setState(() => _failure = error);
    }
  }

  Future<void> _save(LoadedConflict loaded) async {
    setState(() => _saving = true);
    try {
      final CommandQueue queue = await ref.read(commandQueueProvider.future);
      queue.resolveConflict(widget.commandId, payload: loaded.conflict.resolve(_choices), baseServerVersion: loaded.serverVersion);
      final QueueRunner runner = await ref.read(queueRunnerProvider.future);
      runner.trigger();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(context.t('mob.conflict.saved.done'))));
      if (context.canPop()) {
        context.pop();
      } else {
        context.go(ref.read(routeTableProvider).locationOf('MOB-41'));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Reachability reachability = ref.watch(reachabilityProvider);
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    if (_failure != null) {
      problem = offlineProblemOf(_failure!, reachability);
      state = problem.state;
    } else if (_missing) {
      state = ScreenState.empty;
    } else if (_loaded == null) {
      state = ScreenState.loading;
    }
    final LoadedConflict? loaded = _loaded;
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.conflict.title.label'))),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: problem,
          onRetry: _load,
          keepContent: false,
          child: loaded == null ? const SizedBox.shrink() : _content(context, loaded),
        ),
      ),
    );
  }

  Widget _content(BuildContext context, LoadedConflict loaded) {
    final List<FieldDifference> differences = loaded.conflict.differences;
    final int remaining = differences.where((FieldDifference d) => !_choices.containsKey(d.path)).length;
    final String language = Localizations.localeOf(context).languageCode;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: <Widget>[
        Text(context.t('mob.conflict.intro.body')),
        const SizedBox(height: 12),
        if (differences.isEmpty) Text(context.t('mob.conflict.same.body')),
        if (differences.any((FieldDifference d) => !d.isMoney)) ...<Widget>[
          _BulkButton(label: context.t('mob.conflict.allMine.action'), onPressed: () => _chooseAll(differences, FieldChoice.mine)),
          _BulkButton(label: context.t('mob.conflict.allServer.action'), onPressed: () => _chooseAll(differences, FieldChoice.server)),
        ],
        for (final FieldDifference difference in differences)
          _DifferenceCard(
            key: ValueKey<String>(difference.path),
            difference: difference,
            language: language,
            choice: _choices[difference.path],
            onChoice: (FieldChoice choice) => setState(() => _choices[difference.path] = choice),
          ),
        const SizedBox(height: 8),
        if (remaining > 0) Semantics(liveRegion: true, child: Text(context.t('mob.conflict.remaining.label', <String, Object>{'count': remaining}))),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: remaining > 0 || _saving ? null : () => _save(loaded),
          child: Text(context.t('mob.conflict.save.action')),
        ),
      ],
    );
  }

  /// The convenience of choosing for the fields that are not money. An amount is never chosen by a button for many.
  void _chooseAll(List<FieldDifference> differences, FieldChoice choice) => setState(() {
        for (final FieldDifference difference in differences) {
          if (!difference.isMoney) _choices[difference.path] = choice;
        }
      });
}

class _BulkButton extends StatelessWidget {
  const _BulkButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Align(
        alignment: AlignmentDirectional.centerStart,
        child: TextButton(onPressed: onPressed, child: Text(label)),
      );
}

class _DifferenceCard extends StatelessWidget {
  const _DifferenceCard({required this.difference, required this.language, required this.choice, required this.onChoice, super.key});

  final FieldDifference difference;
  final String language;
  final FieldChoice? choice;
  final ValueChanged<FieldChoice> onChoice;

  String _show(BuildContext context, Object? value) {
    if (value == null) return context.t('mob.conflict.absent.label');
    if (difference.isMoney && Decimal.tryParse(value) != null) return formatMoney(value, language);
    return value is String ? value : jsonEncode(value);
  }

  @override
  Widget build(BuildContext context) {
    final String label = fieldLabel(context, difference.path);
    final String mine = _show(context, difference.mine);
    final String server = _show(context, difference.server);
    final Decimal? delta = difference.moneyDelta;
    final String? deltaText = delta == null ? null : context.t('mob.conflict.delta.label', <String, Object>{'delta': formatMoney(delta.toPlainString(), language, signed: true)});
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(label, style: Theme.of(context).textTheme.titleMedium),
            if (difference.isMoney) Text(context.t('mob.conflict.money.label')),
            const SizedBox(height: 8),
            Semantics(
              container: true,
              label: '${context.t('mob.conflict.mine.label')}: $mine. ${context.t('mob.conflict.server.label')}: $server.${deltaText == null ? '' : ' $deltaText'}',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('${context.t('mob.conflict.mine.label')}: $mine'),
                  Text('${context.t('mob.conflict.server.label')}: $server'),
                  if (deltaText != null) Text(deltaText, style: const TextStyle(fontWeight: FontWeight.w600)),
                ],
              ),
            ),
            RadioGroup<FieldChoice>(
              groupValue: choice,
              onChanged: (FieldChoice? value) {
                if (value != null) onChoice(value);
              },
              child: Column(
                children: <Widget>[
                  RadioListTile<FieldChoice>(key: ValueKey<String>('${difference.path}:mine'), value: FieldChoice.mine, title: Text(context.t('mob.conflict.choose.mine.action'))),
                  RadioListTile<FieldChoice>(key: ValueKey<String>('${difference.path}:server'), value: FieldChoice.server, title: Text(context.t('mob.conflict.choose.server.action'))),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
