import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/state_view.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../command_support/field_contract.dart';
import '../../command_support/field_widgets.dart';
import '../../field_evidence/evidence_photos.dart';
import '../../field_evidence/evidence_photos_field.dart';
import '../../field_evidence/field_place.dart';
import '../../field_evidence/place_consent_field.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../inspection_commands.dart';
import '../inspection_labels.dart';
import '../inspection_models.dart';
import '../inspection_reads.dart';
import '../inspection_service.dart';
import '../waiting_command_row.dart';
import 'inspection_view.dart';

/// MOB-64: the result of a field quality inspection. The checklist the inspection was given is answered item by item (pass, fail,
/// not applicable), the overall result and its words are written, and photographs follow the consent to keep the position. The
/// result is kept on the phone and queued as one command based on the version of the inspection that was read, with a key the phone
/// made, so it is sent when there is a network and recorded once. A failed item raises a non-conformance on the server; a critical
/// one stands in the way of an acceptance, which is asked for online and is refused with `OPEN_CRITICAL_NCR` while it is open.
Widget buildInspectionScreen(BuildContext context, ScreenContext screen) =>
    InspectionScreen(contractId: screen.pathParameters['contractId'] ?? '', requestedInspection: screen.queryParameters['inspection']);

class InspectionScreen extends StatefulWidget {
  const InspectionScreen({required this.contractId, this.requestedInspection, super.key});

  final String contractId;
  final String? requestedInspection;

  @override
  State<InspectionScreen> createState() => _InspectionScreenState();
}

class _InspectionScreenState extends State<InspectionScreen> {
  int _reload = 0;
  String? _chosen;

  @override
  Widget build(BuildContext context) {
    final String id = widget.contractId;
    return AppScaffold(
      title: context.t('mob.chk.title'),
      body: DataView<InspectionContext>(
        cacheKey: 'inspections.$id',
        reloadKey: _reload,
        read: (MachvonApiClient client) => readInspectionContext(client, id),
        parse: parseInspectionContext,
        builder: (BuildContext context, Loaded<InspectionContext> loaded) {
          final InspectionContext data = loaded.value;
          // An empty list is drawn here and not by the read, so the state has the action that may fix it.
          if (data.inspections.isEmpty) return StateView(kind: StateKind.empty, actionLabel: context.t('mob.states.retry.action'), onAction: () => setState(() => _reload += 1));
          final String? wanted = _chosen ?? widget.requestedInspection;
          Inspection? selected;
          for (final Inspection inspection in data.inspections) {
            if (inspection.id == wanted) selected = inspection;
          }
          selected ??= data.inspections.cast<Inspection?>().firstWhere((Inspection? inspection) => inspection!.isOpen, orElse: () => data.inspections.first);
          return _InspectionBody(
            key: ValueKey<String>(selected!.id),
            data: data,
            inspection: selected,
            fromCopy: loaded.fromCache,
            onPick: (String next) => setState(() => _chosen = next),
            onChanged: () => setState(() => _reload += 1),
          );
        },
      ),
    );
  }
}

class _InspectionBody extends ConsumerStatefulWidget {
  const _InspectionBody({required this.data, required this.inspection, required this.fromCopy, required this.onPick, required this.onChanged, super.key});

  final InspectionContext data;
  final Inspection inspection;
  final bool fromCopy;
  final ValueChanged<String> onPick;
  final VoidCallback onChanged;

  @override
  ConsumerState<_InspectionBody> createState() => _InspectionBodyState();
}

