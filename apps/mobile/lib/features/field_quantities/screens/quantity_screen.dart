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
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/notice_panel.dart';
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
import '../quantity_commands.dart';
import '../quantity_labels.dart';
import '../quantity_models.dart';
import '../quantity_reads.dart';
import '../quantity_service.dart';
import '../waiting_command_row.dart';
import 'quantity_view.dart';

/// MOB-63: a quantity measured on site, recorded with its evidence. The item is one line of the bill of quantities of the revision in
/// force, the quantity is exact decimal text, and the record is kept on the phone as a draft and queued as one command with a key the
/// phone made, so it is sent when there is a network and sent again after a lost answer without making a second measurement
/// (UAT-AC358). The photographs follow the consent to keep the position: without it they leave the phone without their place and
/// time and are registered with `gps_source` NONE and `geo_consent` false, a flag for the reviewer and not a refusal (UAT-AC367).
/// Sending a recorded quantity for approval is made online.
Widget buildQuantityScreen(BuildContext context, ScreenContext screen) => QuantityScreen(contractId: screen.pathParameters['contractId'] ?? '');

class QuantityScreen extends StatefulWidget {
  const QuantityScreen({required this.contractId, super.key});

  final String contractId;

  @override
  State<QuantityScreen> createState() => _QuantityScreenState();
}

class _QuantityScreenState extends State<QuantityScreen> {
  int _reload = 0;

  @override
  Widget build(BuildContext context) {
    final String id = widget.contractId;
    return AppScaffold(
      title: context.t('mob.qty.title'),
      body: DataView<QuantityContext>(
        cacheKey: 'quantities.$id',
        reloadKey: _reload,
        read: (MachvonApiClient client) => readQuantityContext(client, id),
        parse: parseQuantityContext,
        builder: (BuildContext context, Loaded<QuantityContext> loaded) =>
            _QuantityBody(contextData: loaded.value, fromCopy: loaded.fromCache, onChanged: () => setState(() => _reload += 1)),
      ),
    );
  }
}

class _QuantityBody extends ConsumerStatefulWidget {
  const _QuantityBody({required this.contextData, required this.fromCopy, required this.onChanged});

  final QuantityContext contextData;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<_QuantityBody> createState() => _QuantityBodyState();
}

class _QuantityBodyState extends ConsumerState<_QuantityBody> with CommandFlow<_QuantityBody> {
  final TextEditingController _quantity = TextEditingController();
  final TextEditingController _reference = TextEditingController();
  final TextEditingController _override = TextEditingController();
  final TextEditingController _periodId = TextEditingController();
  late final QuantityCommands _commands = QuantityCommands(client: ref.read(apiClientProvider), isOnline: () => ref.read(reachabilityProvider) != Reachability.offline);

  QuantityDraft? _draft;
  String _draftId = '';
  Map<String, QuantityProblem> _problems = const <String, QuantityProblem>{};
  bool _saving = false;

  /// The consent was taken back and the photographs are being rewritten without their place and time: nothing is recorded until they are clean.
  bool _sanitizing = false;
  bool _queued = false;
  bool _notRecordable = false;

  /// The measurement before this one was refused as unverifiable: it may have been recorded, so this one is not sent until the person
  /// has looked at it in the queue.
  bool _unverifiable = false;
  bool _storeFailed = false;
  String? _photoRefusal;
  Future<void> _writing = Future<void>.value();

  QuantityContext get _data => widget.contextData;

  List<BoqItem> get _items => <BoqItem>[for (final BoqItem item in _data.items) if (item.itemId != null) item];

