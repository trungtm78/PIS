import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/answer.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/router.dart' show homeLocation;
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../session/flow.dart';
import '../app_info.dart';

/// The topics of a support ticket, as the server lists them.
const List<String> kHelpTopics = <String>['ACCESS', 'DATA', 'BILLING', 'INCIDENT', 'HOWTO', 'OTHER'];

final NotifierProvider<FlowNotifier, FlowState> helpFlowProvider = NotifierProvider.autoDispose<FlowNotifier, FlowState>(FlowNotifier.new);

/// MOB-50: help and feedback. The person picks a topic, writes a subject and a description, and the application sends a support
/// ticket with the version of the application and of the operating system added. It never adds the content of a record, a name
/// or an identifier of the person: the ticket is what the person typed and one line about the software.
Widget buildHelpScreen(BuildContext context, ScreenContext screen) =>
    HelpScreen(initialTopic: kHelpTopics.contains(screen.queryParameters['category']) ? screen.queryParameters['category']! : 'HOWTO');

class HelpScreen extends ConsumerStatefulWidget {
  const HelpScreen({required this.initialTopic, super.key});

  final String initialTopic;

  @override
  ConsumerState<HelpScreen> createState() => _HelpScreenState();
}

class _HelpScreenState extends ConsumerState<HelpScreen> {
  final TextEditingController _subject = TextEditingController();
  final TextEditingController _description = TextEditingController();
  late String _topic = widget.initialTopic;
  bool _showErrors = false;
  String? _sentReference;

  /// The code of a refusal of the request itself (a conflict, a rule): shown above the form, which stays editable.
  String? _refusal;
  ({String key, CommandAttempt attempt})? _attempt;

  @override
  void dispose() {
    _subject.dispose();
    _description.dispose();
    super.dispose();
  }

  bool get _subjectValid => _subject.text.trim().length >= 5 && _subject.text.trim().length <= 200;
  bool get _descriptionValid => _description.text.trim().length >= 10 && _description.text.trim().length <= 10000;

  /// The ticket body: what the person typed, then one line about the software. Nothing else is added.
  SupportTicketCreate _ticket(AppInfo? app) => SupportTicketCreate(
        category: _topic,
        subject: _subject.text.trim(),
        description: <String>[_description.text.trim(), if (app != null) app.summary].join('\n\n'),
      );

  Future<void> _send() async {
    if (!_subjectValid || !_descriptionValid) {
      setState(() => _showErrors = true);
      return;
    }
    final AppInfo? app = ref.read(appInfoProvider).asData?.value;
    final SupportTicketCreate ticket = _ticket(app);
    // The same content is the same intention: a retry after a lost answer repeats the command with its key. New content is a new one.
    final String content = '${ticket.category}\u0000${ticket.subject}\u0000${ticket.description}';
    if (_attempt?.key != content) _attempt = (key: content, attempt: CommandAttempt.fresh());
    final CommandAttempt attempt = _attempt!.attempt;
    setState(() => _refusal = null);
    final String? reference = await ref.read(helpFlowProvider.notifier).run<String?>(() async {
      try {
        final Object? json = await ref.read(apiClientProvider).createSupportTicket(ticket, attempt: attempt);
        final CommandResultResponse result = decodeAnswer('createSupportTicket', json)! as CommandResultResponse;
        return result.resourceId ?? result.operationId;
      } on ApiError catch (error) {
        if (!_refusesTheRequest(error)) rethrow;
        if (mounted) setState(() => _refusal = error.code);
        return null;
      }
    });
    if (reference == null || !mounted) return;
    setState(() {
      _sentReference = reference;
      _attempt = null;
      _subject.clear();
      _description.clear();
      _showErrors = false;
    });
  }

  /// The server looked at the request and said no (a conflict, a rule): the person edits it and sends it again. A lapsed session,
  /// a missing permission, an expired licence and a failure to answer are the standard states instead.
  static bool _refusesTheRequest(ApiError error) =>
      const <int>{400, 404, 409, 413, 415, 422}.contains(error.status) && error.code != 'LICENSE_EXPIRED';

