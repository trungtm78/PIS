import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/timeline.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart' show CommandFlow, deviceIsOnline;
import '../../command_support/command_outcome.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../incoming_commands.dart';
import '../incoming_models.dart';
import '../incoming_support.dart';

/// DOC-23: the incoming letters the person has to deal with, on the phone (ST-DOC-020, DOC 4, UAT-AC420). Without a parameter it lists
/// them, the late ones first and grouped under their own heading, each with its number, its sender, the day it was received, its deadline
/// and its urgency, and chips that narrow the list to the late, the newly assigned and the ones being worked on; with `?doc=<id>` it opens
/// one letter, where it can be started and resolved.
///
/// Personal data and the files of letters are not kept on the device: the reads of this screen are never kept as a copy (a lost
/// connection is the offline state, not an old list), and the letter's file is not read here. Starting and resolving are one request
/// each, sent at once under an idempotency key of their own and never queued (a command without a key would be refused by the server).
/// What the person may do is what the server says for this letter (`actions`); the server judges each command again. The phone never
/// counts the days to a deadline itself: it shows the day the server gives and, for a late letter, the days the server counts.
Widget buildIncomingScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['doc'];
  return id == null || id.isEmpty ? const _ListScreen() : _LetterScreen(letterId: id);
}

/// What the chips of the list narrow it to.
enum _Show { all, late, assigned, processing }

List<IncomingLetter> _narrowed(List<IncomingLetter> letters, _Show show) {
  switch (show) {
    case _Show.all:
      return letters;
    case _Show.late:
      return <IncomingLetter>[for (final IncomingLetter letter in letters) if (letter.isOverdue) letter];
    case _Show.assigned:
      return <IncomingLetter>[for (final IncomingLetter letter in letters) if (letter.status == 'ASSIGNED') letter];
    case _Show.processing:
      return <IncomingLetter>[for (final IncomingLetter letter in letters) if (letter.status == 'PROCESSING') letter];
  }
}

class _ListScreen extends ConsumerStatefulWidget {
  const _ListScreen();

  @override
  ConsumerState<_ListScreen> createState() => _ListScreenState();
}

class _ListScreenState extends ConsumerState<_ListScreen> {
  _Show _show = _Show.all;

