import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../incoming_commands.dart';
import '../incoming_models.dart';
import '../incoming_support.dart';

/// DOC-23: the incoming letters the person has to deal with, on the phone (ST-DOC-020, DOC 4, UAT-AC420). Without a parameter it lists
/// them, the late ones first, each with its number, its subject, the leader's directive, its deadline and its status; with
/// `?doc=<id>` it opens one letter, where it can be started and resolved.
///
/// Personal data and the files of letters are not kept on the device: the reads of this screen are never kept as a copy (a lost
/// connection is the offline state, not an old list), and the letter's file is not read here. Starting and resolving are one request
/// each, sent at once under an idempotency key of their own and never queued (a command without a key would be refused by the server).
/// What the person may do is what the server says for this letter (`actions`); the server judges each command again.
Widget buildIncomingScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['doc'];
  return id == null || id.isEmpty ? const _ListScreen() : _LetterScreen(letterId: id);
}

class _ListScreen extends ConsumerWidget {
  const _ListScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String? membership = ref.watch(sessionProvider).membershipId;
    return ScreenFrame(
      title: context.t('mob.docin.list.title'),
      body: DataView<IncomingList>(
        cacheKey: 'doc.incoming.mine',
        keepCopy: false,
        reloadKey: ref.watch(lettersChangedProvider),
        read: readLettersToHandle,
        parse: parseIncomingList,
        asOf: (IncomingList list) => list.asOf,
        isEmpty: (IncomingList list) => lettersToHandle(list.letters, membership).isEmpty,
        builder: (BuildContext context, Loaded<IncomingList> loaded) {
          final List<IncomingLetter> letters = lettersToHandle(loaded.value.letters, membership);
          return ListView(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.docin.list.intro'), style: Theme.of(context).textTheme.bodyMedium),
              ),
              for (final IncomingLetter letter in letters) _LetterRow(letter: letter),
              if (loaded.value.more)
                Padding(
                  padding: const EdgeInsets.all(MachvonSpace.space16),
                  child: Text(context.t('mob.docin.list.more'), style: Theme.of(context).textTheme.bodySmall),
                ),
            ],
          );
        },
      ),
    );
  }
}

String _dueText(BuildContext context, IncomingLetter letter) =>
    letter.dueOn == null ? context.t('mob.docin.due.none') : context.t('mob.docin.due.text', <String, Object>{'date': formatDay(letter.dueOn!)});

String _overdueText(BuildContext context, IncomingLetter letter) =>
    context.t('mob.docin.overdue.label', <String, Object>{'days': letter.overdueDays ?? 0, 'date': letter.dueOn == null ? '' : formatDay(letter.dueOn!)});

String _numberText(BuildContext context, IncomingLetter letter) =>
    letter.numberLabel == null ? context.t('mob.docin.number.none') : context.t('mob.docin.number', <String, Object>{'number': letter.numberLabel!});

String _directiveText(BuildContext context, IncomingLetter letter) =>
    letter.leaderDirective == null ? context.t('mob.docin.directive.none') : context.t('mob.docin.directive.text', <String, Object>{'text': letter.leaderDirective!});

