import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/drafts/draft_store.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/context_line.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../command_support/field_widgets.dart';
import '../../offline/offline_problem.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../site_diary/diary_models.dart' show kDiaryDraftKind;
import '../../site_diary/diary_widgets.dart';
import '../hub_commands.dart';
import '../hub_models.dart';
import '../hub_support.dart';

/// QMS-09: the site diary on the phone, offline (ST-QMS-002, QMS 3.1). The diary itself is written, saved and signed in MOB-62; this is
/// the screen that shows where every diary stands. **On the phone**: what is written and not yet sent, in the queue (a diary is queued as
/// a command with the key the phone made, so one sent twice is one diary), and the copies that came back in conflict, which the person
/// settles in MOB-42 and which are never overwritten silently. **On the server**: the diaries that have copies nobody settled, which can
/// be settled here (online only, never queued), and the drafts that wait for the contractor's signature, which are signed in MOB-62.
/// Changing the organisation is blocked while anything is unsent (the account screens read the same queue). With `?diary=<id>` it opens the
/// settling of that diary's copies.
Widget buildHubScreen(BuildContext context, ScreenContext screen) {
  final String? id = screen.queryParameters['diary'];
  return id == null || id.isEmpty ? const _HubScreen() : _ResolveScreen(diaryId: id);
}

class _HubScreen extends StatefulWidget {
  const _HubScreen();

  @override
  State<_HubScreen> createState() => _HubScreenState();
}

class _HubScreenState extends State<_HubScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.dryhub.title'),
      actions: <Widget>[
        AppBarAction(icon: Icons.add, label: context.t('mob.dryhub.local.new.action'), onPressed: () => openScreen(context, 'MOB-61', stacked: true)),
      ],
      contextLine: UnderlineTabs(
        tabs: <TabOption>[TabOption(label: context.t('mob.dryhub.tab.local')), TabOption(label: context.t('mob.dryhub.tab.server'))],
        index: _tab,
        onChanged: (int next) => setState(() => _tab = next),
      ),
      body: _tab == 0 ? const _LocalTab() : const _ServerTab(),
    );
  }
}

/// The state that has no diary to show: the way out is to write one.
StateView _emptyView(BuildContext context, String body) => StateView(
      kind: StateKind.empty,
      body: body,
      actionLabel: context.t('mob.dryhub.empty.action'),
      onAction: () => openScreen(context, 'MOB-61', stacked: true),
    );

// ------------------------------------------------------------------------------------------------------------- on the phone

class _LocalTab extends ConsumerWidget {
  const _LocalTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<QueuedCommand>> commands = ref.watch(queuedCommandsProvider);
    final AsyncValue<DraftStore> drafts = ref.watch(draftStoreProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    if (commands.hasError || drafts.hasError) {
      final ProblemView problem = offlineProblemOf((commands.error ?? drafts.error)!, reachability);
      return StateBoundary(state: problem.state, problem: problem, onRetry: () {
        ref.invalidate(commandQueueProvider);
        ref.invalidate(draftStoreProvider);
      }, child: const SizedBox.shrink());
    }
    if (!commands.hasValue || !drafts.hasValue) {
      return const StateBoundary(state: ScreenState.loading, child: SizedBox.shrink());
    }
    final List<LocalDiary> diaries = localDiaries(drafts.requireValue.list(kind: kDiaryDraftKind), commands.requireValue);
    if (diaries.isEmpty) return _emptyView(context, context.t('mob.dryhub.local.empty.body'));
    final Map<String, String> codes = ref.watch(contractCodesProvider).value ?? const <String, String>{};
    final int unsent = unsentOf(diaries);
    final bool offline = reachability == Reachability.offline;
    void openQueue() => openScreen(context, 'MOB-41', stacked: true);
    final List<LocalDiary> act = <LocalDiary>[for (final LocalDiary diary in diaries) if (diary.state.index <= LocalState.unknown.index) diary];
    final List<LocalDiary> waiting = <LocalDiary>[for (final LocalDiary diary in diaries) if (diary.state.index > LocalState.unknown.index && diary.state != LocalState.sent) diary];
    final List<LocalDiary> done = <LocalDiary>[for (final LocalDiary diary in diaries) if (diary.state == LocalState.sent) diary];
    Iterable<Widget> group(String title, List<LocalDiary> rows) sync* {
      if (rows.isEmpty) return;
      yield GroupHeader(title: title, count: rows.length);
      for (int position = 0; position < rows.length; position += 1) {
        yield _LocalRow(diary: rows[position], contractCode: codes[rows[position].contractId], first: position == 0);
      }
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        if (offline)
          StatusBanner(text: context.t('mob.dryhub.local.offline'))
        else
          ContextLine(parts: <String>[context.t('mob.dryhub.local.online')]),
        if (unsent > 0 && !offline)
          StatusBanner(
            text: context.t('mob.dryhub.local.unsent', <String, Object>{'count': unsent}),
            tone: BannerTone.warning,
          )
        else
          ContextLine(parts: <String>[unsent == 0 ? context.t('mob.dryhub.local.allSent') : context.t('mob.dryhub.local.unsent', <String, Object>{'count': unsent})]),
        if (unsent > 0 || offline) ActionLinks(actions: <QuietAction>[QuietAction(label: context.t('mob.dryhub.local.queue.action'), onTap: openQueue)]),
        ...group(context.t('mob.dryhub.group.act'), act),
        ...group(context.t('mob.dryhub.group.waiting'), waiting),
        ...group(context.t('mob.dryhub.group.done'), done),
        Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Text(context.t('mob.dryhub.local.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
        ),
      ],
    );
  }
}