  @override
  Widget build(BuildContext context) {
    final String? membership = ref.watch(sessionProvider).membershipId;
    return AppScaffold(
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
          final List<IncomingLetter> shown = _narrowed(letters, _show);
          final List<IncomingLetter> late = <IncomingLetter>[for (final IncomingLetter letter in shown) if (letter.isOverdue) letter];
          final List<IncomingLetter> open = <IncomingLetter>[for (final IncomingLetter letter in shown) if (!letter.isOverdue) letter];
          return ListView(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.docin.list.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
              ),
              FilterChips<_Show>(
                options: <ChipOption<_Show>>[
                  ChipOption<_Show>(value: _Show.all, label: context.t('mob.docin.filter.all'), count: letters.length),
                  ChipOption<_Show>(value: _Show.late, label: context.t('mob.docin.filter.late'), count: _narrowed(letters, _Show.late).length),
                  ChipOption<_Show>(value: _Show.assigned, label: context.t('mob.docin.filter.assigned'), count: _narrowed(letters, _Show.assigned).length),
                  ChipOption<_Show>(value: _Show.processing, label: context.t('mob.docin.filter.processing'), count: _narrowed(letters, _Show.processing).length),
                ],
                selected: _show,
                onChanged: (_Show next) => setState(() => _show = next),
              ),
              if (shown.isEmpty)
                SizedBox(
                  height: 360,
                  child: StateView(
                    kind: StateKind.empty,
                    title: context.t('mob.docin.list.filtered.title'),
                    body: context.t('mob.docin.list.filtered.body'),
                    actionLabel: context.t('mob.docin.list.filtered.action'),
                    onAction: () => setState(() => _show = _Show.all),
                  ),
                ),
              if (late.isNotEmpty) GroupHeader(title: context.t('mob.docin.list.group.late'), count: late.length),
              for (int index = 0; index < late.length; index += 1) _LetterRow(letter: late[index], dividerAbove: index > 0),
              if (open.isNotEmpty && late.isNotEmpty) GroupHeader(title: context.t('mob.docin.list.group.open'), count: open.length),
              for (int index = 0; index < open.length; index += 1) _LetterRow(letter: open[index], dividerAbove: index > 0),
              if (loaded.value.more) StatusBanner(text: context.t('mob.docin.list.more'), tone: BannerTone.warning),
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

/// The glyph of a row: the late band when the server counts the letter late, otherwise a plain letter (the phone does not judge the band of a
/// deadline the server did not count).
class _LetterGlyph extends StatelessWidget {
  const _LetterGlyph({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    if (letter.isOverdue) return const DeadlineGlyph(band: DeadlineBand.late);
    final MachvonV2Palette p = context.v2.palette;
    return ExcludeSemantics(
      child: SizedBox(
        width: MachvonV2Size.glyph,
        height: MachvonV2Size.glyph,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
          child: ColoredBox(color: p.sunken, child: Icon(Icons.mail_outline, size: 22, color: p.ink2)),
        ),
      ),
    );
  }
}

class _LetterRow extends StatelessWidget {
  const _LetterRow({required this.letter, required this.dividerAbove});

  final IncomingLetter letter;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String status = statusLabel(context, letter.status);
    final String due = letter.isOverdue ? _overdueText(context, letter) : _dueText(context, letter);
    final String received = context.t('mob.docin.list.received', <String, Object>{'date': formatDayShort(letter.receivedAt)});
    final List<String> facts = <String>[_numberText(context, letter), if (letter.senderName.isNotEmpty) letter.senderName, received];
    final Widget trailing = Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (letter.isOverdue)
          DeadlineLabel(band: DeadlineBand.late, text: context.t('mob.docin.overdue.days', <String, Object>{'days': letter.overdueDays ?? 0}), dueDay: letter.dueOn)
        else
          Text(letter.dueOn == null ? context.t('mob.docin.due.none') : formatDayShort(letter.dueOn!), style: context.v2text.label, textAlign: TextAlign.end),
        if (letter.urgency != 'NORMAL') Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: StatusPill(label: urgencyLabel(context, letter.urgency), warn: true)),
      ],
    );
    return WorkRow(
      title: letter.title,
      subtitle: facts.join(' · '),
      leading: _LetterGlyph(letter: letter),
      trailing: trailing,
      semanticLabel: context.t('mob.docin.list.row.aria', <String, Object>{'title': letter.title, 'status': status, 'due': due}),
      dividerAbove: dividerAbove,
      onTap: () => openScreen(context, 'DOC-23', query: <String, String>{'doc': letter.id}, stacked: true),
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
    return AppScaffold(
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

/// A message about a command, outside the form (a refusal never makes the form disappear): a band of the theme's colours, a live region.
class _Notice extends StatelessWidget {
  const _Notice({required this.title, required this.fill, required this.mark, this.lines = const <String>[], this.code, this.actionLabel, this.onAction});

  final String title;
  final Color fill;
  final Color mark;
  final List<String> lines;
  final String? code;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Semantics(
      liveRegion: true,
      container: true,
      child: ColoredBox(
        color: fill,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(title, style: text.bodyStrong.copyWith(color: mark)),
              for (final String line in lines) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(line, style: text.body.copyWith(color: mark))),
              if (code != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(code!, style: text.caption.copyWith(color: mark))),
              if (actionLabel != null && onAction != null)
                Padding(
                  padding: const EdgeInsets.only(top: MachvonV2Space.s12),
                  child: Align(alignment: Alignment.centerLeft, child: OutlinedButton(onPressed: onAction, style: v2QuietButtonStyle(context.v2), child: Text(actionLabel!))),
                ),
            ],
          ),
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
    final MachvonV2Palette p = context.v2.palette;
    switch (result) {
      case CommandDone():
        return _Notice(fill: p.okBg, mark: p.okFg, title: context.t('mob.docin.result.done.title'), lines: <String>[context.t('mob.docin.result.done.body')]);
      case CommandUnknown():
        return _Notice(
          fill: p.soonBg,
          mark: p.soonFg,
          title: context.t('mob.docin.result.unknown.title'),
          lines: <String>[context.t('mob.docin.result.unknown.body')],
          actionLabel: context.t('mob.docin.result.unknown.action'),
          onAction: _last == null ? null : () => _send(_last!, again: true),
        );
      case CommandOffline():
        return _Notice(fill: p.infoBg, mark: p.infoFg, title: gateText(context, IncomingGate.offline));
      case CommandRefused():
        final IncomingProblem problem = problemOf(result);
        final bool retry = isRetryable(problem) && _last != null;
        return _Notice(
          fill: p.lateBg,
          mark: p.lateFg,
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
    final bool actionable = letter.isHandling && (letter.canStart || letter.canResolve);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (result != null) _outcome(context, result),
                if (letter.isOverdue) StatusBanner(tone: BannerTone.late, text: _overdueText(context, letter)),
                if (letter.isOverdue && gate == IncomingGate.open && letter.canResolve)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
                    child: Semantics(liveRegion: true, child: Text(context.t('mob.docin.act.late', <String, Object>{'days': letter.overdueDays ?? 0}), style: context.v2text.body)),
                  ),
                if (gate != IncomingGate.open && !actionable) StatusBanner(text: gateText(context, gate)),
                _LetterHead(letter: letter),
                _FileBlock(letter: letter),
                if (letter.assignments.isNotEmpty) _HistoryBlock(letter: letter),
                if (letter.resolutionSummary != null) _ResolutionBlock(letter: letter),
                if (actionable && letter.canResolve && _resolving) _summaryForm(context),
              ],
            ),
          ),
        ),
        if (actionable) _bar(context, letter, gate),
      ],
    );
  }

  Widget _summaryForm(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s16, right: MachvonV2Space.s16),
      child: TextField(
        controller: _summary,
        readOnly: sending,
        minLines: 3,
        maxLines: 6,
        textCapitalization: TextCapitalization.sentences,
        decoration: InputDecoration(labelText: context.t('mob.docin.act.summary.label'), errorText: _problem == null ? null : summaryProblemText(context, _problem!)),
      ),
    );
  }

  /// The one bar of the screen: the primary action locked with its reason beside it when the gate is closed. While the summary is typed the
  /// bar sends it, and the second button leaves the form.
  Widget _bar(BuildContext context, IncomingLetter letter, IncomingGate gate) {
    final bool ready = gate == IncomingGate.open && !sending;
    final String sendingLabel = context.t('mob.docin.act.sending');
    final String? why = gate == IncomingGate.open ? null : gateText(context, gate);
    if (letter.canResolve && _resolving) {
      return ActionBar(
        primary: ActionBarButton(label: sending ? sendingLabel : context.t('mob.docin.act.submit'), onPressed: ready ? _resolve : null),
        secondary: ActionBarButton(
          label: context.t('mob.docin.act.cancel'),
          onPressed: sending
              ? null
              : () => setState(() {
                    _resolving = false;
                    _problem = null;
                  }),
        ),
        why: why,
      );
    }
    void openForm() => setState(() => _resolving = true);
    if (letter.canStart) {
      return ActionBar(
        primary: ActionBarButton(label: sending ? sendingLabel : context.t('mob.docin.act.start'), onPressed: ready ? _start : null),
        secondary: letter.canResolve ? ActionBarButton(label: context.t('mob.docin.act.resolve'), onPressed: ready ? openForm : null) : null,
        why: why,
      );
    }
    return ActionBar(primary: ActionBarButton(label: context.t('mob.docin.act.resolve'), onPressed: ready ? openForm : null), why: why);
  }
}