  String _topicLabel(BuildContext context, String topic) {
    switch (topic) {
      case 'ACCESS':
        return context.t('mob.help.topic.access');
      case 'DATA':
        return context.t('mob.help.topic.data');
      case 'BILLING':
        return context.t('mob.help.topic.billing');
      case 'INCIDENT':
        return context.t('mob.help.topic.incident');
      case 'HOWTO':
        return context.t('mob.help.topic.howto');
      default:
        return context.t('mob.help.topic.other');
    }
  }

  @override
  Widget build(BuildContext context) {
    final FlowState flow = ref.watch(helpFlowProvider);
    final AppInfo? app = ref.watch(appInfoProvider).asData?.value;
    final bool pending = flow.state == ScreenState.loading;
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.help.title.text'))),
      body: SafeArea(
        child: StateBoundary(
          state: flow.state,
          problem: flow.problem,
          onRetry: pending ? null : _send,
          child: _sentReference != null
              ? _Sent(reference: _sentReference!, onAnother: () => setState(() => _sentReference = null))
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text(context.t('mob.help.body.text')),
                      if (_refusal != null) ...<Widget>[
                        const SizedBox(height: MachvonSpace.space12),
                        Semantics(liveRegion: true, child: Text(context.t('mob.help.refused.text', <String, Object>{'code': _refusal!}), style: TextStyle(color: theme.colorScheme.error))),
                      ],
                      const SizedBox(height: MachvonSpace.space16),
                      Semantics(header: true, child: Text(context.t('mob.help.topic.label'), style: theme.textTheme.labelLarge)),
                      const SizedBox(height: MachvonSpace.space8),
                      Wrap(
                        spacing: MachvonSpace.space8,
                        runSpacing: MachvonSpace.space8,
                        children: <Widget>[
                          for (final String topic in kHelpTopics)
                            ChoiceChip(
                              label: Text(_topicLabel(context, topic)),
                              selected: _topic == topic,
                              onSelected: pending ? null : (bool _) => setState(() => _topic = topic),
                            ),
                        ],
                      ),
                      const SizedBox(height: MachvonSpace.space12),
                      TextField(
                        controller: _subject,
                        readOnly: pending,
                        maxLength: 200,
                        textInputAction: TextInputAction.next,
                        onChanged: (String _) => setState(() {}),
                        decoration: InputDecoration(
                          labelText: context.t('mob.help.subject.label'),
                          errorText: _showErrors && !_subjectValid ? context.t('mob.help.subject.invalid') : null,
                        ),
                      ),
                      const SizedBox(height: MachvonSpace.space12),
                      TextField(
                        controller: _description,
                        readOnly: pending,
                        maxLength: 10000,
                        minLines: 4,
                        maxLines: 8,
                        keyboardType: TextInputType.multiline,
                        onChanged: (String _) => setState(() {}),
                        decoration: InputDecoration(
                          labelText: context.t('mob.help.description.label'),
                          helperText: context.t('mob.help.description.hint'),
                          helperMaxLines: 2,
                          errorText: _showErrors && !_descriptionValid ? context.t('mob.help.description.invalid') : null,
                        ),
                      ),
                      if (app != null) ...<Widget>[
                        const SizedBox(height: MachvonSpace.space8),
                        Text(context.t('mob.help.attached.label', <String, Object>{'info': app.summary}), style: theme.textTheme.bodySmall),
                      ],
                      const SizedBox(height: MachvonSpace.space16),
                      FilledButton(onPressed: pending ? null : _send, child: Text(context.t('mob.help.submit.action'))),
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

class _Sent extends StatelessWidget {
  const _Sent({required this.reference, required this.onAnother});

  final String reference;
  final VoidCallback onAnother;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(MachvonSpace.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(header: true, liveRegion: true, child: Text(context.t('mob.help.sent.title'), style: theme.textTheme.headlineSmall)),
          const SizedBox(height: MachvonSpace.space8),
          Text(context.t('mob.help.sent.body')),
          const SizedBox(height: MachvonSpace.space8),
          SelectableText(context.t('mob.help.sent.reference', <String, Object>{'id': reference})),
          const SizedBox(height: MachvonSpace.space16),
          FilledButton(onPressed: () => context.canPop() ? context.pop() : context.go(homeLocation), child: Text(context.t('mob.help.sent.back.action'))),
          const SizedBox(height: MachvonSpace.space8),
          OutlinedButton(onPressed: onAnother, child: Text(context.t('mob.help.sent.again.action'))),
        ],
      ),
    );
  }
}