MachvonTone _toneOf(LocalState state) {
  switch (state) {
    case LocalState.conflict:
    case LocalState.unknown:
      return MachvonTone.warning;
    case LocalState.rejected:
      return MachvonTone.danger;
    case LocalState.sending:
    case LocalState.queued:
      return MachvonTone.info;
    case LocalState.draft:
      return MachvonTone.neutral;
    case LocalState.sent:
      return MachvonTone.success;
  }
}

IconData _iconOf(LocalState state) {
  switch (state) {
    case LocalState.conflict:
      return Icons.sync_problem_outlined;
    case LocalState.rejected:
      return Icons.error_outline;
    case LocalState.unknown:
      return Icons.help_outline;
    case LocalState.sending:
      return Icons.cloud_upload_outlined;
    case LocalState.queued:
      return Icons.schedule;
    case LocalState.draft:
      return Icons.edit_note_outlined;
    case LocalState.sent:
      return Icons.cloud_done_outlined;
  }
}

class _LocalRow extends StatelessWidget {
  const _LocalRow({required this.diary, required this.contractCode, required this.first});

  final LocalDiary diary;
  final String? contractCode;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String date = diary.recordDate == null ? context.t('mob.dryhub.row.unknownDate') : context.t('mob.dryhub.row.date', <String, Object>{'date': formatDay(diary.recordDate!)});
    final String contract = contractCode ?? context.t('mob.dryhub.row.contract.none');
    final String state = stateLabel(context, diary.state);
    final bool canOpen = diary.contractId != null && diary.recordDate != null;
    final bool showCode = diary.errorCode != null && diary.state != LocalState.queued && diary.state != LocalState.sent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        WorkRow(
          title: '$date · $contract',
          subtitle: diary.summary.isEmpty ? context.t('mob.dryhub.row.summary.none') : diary.summary,
          leading: FieldGlyph(icon: _iconOf(diary.state), alert: diary.state.index <= LocalState.unknown.index),
          trailing: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              StatusPill(label: state, tone: _toneOf(diary.state)),
              if (diary.photos > 0) Text(context.t('mob.dryhub.row.photos', <String, Object>{'count': diary.photos}), style: text.caption),
              if (showCode) Text(diary.errorCode!, style: text.caption),
            ],
          ),
          semanticLabel: <String>[
            context.t('mob.dryhub.row.aria', <String, Object>{'date': diary.recordDate == null ? date : formatDay(diary.recordDate!), 'contract': contract, 'state': state}),
            if (showCode) diary.errorCode!,
          ].join('. '),
          dividerAbove: !first,
        ),
        ActionLinks(
          actions: <QuietAction>[
            if (diary.state == LocalState.conflict && diary.commandId != null)
              QuietAction(label: context.t('mob.dryhub.row.resolve.action'), onTap: () => openScreen(context, 'MOB-42', pathSuffix: '/${diary.commandId}', stacked: true)),
            if (canOpen)
              QuietAction(
                label: context.t('mob.dryhub.row.open.action'),
                onTap: () => openScreen(context, 'MOB-62', pathSuffix: '/${diary.contractId}', query: <String, String>{'date': diary.recordDate!}, stacked: true),
              ),
          ],
        ),
      ],
    );
  }
}