class _LetterHead extends StatelessWidget {
  const _LetterHead({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Semantics(container: true, header: true, child: Text(letter.title, style: text.heading)),
        ),
        InfoRow(label: context.t('mob.docin.letter.status'), value: statusLabel(context, letter.status), divider: false),
        InfoRow(label: context.t('mob.docin.letter.urgency'), value: urgencyLabel(context, letter.urgency)),
        InfoRow(label: context.t('mob.docin.letter.number'), value: letter.numberLabel),
        InfoRow(label: context.t('mob.docin.letter.directive'), value: letter.leaderDirective),
        InfoRow(label: context.t('mob.docin.letter.due'), value: letter.dueOn == null ? null : formatDay(letter.dueOn!)),
        InfoRow(label: context.t('mob.docin.letter.received'), value: letter.receivedAt.isEmpty ? null : formatDay(letter.receivedAt)),
        InfoRow(label: context.t('mob.docin.letter.sender'), value: letter.senderName),
        InfoRow(label: context.t('mob.docin.letter.type'), value: letter.docTypeCode),
        InfoRow(label: context.t('mob.docin.letter.symbol'), value: letter.originalSymbol),
        InfoRow(label: context.t('mob.docin.letter.unit'), value: letter.assignedUnitName),
        InfoRow(label: context.t('mob.docin.letter.assignee'), value: letter.assigneeName),
      ],
    );
  }
}

class _FileBlock extends StatelessWidget {
  const _FileBlock({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String? hash = letter.fileSha256;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.docin.file.title')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: hash == null
              ? Text(context.t('mob.docin.file.none'), style: text.body)
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Text(context.t('mob.docin.file.hash', <String, Object>{'hash': hash.substring(0, hash.length < 12 ? hash.length : 12)}), style: text.body),
                    Text(context.t('mob.docin.file.web'), style: text.caption.copyWith(color: context.v2.palette.ink2)),
                  ],
                ),
        ),
      ],
    );
  }
}

class _HistoryBlock extends StatelessWidget {
  const _HistoryBlock({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.docin.history.title'), count: letter.assignments.length),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: TimelineList(
            entries: <TimelineEntry>[
              for (final IncomingAssignment entry in letter.assignments)
                TimelineEntry(
                  title: context.t('mob.docin.history.entry', <String, Object>{'unit': entry.unitName, 'who': entry.assignee ?? context.t('mob.docin.history.unit')}),
                  when: formatMoment(entry.assignedAt),
                  detail: <String>[
                    if (entry.directive != null) context.t('mob.docin.history.directive', <String, Object>{'text': entry.directive!}),
                    if (entry.dueOn != null) context.t('mob.docin.history.due', <String, Object>{'date': formatDay(entry.dueOn!)}),
                  ].join(' · '),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ResolutionBlock extends StatelessWidget {
  const _ResolutionBlock({required this.letter});

  final IncomingLetter letter;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final int? late = letter.lateDays;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.docin.resolved.title')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                context.t('mob.docin.resolved.text', <String, Object>{'time': letter.resolvedAt == null ? '' : formatMoment(letter.resolvedAt!), 'summary': letter.resolutionSummary!}),
                style: text.body,
              ),
              if (late != null && late > 0) Text(context.t('mob.docin.resolved.late', <String, Object>{'days': late}), style: text.bodyStrong.copyWith(color: context.v2.palette.lateFg)),
            ],
          ),
        ),
      ],
    );
  }
}
