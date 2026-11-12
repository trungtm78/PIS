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
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../offline/offline_problem.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../../site_diary/diary_models.dart' show kDiaryDraftKind;
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

class _HubScreen extends StatelessWidget {
  const _HubScreen();

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(context.t('mob.dryhub.title')),
          actions: <Widget>[
            IconButton(
              tooltip: context.t('mob.dryhub.local.new.action'),
              icon: const Icon(Icons.add),
              onPressed: () => openScreen(context, 'MOB-61', stacked: true),
            ),
          ],
          bottom: TabBar(
            tabs: <Widget>[
              Tab(text: context.t('mob.dryhub.tab.local')),
              Tab(text: context.t('mob.dryhub.tab.server')),
            ],
          ),
        ),
        body: const TabBarView(children: <Widget>[_LocalTab(), _ServerTab()]),
      ),
    );
  }
}

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
    if (diaries.isEmpty) return const StateBoundary(state: ScreenState.empty, child: SizedBox.shrink());
    final Map<String, String> codes = ref.watch(contractCodesProvider).value ?? const <String, String>{};
    final int unsent = unsentOf(diaries);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.all(MachvonSpace.space16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.dryhub.local.intro'), style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: MachvonSpace.space8),
              Semantics(
                liveRegion: true,
                child: Text(
                  reachability == Reachability.offline ? context.t('mob.dryhub.local.offline') : context.t('mob.dryhub.local.online'),
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(height: MachvonSpace.space4),
              Text(
                unsent == 0 ? context.t('mob.dryhub.local.allSent') : context.t('mob.dryhub.local.unsent', <String, Object>{'count': unsent}),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: MachvonSpace.space8),
              OutlinedButton(onPressed: () => openScreen(context, 'MOB-41', stacked: true), child: Text(context.t('mob.dryhub.local.queue.action'))),
            ],
          ),
        ),
        for (final LocalDiary diary in diaries) _LocalRow(diary: diary, contractCode: codes[diary.contractId]),
      ],
    );
  }
}

class _LocalRow extends StatelessWidget {
  const _LocalRow({required this.diary, required this.contractCode});

  final LocalDiary diary;
  final String? contractCode;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String date = diary.recordDate == null ? context.t('mob.dryhub.row.unknownDate') : context.t('mob.dryhub.row.date', <String, Object>{'date': formatDay(diary.recordDate!)});
    final String contract = contractCode ?? context.t('mob.dryhub.row.contract.none');
    final String state = stateLabel(context, diary.state);
    final bool canOpen = diary.contractId != null && diary.recordDate != null;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
      child: Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Semantics(
              container: true,
              label: context.t('mob.dryhub.row.aria', <String, Object>{'date': diary.recordDate == null ? date : formatDay(diary.recordDate!), 'contract': contract, 'state': state}),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('$date · $contract', style: theme.textTheme.titleMedium),
                  Text(diary.summary.isEmpty ? context.t('mob.dryhub.row.summary.none') : diary.summary, style: theme.textTheme.bodyMedium),
                  const SizedBox(height: MachvonSpace.space4),
                  Wrap(
                    spacing: MachvonSpace.space8,
                    runSpacing: MachvonSpace.space4,
                    children: <Widget>[
                      StatusPill(label: state, warn: diary.state.index <= LocalState.unknown.index),
                      if (diary.photos > 0) StatusPill(label: context.t('mob.dryhub.row.photos', <String, Object>{'count': diary.photos})),
                      if (diary.errorCode != null && diary.state != LocalState.queued && diary.state != LocalState.sent) Text(diary.errorCode!, style: theme.textTheme.bodySmall),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: MachvonSpace.space8),
            Wrap(
              spacing: MachvonSpace.space8,
              runSpacing: MachvonSpace.space8,
              children: <Widget>[
                if (diary.state == LocalState.conflict && diary.commandId != null)
                  FilledButton(onPressed: () => openScreen(context, 'MOB-42', pathSuffix: '/${diary.commandId}', stacked: true), child: Text(context.t('mob.dryhub.row.resolve.action'))),
                if (canOpen)
                  OutlinedButton(
                    onPressed: () => openScreen(context, 'MOB-62', pathSuffix: '/${diary.contractId}', query: <String, String>{'date': diary.recordDate!}, stacked: true),
                    child: Text(context.t('mob.dryhub.row.open.action')),
                  ),
              ],
            ),
          ],
        ),
      ),
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
      isEmpty: (HubServer server) => server.isEmpty,
      builder: (BuildContext context, Loaded<HubServer> loaded) {
        final HubServer server = loaded.value;
        return ListView(
          padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.all(MachvonSpace.space16),
              child: Text(context.t('mob.dryhub.server.intro'), style: Theme.of(context).textTheme.bodyMedium),
            ),
            if (server.conflicts.isNotEmpty)
              SectionCard(
                title: context.t('mob.dryhub.server.conflicts.title'),
                children: <Widget>[for (final ServerDiary diary in server.conflicts) _ServerRow(diary: diary, conflict: true)],
              ),
            if (server.toSign.isNotEmpty)
              SectionCard(
                title: context.t('mob.dryhub.server.sign.title'),
                children: <Widget>[for (final ServerDiary diary in server.toSign) _ServerRow(diary: diary, conflict: false)],
              ),
            if (server.more)
              Padding(
                padding: const EdgeInsets.all(MachvonSpace.space16),
                child: Text(context.t('mob.dryhub.server.more'), style: Theme.of(context).textTheme.bodySmall),
              ),
          ],
        );
      },
    );
  }
}