class _LetterRow extends StatelessWidget {
  const _LetterRow({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String status = statusLabel(context, letter.status);
    final String due = letter.isOverdue ? _overdueText(context, letter) : _dueText(context, letter);
    return TappableRow(
      semanticLabel: context.t('mob.docin.list.row.aria', <String, Object>{'title': letter.title, 'status': status, 'due': due}),
      onTap: () => openScreen(context, 'DOC-23', query: <String, String>{'doc': letter.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(letter.title, style: theme.textTheme.bodyLarge),
                Text('${_numberText(context, letter)} · ${letter.senderName}', style: theme.textTheme.bodyMedium),
                Text(_directiveText(context, letter), style: theme.textTheme.bodyMedium),
                Text(_dueText(context, letter), style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    StatusPill(label: status),
                    if (letter.urgency != 'NORMAL') StatusPill(label: urgencyLabel(context, letter.urgency), warn: true),
                    if (letter.isOverdue) StatusPill(label: _overdueText(context, letter), warn: true),
                  ],
                ),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

class _LetterScreen extends ConsumerStatefulWidget {
  const _LetterScreen({required this.letterId});

  final String letterId;

  @override
  ConsumerState<_LetterScreen> createState() => _LetterScreenState();
}

class _LetterScreenState extends ConsumerState<_LetterScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.docin.detail.title'),
      body: DataView<IncomingLetter>(
        cacheKey: 'doc.incoming.${widget.letterId}',
        keepCopy: false,
        reloadKey: _changed,
        read: (MachvonApiClient client) => client.getIncomingDocument(id: widget.letterId),
        parse: parseLetter,
        builder: (BuildContext context, Loaded<IncomingLetter> loaded) => _LetterBody(
          letter: loaded.value,
          onChanged: () {
            ref.read(lettersChangedProvider.notifier).bump();
            setState(() => _changed += 1);
          },
        ),
      ),
    );
  }
}

class _LetterBody extends ConsumerStatefulWidget {
  const _LetterBody({required this.letter, required this.onChanged});

  final IncomingLetter letter;
  final VoidCallback onChanged;

  @override
  ConsumerState<_LetterBody> createState() => _LetterBodyState();
}

class _LetterBodyState extends ConsumerState<_LetterBody> with CommandFlow<_LetterBody> {
  late final IncomingCommands _commands = IncomingCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _summary = TextEditingController();
  bool _resolving = false;
  SummaryProblem? _problem;
  Future<CommandOutcome> Function({bool again})? _last;

  @override
  void dispose() {
    _summary.dispose();
    super.dispose();
  }

  Future<void> _send(Future<CommandOutcome> Function({bool again}) send, {bool again = false}) async {
    _last = send;
    await run(() => send(again: again), onDone: () {
      _summary.clear();
      setState(() => _resolving = false);
      widget.onChanged();
    });
    // A refusal leaves the letter as it was on the server: read it again so that the screen shows that and not what the phone assumed.
    if (mounted && outcome is CommandRefused) widget.onChanged();
  }

  void _start() {
    final IncomingLetter letter = widget.letter;
    _send(({bool again = false}) => _commands.start(letter.id, letter.version, retryAfterUnknown: again));
  }

  void _resolve() {
    final IncomingLetter letter = widget.letter;
    final SummaryProblem? problem = checkSummary(_summary.text);
    setState(() => _problem = problem);
    if (problem != null) return;
    final String words = _summary.text;
    _send(({bool again = false}) => _commands.resolve(letter.id, letter.version, words, retryAfterUnknown: again));
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.docin.result.done.title'), lines: <String>[context.t('mob.docin.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.docin.result.unknown.title'),
          lines: <String>[context.t('mob.docin.result.unknown.body')],
          actionLabel: context.t('mob.docin.result.unknown.action'),
          onAction: _last == null ? null : () => _send(_last!, again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, IncomingGate.offline));
      case CommandRefused():
        final IncomingProblem problem = problemOf(result);
        final bool retry = isRetryable(problem) && _last != null;
        return OutcomeCard(
          title: problemText(context, problem),
          code: result.code,
          actionLabel: retry ? context.t('mob.docin.result.retry.action') : null,
          onAction: retry ? () => _send(_last!, again: true) : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final IncomingLetter letter = widget.letter;
    final IncomingGate gate = gateOf(letter: letter, offline: isOffline(ref), session: ref.watch(sessionProvider));
    final CommandOutcome? result = outcome;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) _outcome(context, result),
        _LetterCard(letter: letter),
        _FileCard(letter: letter),
        if (letter.assignments.isNotEmpty) _HistoryCard(letter: letter),
        if (letter.resolutionSummary != null) _ResolutionCard(letter: letter),
        _actionCard(context, letter, gate),
      ],
    );
  }

  Widget _actionCard(BuildContext context, IncomingLetter letter, IncomingGate gate) {
    final bool ready = gate == IncomingGate.open && !sending;
    return SectionCard(
      title: context.t('mob.docin.act.title'),
      children: <Widget>[
        if (gate != IncomingGate.open) GateNote(text: gateText(context, gate)),
        if (letter.isOverdue && gate == IncomingGate.open && letter.canResolve) GateNote(text: context.t('mob.docin.act.late', <String, Object>{'days': letter.overdueDays ?? 0})),
        if (letter.canStart && letter.isHandling)
          FilledButton(onPressed: ready ? _start : null, child: Text(sending && !_resolving ? context.t('mob.docin.act.sending') : context.t('mob.docin.act.start'))),
        if (letter.canResolve && letter.isHandling && !_resolving) ...<Widget>[
          const SizedBox(height: MachvonSpace.space8),
          OutlinedButton(onPressed: ready ? () => setState(() => _resolving = true) : null, child: Text(context.t('mob.docin.act.resolve'))),
        ],
        if (letter.canResolve && letter.isHandling && _resolving) ...<Widget>[
          const SizedBox(height: MachvonSpace.space8),
          TextField(
            controller: _summary,
            readOnly: sending,
            minLines: 3,
            maxLines: 6,
            textCapitalization: TextCapitalization.sentences,
            decoration: InputDecoration(labelText: context.t('mob.docin.act.summary.label'), errorText: _problem == null ? null : summaryProblemText(context, _problem!)),
          ),
          const SizedBox(height: MachvonSpace.space8),
          FilledButton(onPressed: ready ? _resolve : null, child: Text(sending ? context.t('mob.docin.act.sending') : context.t('mob.docin.act.submit'))),
          const SizedBox(height: MachvonSpace.space8),
          TextButton(
            onPressed: sending ? null : () => setState(() {
              _resolving = false;
              _problem = null;
            }),
            child: Text(context.t('mob.docin.act.cancel')),
          ),
        ],
      ],
    );
  }
}