// ------------------------------------------------------------------------------------------------------------- on the server

class _ServerTab extends ConsumerWidget {
  const _ServerTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DataView<HubServer>(
      cacheKey: 'diaryhub.server',
      reloadKey: ref.watch(hubChangedProvider),
      read: readHubServer,
      parse: parseHubServer,
      asOf: (HubServer server) => server.asOf,
      builder: (BuildContext context, Loaded<HubServer> loaded) {
        final HubServer server = loaded.value;
        if (server.isEmpty) return _emptyView(context, context.t('mob.dryhub.server.empty.body'));
        return ListView(
          padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(MachvonV2Space.s16),
              child: Text(context.t('mob.dryhub.server.intro'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
            ),
            if (server.conflicts.isNotEmpty) ...<Widget>[
              GroupHeader(title: context.t('mob.dryhub.server.conflicts.title'), count: server.conflicts.length),
              for (int position = 0; position < server.conflicts.length; position += 1) _ServerRow(diary: server.conflicts[position], conflict: true, first: position == 0),
            ],
            if (server.toSign.isNotEmpty) ...<Widget>[
              GroupHeader(title: context.t('mob.dryhub.server.sign.title'), count: server.toSign.length),
              for (int position = 0; position < server.toSign.length; position += 1) _ServerRow(diary: server.toSign[position], conflict: false, first: position == 0),
            ],
            if (server.more)
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.dryhub.server.more'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
              ),
          ],
        );
      },
    );
  }
}

class _ServerRow extends StatelessWidget {
  const _ServerRow({required this.diary, required this.conflict, required this.first});

  final ServerDiary diary;
  final bool conflict;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final String date = formatDay(diary.record.recordDate);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        WorkRow(
          title: '${diary.record.diaryNo} · ${context.t('mob.dryhub.row.date', <String, Object>{'date': date})}',
          subtitle: diary.contractCode,
          leading: FieldGlyph(icon: conflict ? Icons.sync_problem_outlined : Icons.draw_outlined, alert: conflict),
          trailing: conflict ? StatusPill(label: context.t('mob.dryhub.server.conflicts.count', <String, Object>{'count': diary.copies.length}), tone: MachvonTone.warning) : null,
          semanticLabel: context.t('mob.dryhub.server.row.aria', <String, Object>{'no': diary.record.diaryNo, 'date': date, 'contract': diary.contractCode}),
          dividerAbove: !first,
        ),
        ActionLinks(
          actions: <QuietAction>[
            if (conflict)
              QuietAction(label: context.t('mob.dryhub.server.resolve.action'), onTap: () => openScreen(context, 'QMS-09', query: <String, String>{'diary': diary.record.id}, stacked: true))
            else
              QuietAction(
                label: context.t('mob.dryhub.server.sign.action'),
                onTap: () => openScreen(context, 'MOB-62', pathSuffix: '/${diary.record.contractId}', query: <String, String>{'date': diary.record.recordDate}, stacked: true),
              ),
          ],
        ),
      ],
    );
  }
}

// -------------------------------------------------------------------------------------------------------------- settling

class _ResolveScreen extends ConsumerStatefulWidget {
  const _ResolveScreen({required this.diaryId});

  final String diaryId;

  @override
  ConsumerState<_ResolveScreen> createState() => _ResolveScreenState();
}

