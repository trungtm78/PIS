import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/connectivity/reachability.dart';
import 'command_outcome.dart';

/// Whether the device can reach the server now; asked before every send.
bool deviceIsOnline(WidgetRef ref) => ref.read(reachabilityProvider) != Reachability.offline;

/// What a screen that sends one command at a time shares: the outcome of the last send and a guard against a second tap while
/// one is on its way. [onDone] runs after a command was recorded (the screen reads its record again).
mixin CommandFlow<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  CommandOutcome? outcome;
  bool sending = false;

  /// Runs [send] once. A second call while one is on its way does nothing.
  Future<void> run(Future<CommandOutcome> Function() send, {VoidCallback? onDone}) async {
    if (sending) return;
    setState(() {
      sending = true;
      outcome = null;
    });
    final CommandOutcome result = await send();
    if (!mounted) return;
    setState(() {
      sending = false;
      outcome = result;
    });
    if (result is CommandDone) onDone?.call();
  }
}

/// A message about a command, outside the form (a refusal never makes the form disappear, so what the person wrote is still
/// there to send again). The card is a live region: a screen reader announces it when it appears.
class OutcomeCard extends StatelessWidget {
  const OutcomeCard({required this.title, this.lines = const <String>[], this.code, this.actionLabel, this.onAction, super.key});

  final String title;
  final List<String> lines;

  /// The stable error code, shown small under the sentence.
  final String? code;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Semantics(
          liveRegion: true,
          container: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(title, style: theme.textTheme.titleMedium),
              for (final String line in lines) Text(line),
              if (code != null) Text(code!, style: theme.textTheme.bodySmall),
              if (actionLabel != null && onAction != null) ...<Widget>[
                const SizedBox(height: MachvonSpace.space12),
                OutlinedButton(onPressed: onAction, child: Text(actionLabel!)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Says why an action is off, next to the disabled button, as a live region (a disabled button alone says nothing).
class GateNote extends StatelessWidget {
  const GateNote({required this.text, super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Padding(padding: const EdgeInsets.only(bottom: MachvonSpace.space8), child: Text(text)),
    );
  }
}