class _LetterCard extends StatelessWidget {
  const _LetterCard({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.docin.letter.title'),
      children: <Widget>[
        Text(letter.title, style: theme.textTheme.bodyLarge),
        Text(_numberText(context, letter), style: theme.textTheme.bodyMedium),
        Text(_directiveText(context, letter), style: theme.textTheme.bodyMedium),
        Text(_dueText(context, letter), style: theme.textTheme.bodyMedium),
        if (letter.isOverdue) Text(_overdueText(context, letter), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
        FactLine(label: context.t('mob.docin.letter.status'), value: statusLabel(context, letter.status)),
        FactLine(label: context.t('mob.docin.letter.urgency'), value: urgencyLabel(context, letter.urgency)),
        if (letter.senderName.isNotEmpty) FactLine(label: context.t('mob.docin.letter.sender'), value: letter.senderName),
        if (letter.docTypeCode.isNotEmpty) FactLine(label: context.t('mob.docin.letter.type'), value: letter.docTypeCode),
        if (letter.originalSymbol != null) FactLine(label: context.t('mob.docin.letter.symbol'), value: letter.originalSymbol!),
        if (letter.assignedUnitName != null) FactLine(label: context.t('mob.docin.letter.unit'), value: letter.assignedUnitName!),
        if (letter.assigneeName != null) FactLine(label: context.t('mob.docin.letter.assignee'), value: letter.assigneeName!),
      ],
    );
  }
}

class _FileCard extends StatelessWidget {
  const _FileCard({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? hash = letter.fileSha256;
    return SectionCard(
      title: context.t('mob.docin.file.title'),
      children: <Widget>[
        if (hash == null)
          Text(context.t('mob.docin.file.none'), style: theme.textTheme.bodyMedium)
        else ...<Widget>[
          Text(context.t('mob.docin.file.hash', <String, Object>{'hash': hash.substring(0, hash.length < 12 ? hash.length : 12)}), style: theme.textTheme.bodyMedium),
          Text(context.t('mob.docin.file.web'), style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.docin.history.title'),
      children: <Widget>[
        for (final IncomingAssignment entry in letter.assignments)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    context.t('mob.docin.history.row', <String, Object>{
                      'unit': entry.unitName,
                      'who': entry.assignee ?? context.t('mob.docin.history.unit'),
                      'time': formatMoment(entry.assignedAt),
                    }),
                    style: theme.textTheme.bodyMedium,
                  ),
                  if (entry.directive != null) Text(context.t('mob.docin.history.directive', <String, Object>{'text': entry.directive!}), style: theme.textTheme.bodySmall),
                  if (entry.dueOn != null) Text(context.t('mob.docin.history.due', <String, Object>{'date': formatDay(entry.dueOn!)}), style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _ResolutionCard extends StatelessWidget {
  const _ResolutionCard({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final int? late = letter.lateDays;
    return SectionCard(
      title: context.t('mob.docin.resolved.title'),
      children: <Widget>[
        Text(
          context.t('mob.docin.resolved.text', <String, Object>{'time': letter.resolvedAt == null ? '' : formatMoment(letter.resolvedAt!), 'summary': letter.resolutionSummary!}),
          style: theme.textTheme.bodyMedium,
        ),
        if (late != null && late > 0) Text(context.t('mob.docin.resolved.late', <String, Object>{'days': late}), style: theme.textTheme.bodyMedium),
      ],
    );
  }
}