class _ResolveScreenState extends ConsumerState<_ResolveScreen> {
  int _changed = 0;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.dryhub.resolve.title'),
      body: DataView<ServerDiary>(
        cacheKey: 'diaryhub.diary.${widget.diaryId}',
        reloadKey: _changed,
        read: (MachvonApiClient client) => client.getResourcesSiteDiaryId(id: widget.diaryId),
        parse: parseServerDiary,
        builder: (BuildContext context, Loaded<ServerDiary> loaded) => _ResolveBody(
          diary: loaded.value,
          fromCopy: loaded.fromCache,
          onChanged: () {
            ref.read(hubChangedProvider.notifier).bump();
            setState(() => _changed += 1);
          },
        ),
      ),
    );
  }
}

class _ResolveBody extends ConsumerStatefulWidget {
  const _ResolveBody({required this.diary, required this.fromCopy, required this.onChanged});

  final ServerDiary diary;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<_ResolveBody> createState() => _ResolveBodyState();
}

class _ResolveBodyState extends ConsumerState<_ResolveBody> with CommandFlow<_ResolveBody> {
  late final ResolveCommands _commands = ResolveCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _note = TextEditingController();
  String? _copyId;
  Resolution? _resolution;
  Map<String, ResolveProblem> _problems = const <String, ResolveProblem>{};
  Future<CommandOutcome> Function({bool again})? _last;

