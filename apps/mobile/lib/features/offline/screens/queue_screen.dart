import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show ApiError;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/command_queue.dart';
import '../../../core/offline/queue/offline_codes.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/progress.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/state_view.dart';
import '../../command_support/field_widgets.dart';
import '../offline_labels.dart';
import '../offline_problem.dart';

/// MOB-41: the queue of commands waiting on the device, each with its size, its state and the reason when it is not done
/// (ST-MOB-005). A command whose answer was lost says that the result is not yet known and is looked up, never sent as a new one.
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
    final bool confirmed = await showConfirmSheet(
      context,
      title: context.t('mob.queue.discard.title'),
      facts: <String>[context.t('mob.queue.discard.body')],
      confirmLabel: context.t('mob.queue.discard.confirm.action'),
      cancelLabel: context.t('mob.queue.discard.cancel.action'),
      destructive: true,
    );
    if (confirmed) queue.discard(command.id);
  }

  void _resolve(QueuedCommand command) {
    // A command that is settled on the screen of its record (the work on a task) goes there; the person sees the record as it is now. Anything else is compared field by field.
    final ScreenTarget? target = ref.read(conflictScreensProvider)[command.commandType]?.call(command);
    if (target != null) {
      context.push('${ref.read(routeTableProvider).locationOf(target.screenId)}${target.pathSuffix}');
      return;
    }
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
    return AppScaffold(
      title: context.t('mob.queue.title.label'),
      bottomBar: state == ScreenState.defaultState
          ? FieldSendBar(
              label: context.t('mob.queue.send.action'),
              onSend: pending.isEmpty ? null : () => _run((CommandQueue q) => q.flush(), total: pending.length),
              sending: _working,
              why: pending.isNotEmpty && reachability == Reachability.offline ? context.t('mob.queue.notice.offline.body') : null,
            )
          : null,
      body: StateBoundary(
        state: state,
        problem: problem,
        onRetry: () => ref.invalidate(commandQueueProvider),
        child: ListView(
          padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
          children: <Widget>[
            _Summary(commands: shown, pending: pending, working: _working, total: _total),
            ..._notices(context, reachability),
            for (int i = 0; i < shown.length; i += 1)
              _CommandTile(
                key: ValueKey<String>(shown[i].id),
                command: shown[i],
                first: i == 0,
                busy: _working,
                onCheck: () => _run((CommandQueue q) => q.retry(shown[i].id), total: 1),
                onRetry: () => _run((CommandQueue q) => q.retry(shown[i].id), total: 1),
                onDiscard: () => _discard(shown[i]),
                onResolve: () => _resolve(shown[i]),
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _notices(BuildContext context, Reachability reachability) {
    final String? blocked = blockerNotice(context, _last?.blocker);
    final bool serverError = _failure is ApiError;
    final String? text = serverError ? context.t('mob.queue.notice.serverError.body') : (blocked ?? (reachability == Reachability.offline ? context.t('mob.queue.notice.offline.body') : null));
    if (text == null) return const <Widget>[];
    return <Widget>[StatusBanner(text: text, tone: serverError ? BannerTone.late : (blocked != null ? BannerTone.warning : BannerTone.info))];
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.commands, required this.pending, required this.working, required this.total});

  final List<QueuedCommand> commands;
  final List<QueuedCommand> pending;
  final bool working;
  final int total;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final int bytes = pending.fold(0, (int sum, QueuedCommand c) => sum + c.payloadBytes);
    final int unknown = commands.where((QueuedCommand c) => c.state == CommandState.unknown).length;
    final int done = (total - pending.length).clamp(0, total);
    return Padding(
      padding: const EdgeInsets.all(MachvonV2Space.s16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(container: true, header: true, child: Text(context.t('mob.queue.summary.pending.label', <String, Object>{'count': pending.length}), style: text.title)),
          const SizedBox(height: MachvonV2Space.s4),
          Text(context.t('mob.queue.summary.size.label', <String, Object>{'size': formatBytes(bytes, language: AppStrings.of(context).language)}), style: text.caption.copyWith(color: v2.palette.ink2)),
          if (unknown > 0) Text(context.t('mob.queue.summary.unknown.label', <String, Object>{'count': unknown}), style: text.caption.copyWith(color: v2.palette.soonFg)),
          if (working && total > 0) ...<Widget>[
            const SizedBox(height: MachvonV2Space.s12),
            ProgressMeter(value: done / total, label: context.t('mob.queue.sending.label')),
            const SizedBox(height: MachvonV2Space.s4),
            Text(context.t('mob.queue.summary.progress.label', <String, Object>{'done': done, 'total': total}), style: text.caption),
          ],
        ],
      ),
    );
  }
}

class _CommandTile extends StatelessWidget {
  const _CommandTile({
    required this.command,
    required this.first,
    required this.busy,
    required this.onCheck,
    required this.onRetry,
    required this.onDiscard,
    required this.onResolve,
    super.key,
  });

  final QueuedCommand command;
  final bool first;
  final bool busy;
  final VoidCallback onCheck;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;
  final VoidCallback onResolve;

  MachvonTone get _tone {
    switch (command.state) {
      case CommandState.accepted:
        return MachvonTone.success;
      case CommandState.rejected:
        return MachvonTone.danger;
      case CommandState.unknown:
      case CommandState.conflict:
        return MachvonTone.warning;
      case CommandState.sending:
        return MachvonTone.info;
      case CommandState.queued:
      case CommandState.discarded:
        return MachvonTone.neutral;
    }
  }

  @override
  Widget build(BuildContext context) {
    return UploadRow(
      title: commandTypeLabel(context, command.commandType),
      stateLabel: stateLabel(context, command.state),
      tone: _tone,
      size: context.t('mob.queue.item.size.label', <String, Object>{'size': formatBytes(command.payloadBytes, language: AppStrings.of(context).language)}),
      reason: reasonOf(context, command),
      code: command.errorCode == null ? null : context.t('mob.queue.item.code.label', <String, Object>{'code': command.errorCode!}),
      dividerAbove: !first,
      actions: <RowAction>[
        if (command.state == CommandState.unknown) RowAction(label: context.t('mob.queue.item.check.action'), onPressed: busy ? null : onCheck),
        // A command refused as unverifiable may have been carried out: a new key would carry it out twice, so only the discard is offered.
        if (command.state == CommandState.rejected && command.errorCode != kResultUnverifiable) RowAction(label: context.t('mob.queue.item.retry.action'), onPressed: busy ? null : onRetry),
        if (command.state == CommandState.conflict) RowAction(label: context.t('mob.queue.item.resolve.action'), onPressed: onResolve),
        if (command.state == CommandState.queued || command.state == CommandState.rejected || command.state == CommandState.conflict)
          RowAction(label: context.t('mob.queue.item.discard.action'), onPressed: busy ? null : onDiscard),
      ],
    );
  }
}
