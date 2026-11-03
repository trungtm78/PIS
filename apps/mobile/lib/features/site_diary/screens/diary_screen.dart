import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../field_evidence/evidence_photos.dart';
import '../../field_evidence/evidence_photos_field.dart';
import '../../field_evidence/field_place.dart';
import '../../field_evidence/place_consent_field.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/widgets.dart';
import '../diary_commands.dart';
import '../diary_labels.dart';
import '../diary_models.dart';
import '../diary_reads.dart';
import '../diary_service.dart';

/// MOB-62: the site diary of a contract and a day, written on the phone. The diary is a draft on the device while it is written, and
/// "Save" queues it as one command with a key the phone made, so it is sent when there is a network and sent again after a lost
/// answer without making a second diary (UAT-AC358). The contractor's signature, the correction of a signed diary and the choice
/// between two versions are made online, on the diary as the server holds it. A signed diary cannot be edited (its content hash is
/// over the content); a correction is a new revision with its reason.
Widget buildDiaryScreen(BuildContext context, ScreenContext screen) =>
    DiaryScreen(
      contractId: screen.pathParameters['contractId'] ?? '',
      requestedDay: screen.queryParameters['date'],
    );

class DiaryScreen extends ConsumerStatefulWidget {
  const DiaryScreen({required this.contractId, this.requestedDay, super.key});

  final String contractId;
  final String? requestedDay;

  @override
  ConsumerState<DiaryScreen> createState() => _DiaryScreenState();
}

class _DiaryScreenState extends ConsumerState<DiaryScreen> {
  String? _day;
  int _reload = 0;

  /// The calendar day in Vietnam now. The phone's clock only proposes the day to write; the server decides what is allowed.
  String get _today => vietnamDayOf(ref.read(clockProvider)());

  String get _selected {
    final String? asked = _day ?? widget.requestedDay;
    return asked != null && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(asked)
        ? asked
        : _today;
  }

  @override
  Widget build(BuildContext context) {
    final String day = _selected;
    final String contractId = widget.contractId;
    return ScreenFrame(
      title: context.t('mob.dry.diary.title'),
      body: DataView<DiaryDay>(
        cacheKey: 'diary.$contractId.$day',
        reloadKey: _reload,
        read: (MachvonApiClient client) =>
            readDiaryDay(client, contractId, day),
        parse: parseDiaryDay,
        builder: (BuildContext context, Loaded<DiaryDay> loaded) => _DiaryBody(
          key: ValueKey<String>('$contractId|$day'),
          day: loaded.value,
          recordDate: day,
          fromCopy: loaded.fromCache,
          today: _today,
          onDay: (String next) => setState(() => _day = next),
          onChanged: () => setState(() => _reload += 1),
        ),
      ),
    );
  }
}

class _DiaryBody extends ConsumerStatefulWidget {
  const _DiaryBody({
    required this.day,
    required this.recordDate,
    required this.fromCopy,
    required this.today,
    required this.onDay,
    required this.onChanged,
    super.key,
  });

  final DiaryDay day;
  final String recordDate;
  final bool fromCopy;
  final String today;
  final ValueChanged<String> onDay;
  final VoidCallback onChanged;

  @override
  ConsumerState<_DiaryBody> createState() => _DiaryBodyState();
}

enum _Notice { queued, busy, unverifiable, store }

