import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show ApiError;

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../offline_format.dart';
import '../offline_labels.dart';
import '../offline_problem.dart';

/// MOB-41: the queue of commands waiting on the device, each with its size, its state and the reason when it is not done
/// (ST-MOB-005). A command whose answer was lost says "Chưa xác định kết quả" and is looked up, never sent as a new one.
Widget buildQueueScreen(BuildContext context, ScreenContext screen) => const QueueScreen();

class QueueScreen extends ConsumerStatefulWidget {
  const QueueScreen({super.key});

  @override
  ConsumerState<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends ConsumerState<QueueScreen> {
  bool _working = false;
  int _total = 0;
  FlushResult? _last;
  Object? _failure;

  Future<void> _run(Future<FlushResult> Function(CommandQueue queue) action, {required int total}) async {
    if (_working) return;
    final CommandQueue queue = await ref.read(commandQueueProvider.future);
    setState(() {
      _working = true;
      _total = total;
      _failure = null;
    });
    try {
      final FlushResult result = await action(queue);
      if (mounted) setState(() => _last = result);
    } on ApiError catch (error) {
      if (mounted) setState(() => _failure = error);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _discard(QueuedCommand command) async {
    final CommandQueue queue = await ref.read(commandQueueProvider.future);
    if (!mounted) return;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialog) => AlertDialog(
        title: Text(dialog.t('mob.queue.discard.title')),
        content: Text(dialog.t('mob.queue.discard.body')),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: Text(dialog.t('mob.queue.discard.cancel.action'))),
          TextButton(onPressed: () => Navigator.of(dialog).pop(true), child: Text(dialog.t('mob.queue.discard.confirm.action'))),
        ],
      ),
    );
    if (confirmed ?? false) queue.discard(command.id);
  }

  void _resolve(QueuedCommand command) {
    final String base = ref.read(routeTableProvider).locationOf('MOB-42');
    context.push('$base/${command.id}');
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<List<QueuedCommand>> commands = ref.watch(queuedCommandsProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final List<QueuedCommand> shown = <QueuedCommand>[
      for (final QueuedCommand c in commands.value ?? const <QueuedCommand>[])
        if (c.state != CommandState.discarded) c,
    ];
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    if (commands.hasError) {
      problem = offlineProblemOf(commands.error!, reachability);
      state = problem.state;
    } else if (!commands.hasValue) {
      state = ScreenState.loading;
    } else if (shown.isEmpty) {
      state = ScreenState.empty;
    }
    final List<QueuedCommand> pending = <QueuedCommand>[for (final QueuedCommand c in shown) if (c.state.isPending) c];
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.queue.title.label'))),
      body: SafeArea(
        child: StateBoundary(
          state: state,
          problem: problem,
          onRetry: () => ref.invalidate(commandQueueProvider),
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              _Summary(commands: shown, pending: pending, working: _working, total: _total, onSend: () => _run((CommandQueue q) => q.flush(), total: pending.length)),
              ..._notices(context, reachability),
              const SizedBox(height: 8),
              for (final QueuedCommand command in shown)
                _CommandTile(
                  key: ValueKey<String>(command.id),
                  command: command,
                  busy: _working,
                  onCheck: () => _run((CommandQueue q) => q.retry(command.id), total: 1),
                  onRetry: () => _run((CommandQueue q) => q.retry(command.id), total: 1),
                  onDiscard: () => _discard(command),
                  onResolve: () => _resolve(command),
                ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _notices(BuildContext context, Reachability reachability) {
    final String? blocked = blockerNotice(context, _last?.blocker);
    final String? text = _failure is ApiError ? context.t('mob.queue.notice.serverError.body') : (blocked ?? (reachability == Reachability.offline ? context.t('mob.queue.notice.offline.body') : null));
    if (text == null) return const <Widget>[];
    return <Widget>[
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Semantics(liveRegion: true, container: true, child: Text(text, style: TextStyle(color: Theme.of(context).colorScheme.error))),
      ),
    ];
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.commands, required this.pending, required this.working, required this.total, required this.onSend});

  final List<QueuedCommand> commands;
  final List<QueuedCommand> pending;
  final bool working;
  final int total;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final int bytes = pending.fold(0, (int sum, QueuedCommand c) => sum + c.payloadBytes);
    final int unknown = commands.where((QueuedCommand c) => c.state == CommandState.unknown).length;
    final int done = (total - pending.length).clamp(0, total);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Semantics(
              container: true,
              child: Text(context.t('mob.queue.summary.pending.label', <String, Object>{'count': pending.length}), style: Theme.of(context).textTheme.titleMedium),
            ),
            const SizedBox(height: 4),
            Text(context.t('mob.queue.summary.size.label', <String, Object>{'size': formatBytes(bytes)})),
            if (unknown > 0) Text(context.t('mob.queue.summary.unknown.label', <String, Object>{'count': unknown})),
            if (working && total > 0) ...<Widget>[
              const SizedBox(height: 8),
              LinearProgressIndicator(value: done / total, semanticsLabel: context.t('mob.queue.sending.label')),
              Text(context.t('mob.queue.summary.progress.label', <String, Object>{'done': done, 'total': total})),
            ],
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: working || pending.isEmpty ? null : onSend,
              child: Text(working ? context.t('mob.queue.sending.label') : context.t('mob.queue.send.action')),
            ),
          ],
        ),
      ),
    );
  }
}

class _CommandTile extends StatelessWidget {
  const _CommandTile({
    required this.command,
    required this.busy,
    required this.onCheck,
    required this.onRetry,
    required this.onDiscard,
    required this.onResolve,
    super.key,
  });

  final QueuedCommand command;
  final bool busy;
  final VoidCallback onCheck;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;
  final VoidCallback onResolve;

  @override
  Widget build(BuildContext context) {
    final String type = commandTypeLabel(context, command.commandType);
    final String state = stateLabel(context, command.state);
    final String? reason = reasonOf(context, command);
    final String size = context.t('mob.queue.item.size.label', <String, Object>{'size': formatBytes(command.payloadBytes)});
    final String? code = command.errorCode == null ? null : context.t('mob.queue.item.code.label', <String, Object>{'code': command.errorCode!});
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Semantics(
              container: true,
              label: <String>[type, state, size, ?reason, ?code].join('. '),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(type, style: Theme.of(context).textTheme.titleMedium),
                  Text(state, style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text(size),
                  if (reason != null) Text(reason),
                  if (code != null) Text(code),
                ],
              ),
            ),
            Wrap(
              spacing: 8,
              children: <Widget>[
                if (command.state == CommandState.unknown) _Action(label: context.t('mob.queue.item.check.action'), onPressed: busy ? null : onCheck),
                if (command.state == CommandState.rejected) _Action(label: context.t('mob.queue.item.retry.action'), onPressed: busy ? null : onRetry),
                if (command.state == CommandState.conflict) _Action(label: context.t('mob.queue.item.resolve.action'), onPressed: onResolve),
                if (command.state == CommandState.queued || command.state == CommandState.rejected || command.state == CommandState.conflict)
                  _Action(label: context.t('mob.queue.item.discard.action'), onPressed: busy ? null : onDiscard),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => TextButton(
        style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
        onPressed: onPressed,
        child: Text(label),
      );
}
