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
import '../quantity_commands.dart';
import '../quantity_labels.dart';
import '../quantity_models.dart';
import '../quantity_reads.dart';
import '../quantity_service.dart';

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
    return ScreenFrame(
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
  bool _queued = false;
  bool _notRecordable = false;
  bool _storeFailed = false;
  String? _photoRefusal;
  Future<void> _writing = Future<void>.value();

  QuantityContext get _data => widget.contextData;

  List<BoqItem> get _items => <BoqItem>[for (final BoqItem item in _data.items) if (item.itemId != null) item];

  @override
  void initState() {
    super.initState();
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
    });
    unawaited(_persist());
  }

  /// Writes the draft after every change, one write after the other, so the last change is the one that stays.
  Future<String> _persist() {
    final QuantityDraft? draft = _draft;
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
    final QuantityDraft? draft = _draft;
    if (draft == null) return;
    final List<EvidencePhoto> photos = await enforcePhotoConsent(draft.photos, consent: next.consent);
    _change(draft.copyWith(place: next, photos: photos));
  }

  Future<void> _record() async {
    final QuantityDraft? draft = _draft;
    if (draft == null || _saving) return;
    setState(() {
      _saving = true;
      _photoRefusal = null;
    });
    try {
      final String id = await _persist();
      if (id.isEmpty) return;
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

  @override
  Widget build(BuildContext context) {
    final QuantityDraft? draft = _draft;
    if (draft == null) return const Center(child: CircularProgressIndicator());
    final ThemeData theme = Theme.of(context);
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final bool offline = isOffline(ref);
    final List<QueuedCommand> waiting = <QueuedCommand>[
      for (final QueuedCommand command in ref.watch(queuedCommandsProvider).asData?.value ?? const <QueuedCommand>[])
        if (command.commandType == kMeasurementRecordCommand && command.payload?['contract_id'] == _data.contract.id) command,
    ];
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (AsyncValue<List<QueuedCommand>>? previous, AsyncValue<List<QueuedCommand>> next) {
      int accepted(AsyncValue<List<QueuedCommand>>? value) => value?.asData?.value.where((QueuedCommand c) => c.commandType == kMeasurementRecordCommand && c.state == CommandState.accepted).length ?? 0;
      if (accepted(next) > accepted(previous)) widget.onChanged();
    });
    final BoqItem? chosen = _items.cast<BoqItem?>().firstWhere((BoqItem? item) => item!.lineId == draft.form.itemLineId, orElse: () => null);
    String? error(String field) => _problems[field] == null ? null : quantityProblemText(context, _problems[field]!);
    final CommandOutcome? result = outcome;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: _data.contract.label,
          children: <Widget>[
            StatusPill(label: _data.contract.status),
            if (widget.fromCopy) Text(context.t('mob.qty.copy.notice')),
          ],
        ),
        if (_storeFailed) GateNote(text: context.t('mob.qty.store.notice')),
        if (_queued) GateNote(text: offline ? context.t('mob.qty.saved.offline') : context.t('mob.qty.saved')),
        if (_notRecordable) GateNote(text: context.t('mob.qty.item.notRecordable')),
        if (_photoRefusal != null) GateNote(text: '${evidenceRefusalText(context, _photoRefusal!)} $_photoRefusal'),
        for (final QueuedCommand command in waiting) if (command.state != CommandState.accepted && command.state != CommandState.discarded) _Waiting(command: command),
        SectionCard(
          title: context.t('mob.qty.form.title'),
          children: <Widget>[
            if (_items.isEmpty) Text(context.t('mob.qty.items.none'))
            else
              DropdownButtonFormField<String>(
                key: ValueKey<String>('item-${draft.form.itemLineId}'),
                initialValue: _items.any((BoqItem item) => item.lineId == draft.form.itemLineId) ? draft.form.itemLineId : null,
                isExpanded: true,
                decoration: InputDecoration(labelText: context.t('mob.qty.form.item'), errorText: error('item')),
                items: <DropdownMenuItem<String>>[for (final BoqItem item in _items) DropdownMenuItem<String>(value: item.lineId, child: Text(item.label, overflow: TextOverflow.ellipsis))],
                onChanged: _saving ? null : (String? id) => _change(draft.copyWith(form: draft.form.copyWith(itemLineId: id ?? ''))),
              ),
            if (chosen != null)
              Padding(
                padding: const EdgeInsets.only(top: MachvonSpace.space4),
                child: Text(context.t('mob.qty.item.left', <String, Object>{'left': quantityLabel(context, _data.remainingOf(chosen)), 'unit': chosen.unitCode}), style: theme.textTheme.bodySmall),
              ),
            const SizedBox(height: MachvonSpace.space12),
            if (_data.periods != null)
              DropdownButtonFormField<String>(
                key: ValueKey<String>('period-${draft.form.periodId}'),
                initialValue: _data.periods!.any((MeasurePeriod period) => period.id == draft.form.periodId) ? draft.form.periodId : null,
                isExpanded: true,
                decoration: InputDecoration(labelText: context.t('mob.qty.form.period'), errorText: error('period')),
                items: <DropdownMenuItem<String>>[for (final MeasurePeriod period in _data.periods!) DropdownMenuItem<String>(value: period.id, child: Text(period.code))],
                onChanged: _saving ? null : (String? id) => _change(draft.copyWith(form: draft.form.copyWith(periodId: id ?? ''))),
              )
            else
              TextField(
                controller: _periodId,
                readOnly: _saving,
                decoration: InputDecoration(labelText: context.t('mob.qty.form.periodId'), helperText: context.t('mob.qty.form.periodId.hint'), errorText: error('period')),
                onChanged: (String value) => _change(draft.copyWith(form: draft.form.copyWith(periodId: value))),
              ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _quantity,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              readOnly: _saving,
              decoration: InputDecoration(
                labelText: chosen == null || chosen.unitCode.isEmpty ? context.t('mob.qty.form.quantity') : context.t('mob.qty.form.quantity.unit', <String, Object>{'unit': chosen.unitCode}),
                helperText: context.t('mob.qty.form.quantity.hint'),
                errorText: error('quantity'),
              ),
              onChanged: (String value) => _change(draft.copyWith(form: draft.form.copyWith(quantity: value))),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _reference,
              readOnly: _saving,
              decoration: InputDecoration(labelText: context.t('mob.qty.form.reference'), errorText: error('reference')),
              onChanged: (String value) => _change(draft.copyWith(form: draft.form.copyWith(referenceNo: value))),
            ),
            const SizedBox(height: MachvonSpace.space12),
            TextField(
              controller: _override,
              readOnly: _saving,
              decoration: InputDecoration(labelText: context.t('mob.qty.form.override'), helperText: context.t('mob.qty.form.override.hint'), errorText: error('override')),
              onChanged: (String value) => _change(draft.copyWith(form: draft.form.copyWith(overrideReason: value))),
            ),
          ],
        ),
        SectionCard(title: context.t('mob.qty.place.title'), children: <Widget>[PlaceConsentField(place: draft.place, enabled: !_saving, onChanged: _placeChanged)]),
        SectionCard(
          title: context.t('mob.qty.photos.title'),
          children: <Widget>[
            EvidencePhotosField(photos: draft.photos, keepPlaceAndTime: draft.place.consent, place: draft.place, enabled: !_saving, onChanged: (List<EvidencePhoto> photos) => _change(draft.copyWith(photos: photos))),
            const SizedBox(height: MachvonSpace.space8),
            Text(context.t('mob.qty.photos.note'), style: theme.textTheme.bodySmall),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (readOnly) GateNote(text: context.t('mob.qty.gate.readOnly')),
              FilledButton(onPressed: readOnly || _saving ? null : _record, child: Text(_saving ? context.t('mob.qty.save.pending') : context.t('mob.qty.save.action'))),
            ],
          ),
        ),
        if (result != null) _outcomeCard(context, result),
        SectionCard(
          title: context.t('mob.qty.recorded.title'),
          children: <Widget>[
            if (_data.measurements.isEmpty) Text(context.t('mob.qty.recorded.none')),
            for (final Measurement measurement in _data.measurements) _MeasurementRow(measurement: measurement, onSubmit: measurement.canSubmit ? () => _submit(measurement) : null, gate: _gate(context, offline, readOnly), busy: sending),
          ],
        ),
      ],
    );
  }

  String? _gate(BuildContext context, bool offline, bool readOnly) {
    if (offline || widget.fromCopy) return context.t('mob.qty.gate.offline');
    if (readOnly) return context.t('mob.qty.gate.readOnly');
    return null;
  }

  Widget _outcomeCard(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.qty.result.done'));
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.qty.result.unknown.title'),
          lines: <String>[context.t('mob.qty.result.unknown.body')],
          actionLabel: context.t('mob.qty.result.unknown.action'),
          onAction: () {
            final String? id = _lastSubmitted;
            for (final Measurement measurement in _data.measurements) {
              if (measurement.id == id) _submit(measurement, again: true);
            }
          },
        );
      case CommandOffline():
        return OutcomeCard(title: context.t('mob.qty.gate.offline'));
      case CommandRefused():
        return OutcomeCard(title: quantityRefusalText(context, refusalOfCode(result.code, reason: result.extensions['reason'])), code: result.code);
    }
  }

  String? _lastSubmitted;
}

