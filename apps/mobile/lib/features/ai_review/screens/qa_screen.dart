import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/tap_target.dart';
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
/// The package is `?package=<id>` and the thread is keyed by it: a route that keeps its page while the package changes would otherwise carry
/// the answers, the pending questions and the retries of one package over to the other. Without it the screen lists the packages of the person's scope to choose from.
Widget buildQaScreen(BuildContext context, ScreenContext screen) {
  final String? package = screen.queryParameters['package'];
  return package == null || package.isEmpty ? const _PackagePicker() : _Thread(key: ValueKey<String>(package), packageId: package);
}

class _PackagePicker extends StatelessWidget {
  const _PackagePicker();

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.ai.qa.title'),
      body: FreshRead<PackageList>(
        resource: 'packages',
        read: (MachvonApiClient client) async => parsePackageList(await readMerged(client, 'get_resources_procurement_package', query: <String, Object?>{'limit': 50}, maxPages: 4)),
        isEmpty: (PackageList list) => list.packages.isEmpty,
        builder: (BuildContext context, PackageList list) => ListView(
          children: <Widget>[
            const AiNotice(),
            Padding(
              padding: const EdgeInsets.all(MachvonV2Space.s16),
              child: Text(context.t('mob.ai.qa.scope.intro'), style: context.v2text.body),
            ),
            for (int index = 0; index < list.packages.length; index += 1)
              AiRow(
                title: list.packages[index].code,
                subtitle: list.packages[index].title,
                dividerAbove: index > 0,
                semanticLabel: context.t('mob.ai.qa.scope.aria', <String, Object>{'code': list.packages[index].code, 'title': list.packages[index].title}),
                onTap: () => openScreen(context, 'MOB-37', query: <String, String>{'package': list.packages[index].id}, stacked: true),
              ),
            if (list.more)
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.ai.qa.scope.more'), style: context.v2text.caption),
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
  const _Thread({required this.packageId, super.key});

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

  /// The passages are the confidential text of one tenant's files, read for one person in one membership: when any of these changes the
  /// thread goes, with the question typed and not yet sent. A turn still waiting is dropped with it, so its answer, when it comes, fills a
  /// card nobody shows and the new session is not held back by a question it never asked.
  void _sessionChanged(SessionSnapshot? previous, SessionSnapshot next) {
    if (previous == null || (previous.tenantId == next.tenantId && previous.userId == next.userId && previous.membershipId == next.membershipId && previous.status == next.status)) return;
    _question.clear();
    setState(() {
      _turns.clear();
      _problem = null;
    });
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
    ref.listen<SessionSnapshot>(sessionProvider, _sessionChanged);
    final bool offline = isOffline(ref);
    final MachvonV2Text text = context.v2text;
    return AppScaffold(
      title: context.t('mob.ai.qa.title'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
        children: <Widget>[
          const AiNotice(),
          // A question is asked on the server and never from a copy: with no connection the button is off and the reason is said, as a live region.
          if (offline) StatusBanner(text: context.t('mob.ai.qa.gate.offline'), icon: Icons.cloud_off_outlined),
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
              const SizedBox(height: MachvonV2Space.s8),
              FilledButton(
                onPressed: offline || _busy ? null : _submit,
                child: Text(_busy ? context.t('mob.ai.qa.ask.pending') : context.t('mob.ai.qa.ask.action')),
              ),
            ],
          ),
          if (_turns.isEmpty)
            Padding(
              padding: const EdgeInsets.all(MachvonV2Space.s16),
              child: Text(context.t('mob.ai.qa.thread.empty'), style: text.body),
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
    final MachvonV2Text text = context.v2text;
    final QaResult? result = turn.result;
    return SectionCard(
      title: context.t('mob.ai.qa.turn.title'),
      children: <Widget>[
        Text(turn.question, style: text.bodyStrong),
        const SizedBox(height: MachvonV2Space.s8),
        if (result == null)
          Semantics(liveRegion: true, child: Text(context.t('mob.ai.qa.turn.searching'), style: text.body))
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
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(container: true, header: true, child: Text(context.t('mob.ai.qa.answer.title', <String, Object>{'count': passages.length}), style: text.heading)),
        Text(context.t('mob.ai.qa.answer.note'), style: text.caption),
        const SizedBox(height: MachvonV2Space.s8),
        for (final Passage passage in passages) ...<Widget>[
          SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)),
          TapTarget(
            semanticLabel: context.t('mob.ai.qa.chip.aria', <String, Object>{'file': shortId(passage.documentVersionId), 'page': passage.pageIndex + 1}),
            onTap: () => openScreen(context, 'MOB-39', query: <String, String>{'package': packageId, 'doc': passage.documentVersionId, 'page': '${passage.pageIndex}'}, stacked: true),
            radius: 0,
            minHeight: 48,
            child: SizedBox(
              width: double.infinity,
              child: Row(
                children: <Widget>[
                  ExcludeSemantics(child: Icon(Icons.description_outlined, color: v2.palette.primaryStrong)),
                  const SizedBox(width: MachvonV2Space.s8),
                  Expanded(child: Text(context.t('mob.ai.qa.chip.label', <String, Object>{'file': shortId(passage.documentVersionId), 'page': passage.pageIndex + 1}), style: text.label.copyWith(color: v2.palette.primaryStrong))),
                  ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink2)),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s12),
            child: Text(passage.text, maxLines: 8, overflow: TextOverflow.ellipsis, style: text.body),
          ),
        ],
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
    final MachvonV2Text text = context.v2text;
    return Semantics(
      liveRegion: true,
      container: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ExcludeSemantics(child: SizedBox(height: 22, child: Center(child: Icon(Icons.info_outline, size: 20, color: context.semantic.onSoft(MachvonTone.info))))),
          const SizedBox(width: MachvonV2Space.s8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: text.bodyStrong),
                Text(body, style: text.body),
                Text(code, style: text.caption),
              ],
            ),
          ),
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
        if (problem.correlationId != null && problem.correlationId!.isNotEmpty) Text(problem.correlationId!, style: context.v2text.caption),
        if (retryable) ...<Widget>[
          const SizedBox(height: MachvonV2Space.s8),
          OutlinedButton(onPressed: offline ? null : onRetry, child: Text(context.t('mob.ai.qa.failed.retry'))),
        ],
      ],
    );
  }
}
