import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
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
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../command_support/field_widgets.dart';
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
    final bool ready = loaded != null && _choices.length >= loaded.conflict.differences.length;
    return AppScaffold(
      title: context.t('mob.conflict.title.label'),
      bottomBar: loaded == null
          ? null
          : ActionBar(
              primary: ActionBarButton(label: context.t('mob.conflict.save.action'), onPressed: !ready || _saving ? null : () => _save(loaded)),
              why: ready ? null : context.t('mob.conflict.remaining.label', <String, Object>{'count': loaded.conflict.differences.where((FieldDifference d) => !_choices.containsKey(d.path)).length}),
            ),
      body: StateBoundary(
        state: state,
        problem: problem,
        onRetry: _load,
        keepContent: false,
        child: loaded == null ? const SizedBox.shrink() : _content(context, loaded),
      ),
    );
  }

  Widget _content(BuildContext context, LoadedConflict loaded) {
    final List<FieldDifference> differences = loaded.conflict.differences;
    final String language = Localizations.localeOf(context).languageCode;
    final MachvonV2Text text = context.v2text;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Text(context.t('mob.conflict.intro.body'), style: text.body),
        ),
        if (differences.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.conflict.same.body'), style: text.body)),
        if (differences.any((FieldDifference d) => !d.isMoney))
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
            child: Wrap(
              spacing: MachvonV2Space.s8,
              children: <Widget>[
                _BulkButton(label: context.t('mob.conflict.allMine.action'), onPressed: () => _chooseAll(differences, FieldChoice.mine)),
                _BulkButton(label: context.t('mob.conflict.allServer.action'), onPressed: () => _chooseAll(differences, FieldChoice.server)),
              ],
            ),
          ),
        for (int i = 0; i < differences.length; i += 1)
          _DifferenceCard(
            key: ValueKey<String>(differences[i].path),
            difference: differences[i],
            first: i == 0,
            language: language,
            choice: _choices[differences[i].path],
            onChoice: (FieldChoice choice) => setState(() => _choices[differences[i].path] = choice),
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
  Widget build(BuildContext context) => OutlinedButton(onPressed: onPressed, child: Text(label, textAlign: TextAlign.center));
}

class _DifferenceCard extends StatelessWidget {
  const _DifferenceCard({required this.difference, required this.first, required this.language, required this.choice, required this.onChoice, super.key});

  final FieldDifference difference;
  final bool first;
  final String language;
  final FieldChoice? choice;
  final ValueChanged<FieldChoice> onChoice;

  String _show(BuildContext context, Object? value) {
    if (value == null) return context.t('mob.conflict.absent.label');
    if (difference.isMoney && Decimal.tryParse(value) != null) return formatNumber(value, language);
    return value is String ? value : jsonEncode(value);
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String label = fieldLabel(context, difference.path);
    final String mine = _show(context, difference.mine);
    final String server = _show(context, difference.server);
    final Decimal? delta = difference.moneyDelta;
    final String? deltaText = delta == null ? null : context.t('mob.conflict.delta.label', <String, Object>{'delta': formatNumber(delta.toPlainString(), language, signed: true)});
    return FormSection(
      title: label,
      first: first,
      caption: difference.isMoney ? context.t('mob.conflict.money.label') : null,
      children: <Widget>[
        Semantics(
          container: true,
          label: '${context.t('mob.conflict.mine.label')}: $mine. ${context.t('mob.conflict.server.label')}: $server.${deltaText == null ? '' : ' $deltaText'}',
          excludeSemantics: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text('${context.t('mob.conflict.mine.label')}: $mine', style: text.body),
              Text('${context.t('mob.conflict.server.label')}: $server', style: text.body),
              if (deltaText != null) Text(deltaText, style: text.bodyStrong),
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
    );
  }
}