class _MeasurementRow extends StatelessWidget {
  const _MeasurementRow({required this.measurement, required this.onSubmit, required this.gate, required this.busy});

  final Measurement measurement;
  final VoidCallback? onSubmit;
  final String? gate;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          MergeSemantics(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  context.t('mob.qty.recorded.line', <String, Object>{'item': measurement.itemKey, 'quantity': quantityLabel(context, measurement.quantityPeriod), 'unit': measurement.unitCode, 'period': measurement.periodCode}),
                  style: theme.textTheme.titleSmall,
                ),
                StatusPill(label: measurementStatusText(context, measurement.status)),
                Text(context.t('mob.qty.recorded.evidence', <String, Object>{'count': measurement.evidenceCount}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          if (onSubmit != null) ...<Widget>[
            if (gate != null) GateNote(text: gate!),
            OutlinedButton(onPressed: gate == null && !busy ? onSubmit : null, child: Text(context.t('mob.qty.submit.action'))),
          ],
        ],
      ),
    );
  }
}

/// A quantity of this phone that is on its way: where it stands, and why when it was refused.
class _Waiting extends StatelessWidget {
  const _Waiting({required this.command});

  final QueuedCommand command;

  @override
  Widget build(BuildContext context) {
    final String? code = command.errorCode;
    final String? reason = command.state == CommandState.rejected && code != null ? quantityRefusalText(context, refusalOfCode(code)) : reasonOf(context, command);
    return SectionCard(
      title: context.t('mob.qty.waiting.title'),
      children: <Widget>[
        Text('${command.payload?['reference_no'] ?? ''} · ${command.payload?['quantity_period'] ?? ''}'),
        Semantics(liveRegion: true, child: StatusPill(label: stateLabel(context, command.state), warn: command.state == CommandState.rejected || command.state == CommandState.conflict)),
        if (reason != null) Padding(padding: const EdgeInsets.only(top: MachvonSpace.space8), child: Text(reason)),
        if (code != null) Text(code, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: MachvonSpace.space8),
        OutlinedButton(onPressed: () => openScreen(context, 'MOB-41', stacked: true), child: Text(context.t('mob.qty.waiting.queue.action'))),
      ],
    );
  }
}