class _InspectionBodyState extends ConsumerState<_InspectionBody> with CommandFlow<_InspectionBody> {
  final TextEditingController _note = TextEditingController();
  final TextEditingController _record = TextEditingController();
  final TextEditingController _document = TextEditingController();
  final Map<String, TextEditingController> _itemNotes = <String, TextEditingController>{};
  late final AcceptanceRequests _requests = AcceptanceRequests(client: ref.read(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline);

  ResultDraft? _draft;
  String _draftId = '';
  Map<String, ResultProblem> _problems = const <String, ResultProblem>{};
  Map<String, RequestProblem> _requestProblems = const <String, RequestProblem>{};
  bool _saving = false;

  /// The consent was taken back and the photographs are being rewritten without their place and time: nothing is saved until they are clean.
  bool _sanitizing = false;
  bool _queued = false;
  bool _storeFailed = false;
  String? _photoRefusal;

  /// The result before this one was refused as unverifiable: it may have been recorded, so this one is not sent until the person has
  /// looked at it in the queue.
  bool _unverifiable = false;
  Future<void> _writing = Future<void>.value();

  Inspection get _inspection => widget.inspection;

  @override
  void initState() {
    super.initState();
    // The quick "Report" sheet takes this contract as the one the person works on.
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted) ref.read(lastFieldContractProvider.notifier).remember(widget.data.contract.id);
    });
    unawaited(_open());
  }

  @override
  void dispose() {
    _note.dispose();
    _record.dispose();
    _document.dispose();
    for (final TextEditingController controller in _itemNotes.values) {
      controller.dispose();
    }
    super.dispose();
  }

  InspectionService get _service => ref.read(inspectionServiceProvider);

  Future<void> _open() async {
    StoredResultDraft? stored;
    try {
      stored = await _service.draftFor(widget.data.contract.id, _inspection.id);
    } on Object {
      if (mounted) setState(() => _storeFailed = true);
    }
    if (!mounted) return;
    final ResultDraft draft = stored?.draft ?? ResultDraft(contractId: widget.data.contract.id, inspectionId: _inspection.id, operationId: newUuidV4());
    setState(() {
      _draft = draft;
      _draftId = stored?.id ?? '';
      _note.text = draft.form.resultNote;
      for (final ChecklistItem item in _inspection.checklist) {
        _itemNotes[item.code] = TextEditingController(text: draft.form.answerOf(item.code).note);
      }
    });
  }

  void _change(ResultDraft next) {
    setState(() {
      _draft = next;
      _problems = const <String, ResultProblem>{};
      _queued = false;
    });
    unawaited(_persist());
  }

  /// Writes the draft after every change, one write after the other, so the last change is the one that stays. Gives the id of the
  /// draft on the device once THIS draft is written, and null when the write failed: the id of an earlier write stands for an older
  /// content, and nothing may be queued from that.
  Future<String?> _persist() {
    final ResultDraft? draft = _draft;
    if (draft == null) return Future<String?>.value(_draftId);
    final Future<String?> written = _writing.then((void _) async {
      try {
        _draftId = await _service.save(draft, draftId: _draftId);
        if (mounted && _storeFailed) setState(() => _storeFailed = false);
        return _draftId;
      } on Object {
        if (mounted) setState(() => _storeFailed = true);
        return null;
      }
    });
    _writing = written.then((String? _) {});
    return written;
  }

  /// The place is the one chosen from this moment, written to the phone at once; taking the consent back takes the place and the
  /// time out of the photographs too, and nothing is recorded before they have gone.
  Future<void> _placeChanged(FieldPlace next) async {
    final ResultDraft? draft = _draft;
    if (draft == null) return;
    final bool withdrawn = !next.consent && draft.photos.isNotEmpty;
    if (withdrawn) _sanitizing = true;
    _change(draft.copyWith(place: next));
    if (!withdrawn) return;
    List<EvidencePhoto> clean = draft.photos;
    try {
      clean = await enforcePhotoConsent(draft.photos, consent: false);
    } finally {
      if (mounted) {
        _change(_draft!.copyWith(photos: clean));
        setState(() => _sanitizing = false);
      }
    }
  }

  Future<void> _save() async {
    final ResultDraft? draft = _draft;
    if (draft == null || _saving || _sanitizing) return;
    final Map<String, ResultProblem> problems = checkResult(draft.form, _inspection.checklist);
    setState(() {
      _problems = problems;
      _photoRefusal = null;
      _unverifiable = false;
    });
    if (problems.isNotEmpty) return;
    setState(() => _saving = true);
    try {
      final String? id = await _persist();
      if (id == null || id.isEmpty) return;
      await _service.queueResult(id, _inspection);
      if (mounted) setState(() => _queued = true);
    } on ResultNotReady catch (notReady) {
      if (mounted) setState(() => _problems = notReady.problems);
    } on ResultUnverifiable {
      if (mounted) setState(() => _unverifiable = true);
    } on AttachmentRefused catch (refusal) {
      if (mounted) setState(() => _photoRefusal = refusal.code);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _requestAcceptance({bool again = false}) {
    final Map<String, RequestProblem> problems = checkRequest(recordNo: _record.text, documentVersionId: _document.text);
    setState(() => _requestProblems = problems);
    if (problems.isNotEmpty) return Future<void>.value();
    return run(() => _requests.request(_inspection, recordNo: _record.text, documentVersionId: _document.text, retryAfterUnknown: again), onDone: widget.onChanged);
  }

  /// What is wrong, in words, by field: what the save found, and at once the contradiction between the overall result and the answers once
  /// every item is answered and a result is chosen.
  Map<String, String> _errors(BuildContext context, ResultDraft draft) {
    final Map<String, String> errors = <String, String>{for (final MapEntry<String, ResultProblem> entry in _problems.entries) entry.key: resultProblemText(context, entry.value)};
    final Map<String, ResultProblem> live = checkResult(draft.form, _inspection.checklist);
    final bool answered = _inspection.checklist.isNotEmpty && !live.keys.any((String key) => key.startsWith('answer:') && live[key] == ResultProblem.unanswered);
    if (answered && live['whole'] == ResultProblem.contradiction) errors.putIfAbsent('whole', () => resultProblemText(context, ResultProblem.contradiction));
    return errors;
  }

  @override
  Widget build(BuildContext context) {
    final ResultDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final Inspection inspection = _inspection;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    QueuedCommand? pending;
    for (final QueuedCommand command in ref.watch(queuedCommandsProvider).asData?.value ?? const <QueuedCommand>[]) {
      if (command.commandType == kInspectionResultCommand && command.payload?['inspection_id'] == inspection.id) pending = command;
    }
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (AsyncValue<List<QueuedCommand>>? previous, AsyncValue<List<QueuedCommand>> next) {
      int accepted(AsyncValue<List<QueuedCommand>>? value) => value?.asData?.value.where((QueuedCommand c) => c.commandType == kInspectionResultCommand && c.state == CommandState.accepted).length ?? 0;
      if (accepted(next) > accepted(previous)) widget.onChanged();
    });
    final bool waiting = pending != null && pending.state != CommandState.accepted && pending.state != CommandState.discarded;
    final bool formOpen = inspection.isOpen && !waiting;
    final CommandOutcome? result = outcome;
    final bool needsNetwork = offline || widget.fromCopy;
    final Widget? bar;
    if (formOpen) {
      bar = FieldSendBar(
        label: _saving ? context.t('mob.chk.save.pending') : context.t('mob.chk.save.action'),
        offline: offline,
        onSend: readOnly || _saving || _sanitizing ? null : _save,
        why: readOnly ? context.t('mob.chk.gate.readOnly') : (_sanitizing ? context.t('mob.chk.sanitizing.why') : null),
      );
    } else if (inspection.mayRequestAcceptance) {
      bar = ActionBar(
        primary: ActionBarButton(label: sending ? context.t('mob.chk.accept.pending') : context.t('mob.chk.accept.action'), onPressed: needsNetwork || readOnly || sending ? null : _requestAcceptance),
        why: needsNetwork ? context.t('mob.chk.gate.offline') : (readOnly ? context.t('mob.chk.gate.readOnly') : null),
      );
    } else {
      bar = null;
    }
    return InspectionEntryView(
      contractLabel: widget.data.contract.label,
      inspections: widget.data.inspections,
      inspection: inspection,
      onPick: widget.onPick,
      fromCopy: widget.fromCopy,
      formOpen: formOpen,
      form: draft.form,
      itemNotes: _itemNotes,
      resultNote: _note,
      errors: _errors(context, draft),
      saving: _saving,
      onOutcome: (String code, String outcome) => _change(draft.copyWith(form: draft.form.withAnswer(code, draft.form.answerOf(code).copyWith(outcome: outcome)))),
      onItemNote: (String code, String note) => _change(draft.copyWith(form: draft.form.withAnswer(code, draft.form.answerOf(code).copyWith(note: note)))),
      onResult: (String value) => _change(draft.copyWith(form: draft.form.copyWith(result: value))),
      onResultNote: (String value) => _change(draft.copyWith(form: draft.form.copyWith(resultNote: value))),
      placeField: PlaceConsentField(place: draft.place, enabled: !_saving && !_sanitizing, onChanged: _placeChanged),
      photosField: EvidencePhotosField(
        photos: draft.photos,
        keepPlaceAndTime: draft.place.consent,
        place: draft.place,
        enabled: !_saving && !_sanitizing,
        onChanged: (List<EvidencePhoto> photos) => _change(draft.copyWith(photos: photos)),
      ),
      raised: widget.data.raisedBy(inspection.id),
      notices: <Widget>[
        if (_storeFailed) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.chk.store.notice')),
        if (_queued && offline) SavedForLaterPanel(onOpenQueue: _openQueue),
        if (_queued && !offline) NoticePanel(tone: NoticeTone.ok, title: context.t('mob.chk.saved')),
        if (_unverifiable) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.queue.reason.unverifiable.body')),
        if (_photoRefusal != null) NoticePanel(tone: NoticeTone.problem, title: evidenceRefusalText(context, _photoRefusal!), code: _photoRefusal),
      ],
      waiting: <Widget>[
        if (pending != null && waiting)
          WaitingCommandRow(
            title: '${inspection.inspectionNo} · ${inspection.title}',
            command: pending,
            dividerAbove: false,
            refusalText: (BuildContext context, String code) => inspectionRefusalText(context, inspectionRefusalOf(code)),
            queueActionLabel: context.t('mob.chk.waiting.queue.action'),
            onOpenQueue: _openQueue,
          ),
      ],
      acceptance: inspection.mayRequestAcceptance
          ? AcceptanceFormSection(
              record: _record,
              document: _document,
              errors: <String, String>{for (final MapEntry<String, RequestProblem> entry in _requestProblems.entries) entry.key: requestProblemText(context, entry.value)},
              sending: sending,
            )
          : null,
      outcome: result == null ? null : _outcomeCard(context, result),
      bar: bar,
    );
  }

  void _openQueue() => openScreen(context, 'MOB-41', stacked: true);

  Widget _outcomeCard(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.chk.accept.done'), tone: NoticeTone.ok);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.chk.result.unknown.title'),
          lines: <String>[context.t('mob.chk.result.unknown.body')],
          tone: NoticeTone.warning,
          actionLabel: context.t('mob.chk.result.unknown.action'),
          onAction: () => _requestAcceptance(again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.chk.gate.offline'), tone: NoticeTone.info);
      case CommandRefused():
        return OutcomeCard(title: inspectionRefusalText(context, inspectionRefusalOf(result.code)), code: result.code);
    }
  }
}