class _ServerRow extends StatelessWidget {
  const _ServerRow({required this.diary, required this.conflict});

  final ServerDiary diary;
  final bool conflict;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String date = formatDay(diary.record.recordDate);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(
            container: true,
            label: context.t('mob.dryhub.server.row.aria', <String, Object>{'no': diary.record.diaryNo, 'date': date, 'contract': diary.contractCode}),
            excludeSemantics: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('${diary.record.diaryNo} · ${context.t('mob.dryhub.row.date', <String, Object>{'date': date})}', style: theme.textTheme.bodyLarge),
                Text(diary.contractCode, style: theme.textTheme.bodyMedium),
                if (conflict) Text(context.t('mob.dryhub.server.conflicts.count', <String, Object>{'count': diary.copies.length}), style: theme.textTheme.bodyMedium),
              ],
            ),
          ),
          const SizedBox(height: MachvonSpace.space8),
          if (conflict)
            FilledButton(
              onPressed: () => openScreen(context, 'QMS-09', query: <String, String>{'diary': diary.record.id}, stacked: true),
              child: Text(context.t('mob.dryhub.server.resolve.action')),
            )
          else
            OutlinedButton(
              onPressed: () => openScreen(context, 'MOB-62', pathSuffix: '/${diary.record.contractId}', query: <String, String>{'date': diary.record.recordDate}, stacked: true),
              child: Text(context.t('mob.dryhub.server.sign.action')),
            ),
        ],
      ),
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
    return ScreenFrame(
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
        return OutcomeCard(title: context.t('mob.dryhub.result.done.title'), lines: <String>[context.t('mob.dryhub.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.dryhub.result.unknown.title'),
          lines: <String>[context.t('mob.dryhub.result.unknown.body')],
          actionLabel: context.t('mob.dryhub.result.unknown.action'),
          onAction: _last == null ? null : () => _send(_last!, again: true),
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
    final ServerDiary diary = widget.diary;
    final ResolveGate gate = gateOf(diary: diary, offline: isOffline(ref), fromCopy: widget.fromCopy, session: ref.watch(sessionProvider));
    final CommandOutcome? result = outcome;
    final bool ready = gate == ResolveGate.open && !sending;
    final bool signed = diary.record.status != 'DRAFT';
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (result != null) _outcome(context, result),
        SectionCard(
          title: context.t('mob.dryhub.resolve.diary.title'),
          children: <Widget>[
            Text('${diary.record.diaryNo} · ${context.t('mob.dryhub.row.date', <String, Object>{'date': formatDay(diary.record.recordDate)})} · ${diary.contractCode}', style: Theme.of(context).textTheme.bodyLarge),
            ..._facts(context, diary.record.content),
          ],
        ),
        for (final ConflictCopy copy in diary.copies)
          SectionCard(
            title: context.t('mob.dryhub.resolve.copy.title'),
            semanticLabel: context.t('mob.dryhub.resolve.copy.label', <String, Object>{'no': copy.diaryNo, 'author': copy.author, 'time': formatMoment(copy.createdAt)}),
            children: <Widget>[
              Text(context.t('mob.dryhub.resolve.copy.label', <String, Object>{'no': copy.diaryNo, 'author': copy.author, 'time': formatMoment(copy.createdAt)}), style: Theme.of(context).textTheme.bodyLarge),
              ..._facts(context, copy.content),
            ],
          ),
        if (diary.hasConflict)
          SectionCard(
            title: context.t('mob.dryhub.resolve.choice.title'),
            children: <Widget>[
              if (gate != ResolveGate.open) GateNote(text: gateText(context, gate)),
              if (diary.copies.length > 1)
                DropdownButtonFormField<String>(
                  initialValue: _copyId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: context.t('mob.dryhub.resolve.copy.title'),
                    errorText: _problems['copy'] == null ? null : resolveProblemText(context, _problems['copy']!),
                  ),
                  items: <DropdownMenuItem<String>>[
                    for (final ConflictCopy copy in diary.copies)
                      DropdownMenuItem<String>(
                        value: copy.id,
                        child: Text(context.t('mob.dryhub.resolve.copy.label', <String, Object>{'no': copy.diaryNo, 'author': copy.author, 'time': formatMoment(copy.createdAt)}), overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: ready ? (String? id) => setState(() => _copyId = id) : null,
                ),
              const SizedBox(height: MachvonSpace.space8),
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
              if (signed) Text(context.t('mob.dryhub.resolve.onlyKeep'), style: Theme.of(context).textTheme.bodySmall),
              Text(context.t('mob.dryhub.resolve.merge'), style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: MachvonSpace.space8),
              TextField(
                controller: _note,
                readOnly: sending,
                minLines: 3,
                maxLines: 6,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(labelText: context.t('mob.dryhub.resolve.note.label'), errorText: _problems['note'] == null ? null : resolveProblemText(context, _problems['note']!)),
              ),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(onPressed: ready ? _submit : null, child: Text(sending ? context.t('mob.dryhub.resolve.sending') : context.t('mob.dryhub.resolve.submit'))),
            ],
          )
        else
          SectionCard(title: context.t('mob.dryhub.resolve.choice.title'), children: <Widget>[GateNote(text: gateText(context, gate == ResolveGate.open ? ResolveGate.noCopy : gate))]),
      ],
    );
  }

  /// What the content of a diary says that the person compares: the work of the day, the workforce and the notes.
  List<Widget> _facts(BuildContext context, Map<String, Object?> content) {
    final ThemeData theme = Theme.of(context);
    final Object? summary = content['summary'];
    final Object? workforce = content['workforce_count'];
    final Object? notes = content['notes'];
    final List<Widget> lines = <Widget>[
      if (summary is String && summary.isNotEmpty) Text(context.t('mob.dryhub.resolve.content.summary', <String, Object>{'text': summary}), style: theme.textTheme.bodyMedium),
      if (workforce is int) Text(context.t('mob.dryhub.resolve.content.workforce', <String, Object>{'count': workforce}), style: theme.textTheme.bodyMedium),
      if (notes is String && notes.isNotEmpty) Text(context.t('mob.dryhub.resolve.content.notes', <String, Object>{'text': notes}), style: theme.textTheme.bodyMedium),
    ];
    return lines.isEmpty ? <Widget>[Text(context.t('mob.dryhub.resolve.content.none'), style: theme.textTheme.bodyMedium)] : lines;
  }
}