  @override
  void initState() {
    super.initState();
    if (widget.diary.copies.length == 1) _copyId = widget.diary.copies.single.id;
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _send(Future<CommandOutcome> Function({bool again}) send, {bool again = false}) async {
    _last = send;
    await run(() => send(again: again), onDone: () {
      _note.clear();
      widget.onChanged();
    });
    // A refusal leaves the diary as it was on the server: read it again so that the screen shows that and not what the phone assumed.
    if (mounted && outcome is CommandRefused) widget.onChanged();
  }

  void _submit() {
    final ServerDiary diary = widget.diary;
    final Map<String, ResolveProblem> problems = checkResolution(
      copyId: _copyId,
      copies: diary.copies.map((ConflictCopy copy) => copy.id),
      resolution: _resolution,
      note: _note.text,
      draft: diary.record.status == 'DRAFT',
    );
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    final String copy = _copyId!;
    final Resolution resolution = _resolution!;
    final String note = _note.text;
    _send(({bool again = false}) => _commands.resolve(diaryId: diary.record.id, version: diary.record.version, copyId: copy, resolution: resolution, note: note, retryAfterUnknown: again));
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.dryhub.result.done.title'), lines: <String>[context.t('mob.dryhub.result.done.body')], tone: NoticeTone.ok);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.dryhub.result.unknown.title'),
          lines: <String>[context.t('mob.dryhub.result.unknown.body')],
          actionLabel: context.t('mob.dryhub.result.unknown.action'),
          onAction: _last == null ? null : () => _send(_last!, again: true),
          tone: NoticeTone.warning,
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, ResolveGate.offline));
      case CommandRefused():
        final HubProblem problem = problemOf(result);
        final bool retry = isRetryable(problem) && _last != null;
        return OutcomeCard(
          title: problemText(context, problem),
          code: result.code,
          actionLabel: retry ? context.t('mob.dryhub.result.retry.action') : null,
          onAction: retry ? () => _send(_last!, again: true) : null,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final ServerDiary diary = widget.diary;
    final ResolveGate gate = gateOf(diary: diary, offline: isOffline(ref), fromCopy: widget.fromCopy, session: ref.watch(sessionProvider));
    final CommandOutcome? result = outcome;
    final bool ready = gate == ResolveGate.open && !sending;
    final bool signed = diary.record.status != 'DRAFT';
    String copyLabel(ConflictCopy copy) => context.t('mob.dryhub.resolve.copy.label', <String, Object>{'no': copy.diaryNo, 'author': copy.author, 'time': formatMoment(copy.createdAt)});
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
            children: <Widget>[
              if (result != null) _outcome(context, result),
              FormSection(
                first: true,
                title: context.t('mob.dryhub.resolve.diary.title'),
                children: <Widget>[
                  Text('${diary.record.diaryNo} · ${context.t('mob.dryhub.row.date', <String, Object>{'date': formatDay(diary.record.recordDate)})} · ${diary.contractCode}', style: text.bodyStrong),
                  ..._facts(context, diary.record.content),
                ],
              ),
              for (final ConflictCopy copy in diary.copies)
                FormSection(
                  title: context.t('mob.dryhub.resolve.copy.title'),
                  children: <Widget>[
                    Text(copyLabel(copy), style: text.bodyStrong),
                    ..._facts(context, copy.content),
                  ],
                ),
              if (diary.hasConflict)
                FormSection(
                  title: context.t('mob.dryhub.resolve.choice.title'),
                  children: <Widget>[
                    if (diary.copies.length > 1) ...<Widget>[
                      DropdownButtonFormField<String>(
                        initialValue: _copyId,
                        isExpanded: true,
                        decoration: InputDecoration(
                          labelText: context.t('mob.dryhub.resolve.copy.title'),
                          errorText: _problems['copy'] == null ? null : resolveProblemText(context, _problems['copy']!),
                        ),
                        items: <DropdownMenuItem<String>>[
                          for (final ConflictCopy copy in diary.copies) DropdownMenuItem<String>(value: copy.id, child: Text(copyLabel(copy), overflow: TextOverflow.ellipsis)),
                        ],
                        onChanged: ready ? (String? id) => setState(() => _copyId = id) : null,
                      ),
                      const SizedBox(height: MachvonV2Space.s12),
                    ],
                    DropdownButtonFormField<Resolution>(
                      initialValue: _resolution,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: context.t('mob.dryhub.resolve.choice.title'),
                        errorText: _problems['resolution'] == null ? null : resolveProblemText(context, _problems['resolution']!),
                      ),
                      items: <DropdownMenuItem<Resolution>>[
                        DropdownMenuItem<Resolution>(value: Resolution.keepPrimary, child: Text(context.t('mob.dryhub.resolve.keep'), overflow: TextOverflow.ellipsis)),
                        if (!signed) DropdownMenuItem<Resolution>(value: Resolution.adoptCopy, child: Text(context.t('mob.dryhub.resolve.adopt'), overflow: TextOverflow.ellipsis)),
                      ],
                      onChanged: ready ? (Resolution? choice) => setState(() => _resolution = choice) : null,
                    ),
                    if (signed) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.dryhub.resolve.onlyKeep'), style: text.caption)),
                    Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.dryhub.resolve.merge'), style: text.caption)),
                    const SizedBox(height: MachvonV2Space.s12),
                    TextField(
                      controller: _note,
                      readOnly: sending,
                      minLines: 3,
                      maxLines: 6,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(labelText: context.t('mob.dryhub.resolve.note.label'), errorText: _problems['note'] == null ? null : resolveProblemText(context, _problems['note']!)),
                    ),
                  ],
                )
              else
                FormSection(
                  title: context.t('mob.dryhub.resolve.choice.title'),
                  children: <Widget>[NoticePanel(title: gateText(context, gate == ResolveGate.open ? ResolveGate.noCopy : gate), margin: EdgeInsets.zero)],
                ),
            ],
          ),
        ),
        if (diary.hasConflict)
          FieldSendBar(
            label: context.t('mob.dryhub.resolve.submit'),
            onSend: ready ? _submit : null,
            sending: sending,
            why: gate == ResolveGate.open ? null : gateText(context, gate),
          ),
      ],
    );
  }

  /// What the content of a diary says that the person compares: the work of the day, the workforce and the notes.
  List<Widget> _facts(BuildContext context, Map<String, Object?> content) {
    final MachvonV2Text text = context.v2text;
    final Object? summary = content['summary'];
    final Object? workforce = content['workforce_count'];
    final Object? notes = content['notes'];
    final List<Widget> lines = <Widget>[
      if (summary is String && summary.isNotEmpty) Text(context.t('mob.dryhub.resolve.content.summary', <String, Object>{'text': summary}), style: text.body),
      if (workforce is int) Text(context.t('mob.dryhub.resolve.content.workforce', <String, Object>{'count': workforce}), style: text.body),
      if (notes is String && notes.isNotEmpty) Text(context.t('mob.dryhub.resolve.content.notes', <String, Object>{'text': notes}), style: text.body),
    ];
    return lines.isEmpty ? <Widget>[Text(context.t('mob.dryhub.resolve.content.none'), style: text.body)] : lines;
  }
}
