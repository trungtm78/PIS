import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/state/screen_state.dart';
import '../../command_support/command_flow.dart' show GateNote;
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../ai_models.dart';
import '../ai_read.dart';
import '../ai_support.dart';
import '../qa_service.dart';

/// MOB-37: asking about the proposals of one package. The answer is the passages of the files the person may read that are nearest to the
/// question, each with its file and page (a citation chip that opens the source, MOB-39); when retrieval finds nothing in the person's
/// scope there is no answer, only the refusal for want of a citation (AC-ST-MOB-030-1). Nothing the model produced is applied, approved or
/// sent from here. The thread lives in memory for as long as the screen: no question and no passage is written to the device, put in a
/// location or kept as a copy, and with no connection the question is not asked.
///
/// The package is `?package=<id>`; without it the screen lists the packages of the person's scope to choose from.
Widget buildQaScreen(BuildContext context, ScreenContext screen) {
  final String? package = screen.queryParameters['package'];
  return package == null || package.isEmpty ? const _PackagePicker() : _Thread(packageId: package);
}

class _PackagePicker extends StatelessWidget {
  const _PackagePicker();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.ai.qa.title'),
      body: FreshRead<PackageList>(
        read: (MachvonApiClient client) async => parsePackageList(await readMerged(client, 'get_resources_procurement_package', query: <String, Object?>{'limit': 50}, maxPages: 4)),
        isEmpty: (PackageList list) => list.packages.isEmpty,
        builder: (BuildContext context, PackageList list) => ListView(
          children: <Widget>[
            const AiNotice(),
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.ai.qa.scope.intro'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            for (final PackageChoice choice in list.packages)
              TappableRow(
                semanticLabel: context.t('mob.ai.qa.scope.aria', <String, Object>{'code': choice.code, 'title': choice.title}),
                onTap: () => openScreen(context, 'MOB-37', query: <String, String>{'package': choice.id}, stacked: true),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(choice.code, style: Theme.of(context).textTheme.bodyLarge),
                          Text(choice.title, style: Theme.of(context).textTheme.bodyMedium),
                        ],
                      ),
                    ),
                    const ExcludeSemantics(child: Icon(Icons.chevron_right)),
                  ],
                ),
              ),
            if (list.more)
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.ai.qa.scope.more'), style: Theme.of(context).textTheme.bodySmall),
              ),
          ],
        ),
      ),
    );
  }
}

/// One question of the thread and how it ended.
final class _Turn {
  _Turn(this.question);

  final String question;
  QaResult? result;

  bool get asking => result == null;
}

class _Thread extends ConsumerStatefulWidget {
  const _Thread({required this.packageId});

  final String packageId;

  @override
  ConsumerState<_Thread> createState() => _ThreadState();
}

class _ThreadState extends ConsumerState<_Thread> {
  final TextEditingController _question = TextEditingController();
  final List<_Turn> _turns = <_Turn>[];
  QuestionProblem? _problem;

  @override
  void dispose() {
    _question.dispose();
    super.dispose();
  }

  bool get _busy => _turns.any((_Turn turn) => turn.asking);

  Future<void> _ask(String question) async {
    if (_busy) return;
    final _Turn turn = _Turn(question.trim());
    setState(() {
      _turns.insert(0, turn);
      _problem = null;
    });
    final QaResult result = await CitedQa(client: ref.read(apiClientProvider), resolver: ref.read(embeddingModelResolverProvider)).ask(packageId: widget.packageId, question: turn.question);
    if (!mounted) return;
    setState(() => turn.result = result);
  }

  void _submit() {
    final QuestionProblem? problem = checkQuestion(_question.text);
    setState(() => _problem = problem);
    if (problem != null) return;
    final String question = _question.text;
    _question.clear();
    _ask(question);
  }

  @override
  Widget build(BuildContext context) {
    final bool offline = isOffline(ref);
    final ThemeData theme = Theme.of(context);
    return ScreenFrame(
      title: context.t('mob.ai.qa.title'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
        children: <Widget>[
          const AiNotice(),
          SectionCard(
            title: context.t('mob.ai.qa.ask.title'),
            children: <Widget>[
              TextField(
                controller: _question,
                maxLines: 3,
                minLines: 2,
                maxLength: maxQuestionLength,
                readOnly: _busy,
                textInputAction: TextInputAction.newline,
                decoration: InputDecoration(
                  labelText: context.t('mob.ai.qa.question.label'),
                  helperText: context.t('mob.ai.qa.question.helper'),
                  errorText: switch (_problem) { null => null, QuestionProblem.empty => context.t('mob.ai.qa.question.empty'), QuestionProblem.tooLong => context.t('mob.ai.qa.question.tooLong') },
                ),
              ),
              if (offline) GateNote(text: context.t('mob.ai.qa.gate.offline')),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(
                onPressed: offline || _busy ? null : _submit,
                child: Text(_busy ? context.t('mob.ai.qa.ask.pending') : context.t('mob.ai.qa.ask.action')),
              ),
            ],
          ),
          if (_turns.isEmpty)
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.ai.qa.thread.empty'), style: theme.textTheme.bodyMedium),
            ),
          for (final _Turn turn in _turns) _TurnCard(turn: turn, packageId: widget.packageId, offline: offline, onRetry: () => _retry(turn)),
        ],
      ),
    );
  }

  Future<void> _retry(_Turn turn) async {
    if (_busy) return;
    setState(() => turn.result = null);
    final QaResult result = await CitedQa(client: ref.read(apiClientProvider), resolver: ref.read(embeddingModelResolverProvider)).ask(packageId: widget.packageId, question: turn.question);
    if (!mounted) return;
    setState(() => turn.result = result);
  }
}