  @override
  void initState() {
    super.initState();
    // The quick "Report" sheet takes this contract as the one the person works on.
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted) ref.read(lastFieldContractProvider.notifier).remember(_data.contract.id);
    });
    unawaited(_open());
  }

  @override
  void dispose() {
    for (final TextEditingController controller in <TextEditingController>[_quantity, _reference, _override, _periodId]) {
      controller.dispose();
    }
    super.dispose();
  }

  QuantityService get _service => ref.read(quantityServiceProvider);

  Future<void> _open() async {
    StoredQuantityDraft? stored;
    try {
      stored = await _service.draftFor(_data.contract.id);
    } on Object {
      if (mounted) setState(() => _storeFailed = true);
    }
    if (!mounted) return;
    final QuantityDraft draft = stored?.draft ?? QuantityDraft(contractId: _data.contract.id, operationId: newUuidV4());
    setState(() {
      _draft = draft;
      _draftId = stored?.id ?? '';
      _quantity.text = draft.form.quantity;
      _reference.text = draft.form.referenceNo;
      _override.text = draft.form.overrideReason;
      _periodId.text = draft.form.periodId;
    });
  }

  void _change(QuantityDraft next) {
    setState(() {
      _draft = next;
      _problems = const <String, QuantityProblem>{};
      _queued = false;
      _notRecordable = false;
      _unverifiable = false;
    });
    unawaited(_persist());
  }

  /// Writes the draft after every change, one write after the other, so the last change is the one that stays. Gives the id of the
  /// draft on the device once THIS draft is written, and null when the write failed: the id of an earlier write stands for an older
  /// content, and nothing may be queued from that.
  Future<String?> _persist() {
    final QuantityDraft? draft = _draft;
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
    final QuantityDraft? draft = _draft;
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

  Future<void> _record() async {
    final QuantityDraft? draft = _draft;
    if (draft == null || _saving || _sanitizing) return;
    setState(() {
      _saving = true;
      _photoRefusal = null;
      _unverifiable = false;
    });
    try {
      final String? id = await _persist();
      if (id == null || id.isEmpty) return;
      BoqItem? item;
      for (final BoqItem candidate in _items) {
        if (candidate.lineId == draft.form.itemLineId) item = candidate;
      }
      await _service.queueRecord(id, item: item, periodsKnown: _data.periods != null);
      if (!mounted) return;
      // The record is the queue's now: the next quantity starts on an empty form.
      setState(() {
        _queued = true;
        _draft = QuantityDraft(contractId: draft.contractId, operationId: newUuidV4(), place: draft.place.consent ? FieldPlace.none.withConsent(true) : FieldPlace.none);
        _draftId = '';
        _quantity.clear();
        _reference.clear();
        _override.clear();
        _periodId.clear();
      });
    } on QuantityNotReady catch (notReady) {
      if (mounted) {
        setState(() {
          _problems = notReady.problems;
          _notRecordable = notReady.itemNotRecordable;
        });
      }
    } on ResultUnverifiable {
      if (mounted) setState(() => _unverifiable = true);
    } on AttachmentRefused catch (refusal) {
      if (mounted) setState(() => _photoRefusal = refusal.code);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _submit(Measurement measurement, {bool again = false}) {
    _lastSubmitted = measurement.id;
    return run(() => _commands.submit(measurement, retryAfterUnknown: again), onDone: widget.onChanged);
  }

  /// What is wrong, in words, by field: what the save found, and at once what is already known of the quantity typed (a text that is not
  /// a number, a zero), except while the person is still typing a decimal point.
  Map<String, String> _errors(BuildContext context, QuantityDraft draft) {
    final Map<String, String> errors = <String, String>{for (final MapEntry<String, QuantityProblem> entry in _problems.entries) entry.key: quantityProblemText(context, entry.value)};
    final QuantityProblem? typed = checkQuantity(draft.form, periodsKnown: _data.periods != null)['quantity'];
    final String text = draft.form.quantity.trim();
    if (typed != null && text.isNotEmpty && !text.endsWith('.')) errors.putIfAbsent('quantity', () => quantityProblemText(context, typed));
    return errors;
  }

  @override
  Widget build(BuildContext context) {
    final QuantityDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final List<QueuedCommand> waiting = <QueuedCommand>[
      for (final QueuedCommand command in ref.watch(queuedCommandsProvider).asData?.value ?? const <QueuedCommand>[])
        if (command.commandType == kMeasurementRecordCommand &&
            command.payload?['contract_id'] == _data.contract.id &&
            command.state != CommandState.accepted &&
            command.state != CommandState.discarded)
          command,
    ];
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (AsyncValue<List<QueuedCommand>>? previous, AsyncValue<List<QueuedCommand>> next) {
      int accepted(AsyncValue<List<QueuedCommand>>? value) => value?.asData?.value.where((QueuedCommand c) => c.commandType == kMeasurementRecordCommand && c.state == CommandState.accepted).length ?? 0;
      if (accepted(next) > accepted(previous)) widget.onChanged();
    });
    final BoqItem? chosen = _items.cast<BoqItem?>().firstWhere((BoqItem? item) => item!.lineId == draft.form.itemLineId, orElse: () => null);
    final Map<String, String> errors = _errors(context, draft);
    final bool typedIsNumber = draft.form.quantity.trim().isNotEmpty && checkQuantity(draft.form, periodsKnown: _data.periods != null)['quantity'] == null;
    final CommandOutcome? result = outcome;
    final String? why = _gate(context, offline, readOnly);
    return QuantityEntryView(
      contractLabel: _data.contract.label,
      contractStatus: _data.contract.status,
      fromCopy: widget.fromCopy,
      items: _items,
      periods: _data.periods,
      form: draft.form,
      fields: QuantityFields(quantity: _quantity, reference: _reference, override: _override, periodId: _periodId),
      errors: errors,
      saving: _saving,
      onItem: (String id) => _change(draft.copyWith(form: draft.form.copyWith(itemLineId: id))),
      onPeriod: (String id) => _change(draft.copyWith(form: draft.form.copyWith(periodId: id))),
      onPeriodText: (String value) => _change(draft.copyWith(form: draft.form.copyWith(periodId: value))),
      onQuantity: (String value) => _change(draft.copyWith(form: draft.form.copyWith(quantity: value))),
      onReference: (String value) => _change(draft.copyWith(form: draft.form.copyWith(referenceNo: value))),
      onOverride: (String value) => _change(draft.copyWith(form: draft.form.copyWith(overrideReason: value))),
      remaining: chosen == null ? null : quantityLabel(context, _data.remainingOf(chosen)),
      unit: chosen?.unitCode,
      echo: typedIsNumber ? quantityLabel(context, draft.form.quantity.trim()) : null,
      notices: <Widget>[
        if (_storeFailed) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.qty.store.notice')),
        if (_queued && offline) SavedForLaterPanel(onOpenQueue: _openQueue),
        if (_queued && !offline) NoticePanel(tone: NoticeTone.ok, title: context.t('mob.qty.saved')),
        if (_notRecordable) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.qty.item.notRecordable')),
        if (_unverifiable) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.queue.reason.unverifiable.body')),
        if (_photoRefusal != null) NoticePanel(tone: NoticeTone.problem, title: evidenceRefusalText(context, _photoRefusal!), code: _photoRefusal),
      ],
      waiting: <Widget>[
        for (int index = 0; index < waiting.length; index += 1)
          WaitingCommandRow(
            title: _waitingTitle(context, waiting[index]),
            command: waiting[index],
            dividerAbove: index > 0,
            refusalText: (BuildContext context, String code) => quantityRefusalText(context, refusalOfCode(code)),
            queueActionLabel: context.t('mob.qty.waiting.queue.action'),
            onOpenQueue: _openQueue,
          ),
      ],
      placeField: PlaceConsentField(place: draft.place, enabled: !_saving && !_sanitizing, onChanged: _placeChanged),
      photosField: EvidencePhotosField(
        photos: draft.photos,
        keepPlaceAndTime: draft.place.consent,
        place: draft.place,
        enabled: !_saving && !_sanitizing,
        onChanged: (List<EvidencePhoto> photos) => _change(draft.copyWith(photos: photos)),
      ),
      measurements: _data.measurements,
      submitWhy: why,
      busy: sending,
      onSubmit: _submit,
      onReload: widget.onChanged,
      outcome: result == null ? null : _outcomeCard(context, result),
      bar: FieldSendBar(
        label: _saving ? context.t('mob.qty.save.pending') : context.t('mob.qty.save.action'),
        offline: offline,
        onSend: readOnly || _saving || _sanitizing ? null : _record,
        why: readOnly ? context.t('mob.qty.gate.readOnly') : (_sanitizing ? context.t('mob.qty.sanitizing.why') : null),
      ),
    );
  }

  void _openQueue() => openScreen(context, 'MOB-41', stacked: true);

  String _waitingTitle(BuildContext context, QueuedCommand command) {
    final Object? quantity = command.payload?['quantity_period'];
    return <String>[
      '${command.payload?['reference_no'] ?? ''}',
      if (quantity is String) quantityLabel(context, quantity),
    ].where((String part) => part.isNotEmpty).join(' · ');
  }

  String? _gate(BuildContext context, bool offline, bool readOnly) {
    if (offline || widget.fromCopy) return context.t('mob.qty.gate.offline');
    if (readOnly) return context.t('mob.qty.gate.readOnly');
    return null;
  }

  Widget _outcomeCard(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.qty.result.done'), tone: NoticeTone.ok);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.qty.result.unknown.title'),
          lines: <String>[context.t('mob.qty.result.unknown.body')],
          tone: NoticeTone.warning,
          actionLabel: context.t('mob.qty.result.unknown.action'),
          onAction: () {
            final String? id = _lastSubmitted;
            for (final Measurement measurement in _data.measurements) {
              if (measurement.id == id) _submit(measurement, again: true);
            }
          },
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.qty.gate.offline'), tone: NoticeTone.info);
      case CommandRefused():
        return OutcomeCard(title: quantityRefusalText(context, refusalOfCode(result.code, reason: result.extensions['reason'])), code: result.code);
    }
  }

  String? _lastSubmitted;
}