class _DiaryBodyState extends ConsumerState<_DiaryBody>
    with CommandFlow<_DiaryBody> {
  final TextEditingController _summary = TextEditingController();
  final TextEditingController _items = TextEditingController();
  final TextEditingController _workforce = TextEditingController();
  final TextEditingController _notes = TextEditingController();
  final TextEditingController _correctionSummary = TextEditingController();
  final TextEditingController _correctionNotes = TextEditingController();
  final TextEditingController _reason = TextEditingController();
  late final DiaryCommands _commands = DiaryCommands(
    client: ref.read(apiClientProvider),
    isOnline: () => ref.read(reachabilityProvider) != Reachability.offline,
  );

  String _draftId = '';
  DiaryDraft? _draft;
  Map<String, DiaryProblem> _problems = const <String, DiaryProblem>{};
  CorrectionProblem? _reasonProblem;
  _Notice? _notice;
  String? _lastCommand;
  bool _saving = false;
  Future<void> _writing = Future<void>.value();

  DiaryRecord? get _diary => widget.day.diary;

  /// The diary can be written over on this phone: there is none yet, or it is a draft that the server lets this person revise.
  bool get _editable => _diary == null || _diary!.isEditable;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  @override
  void dispose() {
    for (final TextEditingController controller in <TextEditingController>[
      _summary,
      _items,
      _workforce,
      _notes,
      _correctionSummary,
      _correctionNotes,
      _reason,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  DiaryService get _service => ref.read(diaryServiceProvider);

  Future<void> _open() async {
    StoredDiaryDraft? stored;
    bool settled = false;
    try {
      stored = await _service.draftFor(
        widget.day.contract.id,
        widget.recordDate,
      );
      final String? commandId = stored.draft.commandId;
      if (commandId != null) {
        final QueuedCommand? command = (await ref.read(
          commandQueueProvider.future,
        )).command(commandId);
        // Only the save as it was queued is settled: what was written after it is the person's work still to be saved.
        settled = command?.state == CommandState.accepted && !stored.draft.edited;
      }
    } on Object {
      if (mounted) setState(() => _notice = _Notice.store);
    }
    if (!mounted) return;
    // A draft whose save was taken by the server says nothing more than the diary does: the diary on the server is shown.
    final bool local = stored != null && stored.id.isNotEmpty && !settled;
    final DiaryRecord? diary = _diary;
    final DiaryDraft draft = local
        ? stored.draft
        : (stored?.draft ??
              DiaryDraft(
                contractId: widget.day.contract.id,
                recordDate: widget.recordDate,
                operationId: newUuidV4(),
              ));
    final DiaryForm form = local
        ? draft.form
        : (diary != null ? DiaryForm.of(diary) : const DiaryForm());
    setState(() {
      _draftId = stored?.id ?? '';
      _draft = draft.copyWith(
        form: form,
        place: local ? draft.place : FieldPlace.none,
        photos: local ? draft.photos : const <EvidencePhoto>[],
      );
      _lastCommand = draft.commandId;
      _summary.text = form.summary;
      _items.text = form.workItems;
      _workforce.text = form.workforce;
      _notes.text = form.notes;
      if (diary != null) {
        final DiaryForm shown = DiaryForm.of(diary);
        _correctionSummary.text = shown.summary;
        _correctionNotes.text = shown.notes;
      }
    });
  }

  void _change(DiaryDraft next) {
    setState(() {
      _draft = next.copyWith(edited: true);
      _problems = const <String, DiaryProblem>{};
      _notice = null;
    });
    unawaited(_persist());
  }

  /// Writes the draft after every change, one write after the other, so the last change is the one that stays. Gives the id of the
  /// draft on the device once THIS draft is written, and null when the write failed: the id of an earlier write stands for an older
  /// content, and nothing may be queued from that.
  Future<String?> _persist() {
    final DiaryDraft? draft = _draft;
    if (draft == null) return Future<String?>.value(_draftId);
    final Future<String?> written = _writing.then((void _) async {
      try {
        _draftId = await _service.save(draft, draftId: _draftId);
        if (mounted && _notice == _Notice.store) setState(() => _notice = null);
        return _draftId;
      } on Object {
        if (mounted) setState(() => _notice = _Notice.store);
        return null;
      }
    });
    _writing = written.then((String? _) {});
    return written;
  }

  Future<void> _save() async {
    final DiaryDraft? draft = _draft;
    if (draft == null || _saving) return;
    final Map<String, DiaryProblem> problems = checkDiary(
      draft.form,
      recordDate: widget.recordDate,
      today: widget.today,
    );
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return;
    setState(() {
      _saving = true;
      _notice = null;
    });
    try {
      final String? id = await _persist();
      if (id == null || id.isEmpty) return;
      final QueuedCommand command = await _service.queueSave(
        id,
        today: widget.today,
        over: _diary,
      );
      // The service wrote the draft again (the command it made, the uploads it handed over): the screen takes that copy, so the
      // next change does not write over it with a draft that does not know them.
      final StoredDiaryDraft fresh = await _service.draftFor(widget.day.contract.id, widget.recordDate);
      if (mounted) {
        setState(() {
          _draft = fresh.draft;
          _draftId = fresh.id;
          _notice = _Notice.queued;
          _lastCommand = command.id;
        });
      }
    } on DiaryBusy {
      if (mounted) setState(() => _notice = _Notice.busy);
    } on ResultUnverifiable {
      if (mounted) setState(() => _notice = _Notice.unverifiable);
    } on DiaryNotReady catch (notReady) {
      if (mounted) setState(() => _problems = notReady.problems);
    } on AttachmentRefused {
      if (mounted) setState(() => _notice = _Notice.store);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// The consent changed or a position arrived. Taking the consent back takes the place and the time out of the photographs too.
  Future<void> _placeChanged(FieldPlace next) async {
    final DiaryDraft? draft = _draft;
    if (draft == null) return;
    final List<EvidencePhoto> photos = await enforcePhotoConsent(draft.photos, consent: next.consent);
    _change(draft.copyWith(place: next, photos: photos));
  }

  Future<void> _sign({bool again = false}) {
    final DiaryRecord? diary = _diary;
    if (diary == null) return Future<void>.value();
    return run(
      () => _commands.sign(diary, retryAfterUnknown: again),
      onDone: widget.onChanged,
    );
  }

  Future<void> _correct({bool again = false}) {
    final DiaryRecord? diary = _diary;
    if (diary == null) return Future<void>.value();
    final CorrectionProblem? problem = checkCorrectionReason(_reason.text);
    setState(() => _reasonProblem = problem);
    if (problem != null) return Future<void>.value();
    final DiaryForm form = DiaryForm.of(
      diary,
    ).copyWith(summary: _correctionSummary.text, notes: _correctionNotes.text);
    if (checkDiary(
      form,
      recordDate: diary.recordDate,
      today: widget.today,
    ).containsKey('summary')) {
      setState(
        () => _problems = <String, DiaryProblem>{
          'correction': DiaryProblem.required,
        },
      );
      return Future<void>.value();
    }
    return run(
      () => _commands.correct(
        diary,
        form,
        _reason.text,
        retryAfterUnknown: again,
      ),
      onDone: widget.onChanged,
    );
  }

  String _dayShift(int days) {
    final DateTime moved = DateTime.parse('${widget.recordDate}T00:00:00Z')
        .add(Duration(days: days));
    return moved.toIso8601String().substring(0, 10);
  }

  @override
  Widget build(BuildContext context) {
    final DiaryDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final DiaryDay day = widget.day;
    final DiaryRecord? diary = _diary;
    final ThemeData theme = Theme.of(context);
    final bool readOnlySession = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final String? commandId = _lastCommand ?? draft.commandId;
    QueuedCommand? pending;
    if (commandId != null) {
      for (final QueuedCommand command
          in ref.watch(queuedCommandsProvider).asData?.value ??
              const <QueuedCommand>[]) {
        if (command.id == commandId) pending = command;
      }
    }
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (
      AsyncValue<List<QueuedCommand>>? previous,
      AsyncValue<List<QueuedCommand>> next,
    ) {
      final String? watched = _lastCommand ?? _draft?.commandId;
      if (watched == null) return;
      bool taken(AsyncValue<List<QueuedCommand>>? value) =>
          value?.asData?.value.any(
            (QueuedCommand c) =>
                c.id == watched && c.state == CommandState.accepted,
          ) ??
          false;
      if (taken(next) && !taken(previous)) widget.onChanged();
    });
    final bool unsent =
        pending != null &&
        pending.state != CommandState.accepted &&
        pending.state != CommandState.discarded;
    final bool canSign =
        diary != null &&
        diary.canSign &&
        diary.signableRoles.contains('CONTRACTOR') &&
        diary.status == 'DRAFT';
    final String? signGate = !canSign
        ? null
        : (offline || widget.fromCopy
              ? context.t('mob.dry.gate.offline')
              : (readOnlySession
                    ? context.t('mob.dry.gate.readOnly')
                    : (unsent ? context.t('mob.dry.gate.unsent') : null)));
    final CommandOutcome? result = outcome;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: day.contract.label,
          children: <Widget>[
            Row(
              children: <Widget>[
                IconButton(
                  onPressed: () => widget.onDay(_dayShift(-1)),
                  tooltip: context.t('mob.dry.diary.day.previous'),
                  icon: const Icon(Icons.chevron_left),
                ),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      context.t('mob.dry.diary.day.label', <String, Object>{
                        'day': formatDay(widget.recordDate),
                      }),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                ),
                IconButton(
                  onPressed: widget.recordDate.compareTo(widget.today) < 0
                      ? () => widget.onDay(_dayShift(1))
                      : null,
                  tooltip: context.t('mob.dry.diary.day.next'),
                  icon: const Icon(Icons.chevron_right),
                ),
              ],
            ),
            if (_problems['date'] != null)
              Text(diaryProblemText(context, _problems['date']!)),
            StatusPill(
              label: diary == null
                  ? context.t('mob.dry.diary.none')
                  : diaryStatusText(context, diary.status),
            ),
            if (diary != null)
              FactLine(
                label: context.t('mob.dry.diary.no'),
                value: diary.diaryNo,
              ),
            if (diary != null && diary.pendingConflicts > 0)
              Text(
                context.t('mob.dry.diary.conflicts', <String, Object>{
                  'count': diary.pendingConflicts,
                }),
              ),
          ],
        ),
        if (_notice == _Notice.store)
          GateNote(text: context.t('mob.dry.save.store.notice')),
        if (widget.fromCopy)
          GateNote(text: context.t('mob.dry.diary.copy.notice')),
        if (pending != null) _Pending(command: pending),
        if (_notice == _Notice.queued)
          GateNote(
            text: offline
                ? context.t('mob.dry.save.queuedOffline')
                : context.t('mob.dry.save.queued'),
          ),
        if (_notice == _Notice.busy)
          GateNote(text: context.t('mob.dry.save.busy')),
        if (_notice == _Notice.unverifiable)
          GateNote(text: context.t('mob.queue.reason.unverifiable.body')),
        if (result != null) _outcomeCard(context, result),
        if (_editable)
          _form(context, draft, readOnlySession)
        else
          _signedContent(context, diary!),
        if (diary != null && diary.signatures.isNotEmpty)
          _signatures(context, diary),
        if (canSign)
          SectionCard(
            title: context.t('mob.dry.sign.title'),
            children: <Widget>[
              Text(context.t('mob.dry.sign.hint')),
              if (diary.awaitingConfirmation)
                Text(
                  context.t('mob.dry.sign.value'),
                  style: theme.textTheme.bodySmall,
                ),
              if (signGate != null) GateNote(text: signGate),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(
                onPressed: signGate == null && !sending ? _sign : null,
                child: Text(
                  sending
                      ? context.t('mob.dry.sign.pending')
                      : context.t('mob.dry.sign.action'),
                ),
              ),
            ],
          ),
        if (diary != null && diary.isSigned && diary.canCorrect)
          _correction(
            context,
            diary,
            offline || widget.fromCopy,
            readOnlySession,
          ),
        if (diary != null && diary.isSigned && !diary.canCorrect)
          GateNote(text: context.t('mob.dry.signed.notice')),
      ],
    );
  }

  Widget _outcomeCard(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.dry.result.done'));
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.dry.result.unknown.title'),
          lines: <String>[context.t('mob.dry.result.unknown.body')],
          actionLabel: context.t('mob.dry.result.unknown.action'),
          onAction: () => (_diary?.isSigned ?? false)
              ? _correct(again: true)
              : _sign(again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.dry.gate.offline'));
      case CommandRefused():
        return OutcomeCard(
          title: refusalText(context, refusalOf(result)),
          code: result.code,
        );
    }
  }

  Widget _form(BuildContext context, DiaryDraft draft, bool readOnlySession) {
    final DiaryRecord? diary = _diary;
    String? error(String field) => _problems[field] == null
        ? null
        : diaryProblemText(context, _problems[field]!);
    final bool busy = _saving;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionCard(
          title: context.t('mob.dry.form.title'),
          children: <Widget>[
            TextField(
              controller: _summary,
              maxLines: 5,
              readOnly: busy,
              decoration: InputDecoration(
                labelText: context.t('mob.dry.form.summary'),
                errorText: error('summary'),
              ),
              onChanged: (String value) => _change(
                draft.copyWith(form: draft.form.copyWith(summary: value)),
              ),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _items,
              maxLines: 4,
              readOnly: busy,
              decoration: InputDecoration(
                labelText: context.t('mob.dry.form.items'),
                helperText: context.t('mob.dry.form.items.hint'),
                errorText: error('workItems'),
              ),
              onChanged: (String value) => _change(
                draft.copyWith(form: draft.form.copyWith(workItems: value)),
              ),
            ),
            const SizedBox(height: MachvonSpace.space12),
            DropdownButtonFormField<String>(
              key: ValueKey<String>('weather-${draft.form.weatherCode}'),
              initialValue: draft.form.weatherCode.isEmpty
                  ? ''
                  : draft.form.weatherCode,
              isExpanded: true,
              decoration: InputDecoration(
                labelText: context.t('mob.dry.form.weather'),
                errorText: error('weather'),
              ),
              items: <DropdownMenuItem<String>>[
                DropdownMenuItem<String>(
                  value: '',
                  child: Text(context.t('mob.dry.form.weather.none')),
                ),
                for (final String code in kWeatherCodes)
                  DropdownMenuItem<String>(
                    value: code,
                    child: Text(weatherText(context, code)),
                  ),
              ],
              onChanged: busy
                  ? null
                  : (String? code) => _change(
                      draft.copyWith(
                        form: draft.form.copyWith(weatherCode: code ?? ''),
                      ),
                    ),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _workforce,
              keyboardType: TextInputType.number,
              readOnly: busy,
              decoration: InputDecoration(
                labelText: context.t('mob.dry.form.workforce'),
                errorText: error('workforce'),
              ),
              onChanged: (String value) => _change(
                draft.copyWith(form: draft.form.copyWith(workforce: value)),
              ),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _notes,
              maxLines: 3,
              readOnly: busy,
              decoration: InputDecoration(
                labelText: context.t('mob.dry.form.notes'),
                errorText: error('notes'),
              ),
              onChanged: (String value) => _change(
                draft.copyWith(form: draft.form.copyWith(notes: value)),
              ),
            ),
          ],
        ),
        SectionCard(
          title: context.t('mob.dry.place.title'),
          children: <Widget>[PlaceConsentField(place: draft.place, enabled: !busy, onChanged: _placeChanged)],
        ),
        SectionCard(
          title: context.t('mob.dry.photos.title'),
          children: <Widget>[
            EvidencePhotosField(
              photos: draft.photos,
              keepPlaceAndTime: draft.place.consent,
              enabled: !busy,
              onChanged: (List<EvidencePhoto> photos) =>
                  _change(draft.copyWith(photos: photos)),
            ),
            const SizedBox(height: MachvonSpace.space8),
            Text(
              context.t('mob.dry.photos.note'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: MachvonSpace.space16,
            vertical: MachvonSpace.space8,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (readOnlySession)
                GateNote(text: context.t('mob.dry.gate.readOnly')),
              FilledButton(
                onPressed: readOnlySession || busy ? null : _save,
                child: Text(
                  busy
                      ? context.t('mob.dry.save.pending')
                      : (diary == null
                            ? context.t('mob.dry.save.action')
                            : context.t('mob.dry.save.revise.action')),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _signedContent(BuildContext context, DiaryRecord diary) {
    final DiaryForm shown = DiaryForm.of(diary);
    return SectionCard(
      title: context.t('mob.dry.signed.title'),
      children: <Widget>[
        Text(shown.summary),
        if (shown.workItems.isNotEmpty)
          FactLine(
            label: context.t('mob.dry.form.items'),
            value: shown.workItems.replaceAll('\n', '; '),
          ),
        if (shown.weatherCode.isNotEmpty)
          FactLine(
            label: context.t('mob.dry.form.weather'),
            value: weatherText(context, shown.weatherCode),
          ),
        if (shown.workforce.isNotEmpty)
          FactLine(
            label: context.t('mob.dry.form.workforce'),
            value: shown.workforce,
          ),
        if (shown.notes.isNotEmpty)
          FactLine(label: context.t('mob.dry.form.notes'), value: shown.notes),
        if (diary.supervisorRemark != null)
          FactLine(
            label: context.t('mob.dry.signed.remark'),
            value: diary.supervisorRemark!,
          ),
        if (diary.isCorrection)
          FactLine(
            label: context.t('mob.dry.signed.correction'),
            value: diary.correctionReason ?? '',
          ),
      ],
    );
  }

  Widget _signatures(BuildContext context, DiaryRecord diary) {
    return SectionCard(
      title: context.t('mob.dry.signatures.title'),
      children: <Widget>[
        for (final DiarySignature signature in diary.signatures)
          MergeSemantics(
            child: Padding(
              padding: const EdgeInsets.symmetric(
                vertical: MachvonSpace.space4,
              ),
              child: Text(
                signature.valid
                    ? context.t('mob.dry.signature.line', <String, Object>{
                        'role': roleText(context, signature.role),
                        'name': signature.signerName,
                        'method': methodText(context, signature.method),
                        'time': formatMoment(signature.signedAt),
                      })
                    : context.t('mob.dry.signature.void', <String, Object>{
                        'role': roleText(context, signature.role),
                        'name': signature.signerName,
                        'method': methodText(context, signature.method),
                        'time': formatMoment(signature.signedAt),
                      }),
              ),
            ),
          ),
      ],
    );
  }

  Widget _correction(
    BuildContext context,
    DiaryRecord diary,
    bool needsNetwork,
    bool readOnlySession,
  ) {
    return SectionCard(
      title: context.t('mob.dry.correct.title'),
      children: <Widget>[
        Text(context.t('mob.dry.correct.hint')),
        const SizedBox(height: MachvonSpace.space8),
        TextField(
          controller: _correctionSummary,
          maxLines: 4,
          readOnly: sending,
          decoration: InputDecoration(
            labelText: context.t('mob.dry.form.summary'),
            errorText: _problems['correction'] == null
                ? null
                : diaryProblemText(context, _problems['correction']!),
          ),
        ),
        const SizedBox(height: MachvonSpace.space12),
        TextField(
          controller: _correctionNotes,
          maxLines: 3,
          readOnly: sending,
          decoration: InputDecoration(
            labelText: context.t('mob.dry.form.notes'),
          ),
        ),
        const SizedBox(height: MachvonSpace.space12),
        TextField(
          controller: _reason,
          maxLines: 2,
          readOnly: sending,
          decoration: InputDecoration(
            labelText: context.t('mob.dry.correct.reason'),
            errorText: _reasonProblem == null
                ? null
                : correctionProblemText(context, _reasonProblem!),
          ),
        ),
        if (needsNetwork) GateNote(text: context.t('mob.dry.gate.offline')),
        if (readOnlySession) GateNote(text: context.t('mob.dry.gate.readOnly')),
        const SizedBox(height: MachvonSpace.space8),
        FilledButton(
          onPressed: needsNetwork || readOnlySession || sending
              ? null
              : _correct,
          child: Text(
            sending
                ? context.t('mob.dry.correct.pending')
                : context.t('mob.dry.correct.action'),
          ),
        ),
      ],
    );
  }
}

/// The save of this diary that is on its way: where it stands, and what the person can do when it is not going through.
class _Pending extends StatelessWidget {
  const _Pending({required this.command});

  final QueuedCommand command;

  @override
  Widget build(BuildContext context) {
    if (command.state == CommandState.accepted ||
        command.state == CommandState.discarded)
      return const SizedBox.shrink();
    final String? reason = reasonOf(context, command);
    return SectionCard(
      title: context.t('mob.dry.pending.title'),
      children: <Widget>[
        Semantics(
          liveRegion: true,
          child: StatusPill(
            label: stateLabel(context, command.state),
            warn:
                command.state == CommandState.rejected ||
                command.state == CommandState.conflict,
          ),
        ),
        if (reason != null)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(reason),
          ),
        if (command.errorCode != null)
          Text(
            command.errorCode!,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        const SizedBox(height: MachvonSpace.space8),
        if (command.state == CommandState.conflict)
          FilledButton(
            onPressed: () => context.push(
              locationOfScreen(context, 'MOB-42', pathSuffix: '/${command.id}'),
            ),
            child: Text(context.t('mob.dry.pending.choose.action')),
          ),
        OutlinedButton(
          onPressed: () => openScreen(context, 'MOB-41', stacked: true),
          child: Text(context.t('mob.dry.pending.queue.action')),
        ),
      ],
    );
  }
}