class _TurnCard extends StatelessWidget {
  const _TurnCard({required this.turn, required this.packageId, required this.offline, required this.onRetry});

  final _Turn turn;
  final String packageId;
  final bool offline;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final QaResult? result = turn.result;
    return SectionCard(
      title: context.t('mob.ai.qa.turn.title'),
      children: <Widget>[
        Text(turn.question, style: theme.textTheme.bodyLarge),
        const SizedBox(height: MachvonSpace.space8),
        if (result == null)
          Semantics(liveRegion: true, child: Text(context.t('mob.ai.qa.turn.searching'), style: theme.textTheme.bodyMedium))
        else
          switch (result) {
            QaPassages() => _Passages(passages: result.passages, packageId: packageId),
            QaRefused() => _Message(title: context.t('mob.ai.qa.refused.title'), body: context.t('mob.ai.qa.refused.body'), code: noCitationCode),
            QaNoModel() => _Message(title: context.t('mob.ai.qa.noModel.title'), body: context.t('mob.ai.qa.noModel.body'), code: noEmbeddingModelCode),
            QaFailed() => _Failure(error: result.error, offline: offline, onRetry: onRetry),
          },
      ],
    );
  }
}

class _Passages extends StatelessWidget {
  const _Passages({required this.passages, required this.packageId});

  final List<Passage> passages;
  final String packageId;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(header: true, child: Text(context.t('mob.ai.qa.answer.title', <String, Object>{'count': passages.length}), style: theme.textTheme.titleSmall)),
        Text(context.t('mob.ai.qa.answer.note'), style: theme.textTheme.bodySmall),
        const SizedBox(height: MachvonSpace.space8),
        for (final Passage passage in passages)
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
            child: DecoratedBox(
              decoration: BoxDecoration(border: Border.all(color: MachvonColors.border), borderRadius: const BorderRadius.all(Radius.circular(MachvonRadius.control))),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  TappableRow(
                    semanticLabel: context.t('mob.ai.qa.chip.aria', <String, Object>{'file': shortId(passage.documentVersionId), 'page': passage.pageIndex + 1}),
                    onTap: () => openScreen(context, 'MOB-39', query: <String, String>{'package': packageId, 'doc': passage.documentVersionId, 'page': '${passage.pageIndex}'}, stacked: true),
                    child: Row(
                      children: <Widget>[
                        const ExcludeSemantics(child: Icon(Icons.description_outlined)),
                        const SizedBox(width: MachvonSpace.space8),
                        Expanded(child: Text(context.t('mob.ai.qa.chip.label', <String, Object>{'file': shortId(passage.documentVersionId), 'page': passage.pageIndex + 1}), style: theme.textTheme.titleSmall)),
                        const ExcludeSemantics(child: Icon(Icons.chevron_right)),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, 0, MachvonSpace.space16, MachvonSpace.space12),
                    child: Text(passage.text, maxLines: 8, style: theme.textTheme.bodyMedium),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.title, required this.body, required this.code});

  final String title;
  final String body;
  final String code;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Semantics(
      liveRegion: true,
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: theme.textTheme.titleSmall),
          Text(body, style: theme.textTheme.bodyMedium),
          Text(code, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _Failure extends StatelessWidget {
  const _Failure({required this.error, required this.offline, required this.onRetry});

  final Object error;
  final bool offline;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ProblemView problem = ProblemView.from(error, reachability: offline ? Reachability.offline : Reachability.unknown);
    final bool notFound = error is ApiError && (error as ApiError).status == 404;
    final String body = notFound
        ? context.t('mob.ai.qa.failed.notFound')
        : switch (problem.state) {
            ScreenState.denied => context.t('mob.ai.qa.failed.denied'),
            ScreenState.expired => context.t('mob.ai.qa.failed.expired'),
            ScreenState.signedOut => context.t('mob.ai.qa.failed.signedOut'),
            ScreenState.offline => context.t('mob.ai.qa.failed.offline'),
            _ => context.t('mob.ai.qa.failed.general'),
          };
    final bool retryable = !notFound && problem.state != ScreenState.denied && problem.state != ScreenState.signedOut && problem.state != ScreenState.expired;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _Message(title: context.t('mob.ai.qa.failed.title'), body: body, code: problem.code),
        if (problem.correlationId != null && problem.correlationId!.isNotEmpty) Text(problem.correlationId!, style: Theme.of(context).textTheme.bodySmall),
        if (retryable) ...<Widget>[
          const SizedBox(height: MachvonSpace.space8),
          OutlinedButton(onPressed: offline ? null : onRetry, child: Text(context.t('mob.ai.qa.failed.retry'))),
        ],
      ],
    );
  }
}
