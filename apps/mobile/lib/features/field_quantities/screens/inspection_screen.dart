import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../field_evidence/evidence_photos.dart';
import '../../field_evidence/evidence_photos_field.dart';
import '../../field_evidence/field_place.dart';
import '../../field_evidence/place_consent_field.dart';
import '../../offline/offline_labels.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/offline.dart';
import '../../read_support/widgets.dart';
import '../inspection_commands.dart';
import '../inspection_labels.dart';
import '../inspection_models.dart';
import '../inspection_reads.dart';
import '../inspection_service.dart';

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
    return ScreenFrame(
      title: context.t('mob.chk.title'),
      body: DataView<InspectionContext>(
        cacheKey: 'inspections.$id',
        reloadKey: _reload,
        read: (MachvonApiClient client) => readInspectionContext(client, id),
        parse: parseInspectionContext,
        isEmpty: (InspectionContext data) => data.inspections.isEmpty,
        builder: (BuildContext context, Loaded<InspectionContext> loaded) {
          final InspectionContext data = loaded.value;
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
  bool _queued = false;
  bool _storeFailed = false;
  String? _photoRefusal;
  Future<void> _writing = Future<void>.value();

  Inspection get _inspection => widget.inspection;

  @override
  void initState() {
    super.initState();
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

  Future<String> _persist() {
    final ResultDraft? draft = _draft;
    if (draft == null) return Future<String>.value(_draftId);
    final Future<String> written = _writing.then((void _) async {
      try {
        _draftId = await _service.save(draft, draftId: _draftId);
        if (mounted && _storeFailed) setState(() => _storeFailed = false);
      } on Object {
        if (mounted) setState(() => _storeFailed = true);
      }
      return _draftId;
    });
    _writing = written.then((String _) {});
    return written;
  }

  Future<void> _placeChanged(FieldPlace next) async {
    final ResultDraft? draft = _draft;
    if (draft == null) return;
    final List<EvidencePhoto> photos = await enforcePhotoConsent(draft.photos, consent: next.consent);
    _change(draft.copyWith(place: next, photos: photos));
  }

  Future<void> _save() async {
    final ResultDraft? draft = _draft;
    if (draft == null || _saving) return;
    final Map<String, ResultProblem> problems = checkResult(draft.form, _inspection.checklist);
    setState(() {
      _problems = problems;
      _photoRefusal = null;
    });
    if (problems.isNotEmpty) return;
    setState(() => _saving = true);
    try {
      final String id = await _persist();
      if (id.isEmpty) return;
      await _service.queueResult(id, _inspection);
      if (mounted) setState(() => _queued = true);
    } on ResultNotReady catch (notReady) {
      if (mounted) setState(() => _problems = notReady.problems);
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

  String? _problemText(BuildContext context, String key) => _problems[key] == null ? null : resultProblemText(context, _problems[key]!);

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
    final CommandOutcome? result = outcome;
    final List<Nonconformance> raised = widget.data.raisedBy(inspection.id);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: widget.data.contract.label,
          children: <Widget>[
            DropdownButtonFormField<String>(
              key: ValueKey<String>('inspection-${inspection.id}'),
              initialValue: inspection.id,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.chk.pick')),
              items: <DropdownMenuItem<String>>[
                for (final Inspection other in widget.data.inspections) DropdownMenuItem<String>(value: other.id, child: Text('${other.inspectionNo} · ${other.title}', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (String? id) {
                if (id != null) widget.onPick(id);
              },
            ),
            const SizedBox(height: MachvonSpace.space8),
            StatusPill(label: inspectionStatusText(context, inspection.status)),
            if (inspection.locationText != null) FactLine(label: context.t('mob.chk.location'), value: inspection.locationText!),
            if (widget.fromCopy) Text(context.t('mob.chk.copy.notice')),
          ],
        ),
        if (_storeFailed) GateNote(text: context.t('mob.chk.store.notice')),
        if (_queued) GateNote(text: offline ? context.t('mob.chk.saved.offline') : context.t('mob.chk.saved')),
        if (_photoRefusal != null) GateNote(text: '${evidenceRefusalText(context, _photoRefusal!)} $_photoRefusal'),
        if (pending != null && waiting) _Waiting(command: pending),
        if (inspection.isOpen && !waiting) ..._form(context, draft, readOnly) else if (!inspection.isOpen) _recorded(context, inspection),
        if (raised.isNotEmpty) _nonconformances(context, raised),
        if (inspection.mayRequestAcceptance) _acceptance(context, offline || widget.fromCopy, readOnly),
        if (result != null) _outcomeCard(context, result),
      ],
    );
  }

  List<Widget> _form(BuildContext context, ResultDraft draft, bool readOnly) {
    return <Widget>[
      SectionCard(
        title: context.t('mob.chk.checklist.title'),
        children: <Widget>[
          for (final ChecklistItem item in _inspection.checklist)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Semantics(header: true, child: Text(item.label, style: Theme.of(context).textTheme.titleSmall)),
                  Wrap(
                    spacing: MachvonSpace.space8,
                    children: <Widget>[
                      for (final String outcome in kOutcomes)
                        ChoiceChip(
                          label: Text(outcomeText(context, outcome)),
                          selected: draft.form.answerOf(item.code).outcome == outcome,
                          onSelected: _saving ? null : (bool _) => _change(draft.copyWith(form: draft.form.withAnswer(item.code, draft.form.answerOf(item.code).copyWith(outcome: outcome)))),
                        ),
                    ],
                  ),
                  if (_problems['answer:${item.code}'] != null) Text(resultProblemText(context, _problems['answer:${item.code}']!), style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  TextField(
                    controller: _itemNotes[item.code],
                    readOnly: _saving,
                    decoration: InputDecoration(labelText: context.t('mob.chk.item.note', <String, Object>{'item': item.label})),
                    onChanged: (String value) => _change(draft.copyWith(form: draft.form.withAnswer(item.code, draft.form.answerOf(item.code).copyWith(note: value)))),
                  ),
                ],
              ),
            ),
        ],
      ),
      SectionCard(
        title: context.t('mob.chk.result.title'),
        children: <Widget>[
          Wrap(
            spacing: MachvonSpace.space8,
            children: <Widget>[
              for (final String result in kResults)
                ChoiceChip(
                  label: Text(resultText(context, result)),
                  selected: draft.form.result == result,
                  onSelected: _saving ? null : (bool _) => _change(draft.copyWith(form: draft.form.copyWith(result: result))),
                ),
            ],
          ),
          if (_problemText(context, 'result') != null) Text(_problemText(context, 'result')!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (_problemText(context, 'whole') != null) Semantics(liveRegion: true, child: Text(_problemText(context, 'whole')!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          const SizedBox(height: MachvonSpace.space8),
          TextField(
            controller: _note,
            maxLines: 3,
            readOnly: _saving,
            decoration: InputDecoration(labelText: context.t('mob.chk.result.note'), errorText: _problemText(context, 'resultNote')),
            onChanged: (String value) => _change(draft.copyWith(form: draft.form.copyWith(resultNote: value))),
          ),
        ],
      ),
      SectionCard(title: context.t('mob.chk.place.title'), children: <Widget>[PlaceConsentField(place: draft.place, enabled: !_saving, onChanged: _placeChanged)]),
      SectionCard(
        title: context.t('mob.chk.photos.title'),
        children: <Widget>[
          EvidencePhotosField(photos: draft.photos, keepPlaceAndTime: draft.place.consent, place: draft.place, enabled: !_saving, onChanged: (List<EvidencePhoto> photos) => _change(draft.copyWith(photos: photos))),
          const SizedBox(height: MachvonSpace.space8),
          Text(context.t('mob.chk.photos.note'), style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (readOnly) GateNote(text: context.t('mob.chk.gate.readOnly')),
            FilledButton(onPressed: readOnly || _saving ? null : _save, child: Text(_saving ? context.t('mob.chk.save.pending') : context.t('mob.chk.save.action'))),
          ],
        ),
      ),
    ];
  }

  Widget _recorded(BuildContext context, Inspection inspection) {
    return SectionCard(
      title: context.t('mob.chk.recorded.title'),
      children: <Widget>[
        if (inspection.result != null) FactLine(label: context.t('mob.chk.result.title'), value: resultText(context, inspection.result!)),
        if (inspection.status != 'RESULT_RECORDED') Text(context.t('mob.chk.recorded.notOpen')),
      ],
    );
  }

  Widget _nonconformances(BuildContext context, List<Nonconformance> raised) {
    return SectionCard(
      title: context.t('mob.chk.ncr.title'),
      children: <Widget>[
        for (final Nonconformance ncr in raised)
          MergeSemantics(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.chk.ncr.line', <String, Object>{'no': ncr.ncrNo, 'title': ncr.title}), style: Theme.of(context).textTheme.titleSmall),
                  Wrap(
                    spacing: MachvonSpace.space8,
                    children: <Widget>[
                      StatusPill(label: severityOfNcrText(context, ncr.severity), warn: ncr.severity == 'CRITICAL'),
                      if (ncr.blocksAcceptance && ncr.isOpen) StatusPill(label: context.t('mob.chk.ncr.blocks'), warn: true),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _acceptance(BuildContext context, bool needsNetwork, bool readOnly) {
    String? error(String key) => _requestProblems[key] == null ? null : requestProblemText(context, _requestProblems[key]!);
    return SectionCard(
      title: context.t('mob.chk.accept.title'),
      children: <Widget>[
        Text(context.t('mob.chk.accept.hint')),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _record, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.chk.accept.record'), errorText: error('record'))),
        const SizedBox(height: MachvonSpace.space12),
        TextField(controller: _document, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.chk.accept.document'), helperText: context.t('mob.chk.accept.document.hint'), errorText: error('document'))),
        if (needsNetwork) GateNote(text: context.t('mob.chk.gate.offline')),
        if (readOnly) GateNote(text: context.t('mob.chk.gate.readOnly')),
        const SizedBox(height: MachvonSpace.space8),
        FilledButton(onPressed: needsNetwork || readOnly || sending ? null : _requestAcceptance, child: Text(sending ? context.t('mob.chk.accept.pending') : context.t('mob.chk.accept.action'))),
      ],
    );
  }

  Widget _outcomeCard(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.chk.accept.done'));
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.chk.result.unknown.title'),
          lines: <String>[context.t('mob.chk.result.unknown.body')],
          actionLabel: context.t('mob.chk.result.unknown.action'),
          onAction: () => _requestAcceptance(again: true),
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.chk.gate.offline'));
      case CommandRefused():
        return OutcomeCard(title: inspectionRefusalText(context, inspectionRefusalOf(result.code)), code: result.code);
    }
  }
}

/// The result of this inspection that is on its way: where it stands, and why when it was refused.
class _Waiting extends StatelessWidget {
  const _Waiting({required this.command});

  final QueuedCommand command;

  @override
  Widget build(BuildContext context) {
    final String? code = command.errorCode;
    final String? reason = command.state == CommandState.rejected && code != null ? inspectionRefusalText(context, inspectionRefusalOf(code)) : reasonOf(context, command);
    return SectionCard(
      title: context.t('mob.chk.waiting.title'),
      children: <Widget>[
        Semantics(liveRegion: true, child: StatusPill(label: stateLabel(context, command.state), warn: command.state == CommandState.rejected || command.state == CommandState.conflict)),
        if (reason != null) Padding(padding: const EdgeInsets.only(top: MachvonSpace.space8), child: Text(reason)),
        if (code != null) Text(code, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: MachvonSpace.space8),
        OutlinedButton(onPressed: () => openScreen(context, 'MOB-41', stacked: true), child: Text(context.t('mob.chk.waiting.queue.action'))),
      ],
    );
  }
}
