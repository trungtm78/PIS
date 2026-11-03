import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/attachments/attachment_uploader.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/session/session.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../read_support/amounts.dart';
import '../../read_support/clock.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../clearance_commands.dart';
import '../clearance_models.dart';
import '../clearance_support.dart';
import '../inventory_drafts.dart';
import '../inventory_rules.dart';

/// The body of the task of one household: who it is (by code), the parcels, the inventory counted and its answer, the record being
/// typed and the ones kept on the phone, the photos of the site and the appointments.
class HouseholdTaskBody extends ConsumerStatefulWidget {
  const HouseholdTaskBody({required this.task, required this.fromCopy, required this.onChanged, super.key});

  final HouseholdTask task;
  final bool fromCopy;
  final VoidCallback onChanged;

  @override
  ConsumerState<HouseholdTaskBody> createState() => _HouseholdTaskBodyState();
}

class _HouseholdTaskBodyState extends ConsumerState<HouseholdTaskBody> with CommandFlow<HouseholdTaskBody> {
  late final ClearanceCommands _commands = ClearanceCommands(client: ref.read(apiClientProvider), isOnline: () => deviceIsOnline(ref));
  final TextEditingController _description = TextEditingController();
  final TextEditingController _quantity = TextEditingController();
  final TextEditingController _unit = TextEditingController();
  final TextEditingController _price = TextEditingController();
  final TextEditingController _reference = TextEditingController();
  final TextEditingController _day = TextEditingController();
  final TextEditingController _answerDay = TextEditingController();
  final TextEditingController _answerNote = TextEditingController();

  String? _parcelId;
  String? _itemKind;
  String? _editing;
  Map<String, InventoryProblem> _problems = const <String, InventoryProblem>{};
  List<InventoryDraft> _drafts = const <InventoryDraft>[];
  bool _storeUnavailable = false;

  String? _answering;
  String? _outcomeChoice;
  Map<String, AnswerProblem> _answerProblems = const <String, AnswerProblem>{};

  Object? _last;
  String? _photoRefusal;

  Household get _household => widget.task.household;

  @override
  void initState() {
    super.initState();
    _day.text = vietnamDayOf(ref.read(clockProvider)());
    _parcelId = _household.parcels.length == 1 ? _household.parcels.first.parcelId : null;
    _loadDrafts();
  }

  @override
  void dispose() {
    for (final TextEditingController controller in <TextEditingController>[_description, _quantity, _unit, _price, _reference, _day, _answerDay, _answerNote]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<InventoryDrafts?> _store() async {
    try {
      return InventoryDrafts(await ref.read(draftStoreProvider.future));
    } on Object {
      if (mounted) setState(() => _storeUnavailable = true);
      return null;
    }
  }

  Future<void> _loadDrafts() async {
    final InventoryDrafts? drafts = await _store();
    if (drafts != null && mounted) setState(() => _drafts = drafts.of(_household.id));
  }

  InventoryForm get _form => InventoryForm(
        parcelId: _parcelId,
        itemKind: _itemKind,
        description: _description.text,
        quantity: _quantity.text,
        unitCode: _unit.text,
        unitPriceVnd: _price.text,
        priceDecisionRef: _reference.text,
        surveyedOn: _day.text,
      );

  void _clearForm() {
    for (final TextEditingController controller in <TextEditingController>[_description, _quantity, _unit, _price, _reference]) {
      controller.clear();
    }
    _itemKind = null;
    _editing = null;
    _problems = const <String, InventoryProblem>{};
  }

  /// Keeps what was typed on the phone. Nothing is sent: a record kept is safe from a lost network and from a killed application.
  Future<InventoryDraft?> _keep() async {
    final Map<String, InventoryProblem> problems = checkInventory(_form);
    setState(() => _problems = problems);
    if (problems.isNotEmpty) return null;
    final InventoryDrafts? drafts = await _store();
    if (drafts == null || !mounted) return null;
    final HouseholdParcel parcel = _household.parcels.firstWhere((HouseholdParcel p) => p.parcelId == _parcelId);
    final InventoryDraft kept = drafts.save(id: _editing, householdId: _household.id, householdCode: _household.code, parcelId: parcel.parcelId, parcelCode: parcel.parcelCode, form: _form);
    setState(() {
      _clearForm();
      _drafts = drafts.of(_household.id);
    });
    return kept;
  }

  Future<void> _send(InventoryDraft draft, {bool again = false}) async {
    _last = draft;
    await run(
      () => _commands.record(draft, retryAfterUnknown: again),
      onDone: () async {
        final InventoryDrafts? drafts = await _store();
        drafts?.remove(draft.id);
        if (mounted && drafts != null) setState(() => _drafts = drafts.of(_household.id));
        widget.onChanged();
      },
    );
    final CommandOutcome? result = outcome;
    if (result is CommandRefused && result.isFinal) {
      // The server refused for good: the draft is kept with the code, and sending it again after it is corrected is a new command.
      final InventoryDrafts? drafts = await _store();
      drafts?.refused(draft, result.code);
      if (mounted && drafts != null) setState(() => _drafts = drafts.of(_household.id));
    }
  }

  Future<void> _keepAndSend() async {
    final InventoryDraft? kept = await _keep();
    if (kept != null && mounted) await _send(kept);
  }

  void _edit(InventoryDraft draft) {
    setState(() {
      _editing = draft.id;
      _parcelId = draft.parcelId;
      _itemKind = draft.form.itemKind;
      _description.text = draft.form.description;
      _quantity.text = draft.form.quantity;
      _unit.text = draft.form.unitCode;
      _price.text = draft.form.unitPriceVnd;
      _reference.text = draft.form.priceDecisionRef;
      _day.text = draft.form.surveyedOn;
      _problems = const <String, InventoryProblem>{};
    });
  }

  Future<void> _discard(InventoryDraft draft) async {
    final InventoryDrafts? drafts = await _store();
    drafts?.remove(draft.id);
    if (mounted && drafts != null) setState(() => _drafts = drafts.of(_household.id));
  }

  void _answer(InventoryRecord record) {
    final Map<String, AnswerProblem> problems = checkAnswer(outcome: _outcomeChoice, answeredOn: _answerDay.text, note: _answerNote.text, surveyedOn: record.surveyedOn);
    setState(() => _answerProblems = problems);
    if (problems.isNotEmpty) return;
    final AnswerRequest request = AnswerRequest(recordId: record.id, version: record.version, outcome: _outcomeChoice!, answeredOn: _answerDay.text, note: _answerNote.text);
    _last = request;
    run(
      () => _commands.answer(request),
      onDone: () {
        setState(() {
          _answering = null;
          _outcomeChoice = null;
          _answerNote.clear();
          _answerDay.clear();
        });
        widget.onChanged();
      },
    );
  }

  Future<void> _addPhotos() async {
    final AttachmentPicker? picker = ref.read(attachmentPickerProvider);
    if (picker == null) return;
    final AttachmentUploader uploader = await ref.read(attachmentUploaderProvider.future);
    String? refusal;
    for (final File file in await picker()) {
      try {
        await uploader.add(file: file, ownerKind: clearancePhotoOwner, ownerRef: _household.id);
      } on AttachmentRefused catch (refused) {
        refusal = refused.code;
      }
    }
    if (mounted) setState(() => _photoRefusal = refusal);
    (await ref.read(uploadRunnerProvider.future)).trigger();
  }

  Widget _outcome(BuildContext context, CommandOutcome result) {
    switch (result) {
      case CommandDone():
        return OutcomeCard(title: context.t('mob.clearance.result.done.title'), lines: <String>[context.t('mob.clearance.result.done.body')]);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.clearance.result.unknown.title'),
          lines: <String>[context.t('mob.clearance.result.unknown.body')],
          actionLabel: context.t('mob.clearance.result.unknown.action'),
          onAction: _last == null
              ? null
              : () {
                  final Object last = _last!;
                  if (last is InventoryDraft) {
                    _send(last, again: true);
                  } else {
                    run(() => _commands.answer(last as AnswerRequest, retryAfterUnknown: true), onDone: widget.onChanged);
                  }
                },
        );
      case CommandOffline():
        return OutcomeCard(title: gateText(context, ClearanceGate.offline));
      case CommandRefused():
        return OutcomeCard(title: problemText(context, problemOf(result)), code: result.code);
    }
  }

  @override
  Widget build(BuildContext context) {
    final SessionSnapshot session = ref.watch(sessionProvider);
    final bool offline = isOffline(ref);
    final ClearanceGate sendGate = gateOf(offline: offline, fromCopy: false, session: session);
    final ClearanceGate answerGate = gateOf(offline: offline, fromCopy: widget.fromCopy, session: session);
    final CommandOutcome? result = outcome;
    // The outcome of a command is pinned above the list, so it is seen whatever the page is scrolled to.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.35), child: SingleChildScrollView(child: _outcome(context, result))),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
            children: <Widget>[
              _householdCard(context),
              _recordsCard(context, answerGate, session),
              if (_household.workable) _formCard(context, sendGate) else GateNote(text: context.t('mob.clearance.household.notWorkable')),
              _draftsCard(context, sendGate),
              _photosCard(context),
              SectionCard(
                title: context.t('mob.clearance.appointments.title'),
                children: <Widget>[Text(context.t('mob.clearance.appointments.note'), style: Theme.of(context).textTheme.bodyMedium)],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _householdCard(BuildContext context) {
    final Household household = _household;
    return SectionCard(
      title: context.t('mob.clearance.household.title'),
      children: <Widget>[
        FactLine(label: context.t('mob.clearance.household.code'), value: household.code),
        FactLine(label: context.t('mob.clearance.household.status'), value: householdStatusLabel(context, household.status)),
        if (household.memberCount != null) FactLine(label: context.t('mob.clearance.household.members'), value: '${household.memberCount}'),
        FactLine(label: context.t('mob.clearance.household.basis'), value: legalBasisLabel(context, household.legalBasis)),
        if (household.legalBasis == 'CONSENT')
          FactLine(label: context.t('mob.clearance.household.consent'), value: household.hasConsentRecord ? context.t('mob.clearance.household.consent.yes') : context.t('mob.clearance.household.consent.no')),
        if (household.restricted) Text(context.t('mob.clearance.household.restricted'), style: Theme.of(context).textTheme.bodyMedium),
        if (household.anonymised) Text(context.t('mob.clearance.household.anonymised'), style: Theme.of(context).textTheme.bodyMedium),
        Text(context.t('mob.clearance.household.privacy'), style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: MachvonSpace.space8),
        Text(context.t('mob.clearance.parcels.title'), style: Theme.of(context).textTheme.titleSmall),
        if (household.parcels.isEmpty) Text(context.t('mob.clearance.parcels.none'), style: Theme.of(context).textTheme.bodyMedium),
        for (final HouseholdParcel parcel in household.parcels)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(child: Text(context.t('mob.clearance.parcels.line', <String, Object>{'code': parcel.parcelCode, 'right': rightKindLabel(context, parcel.rightKind)}))),
          ),
      ],
    );
  }

  Widget _recordsCard(BuildContext context, ClearanceGate gate, SessionSnapshot session) {
    final ThemeData theme = Theme.of(context);
    return SectionCard(
      title: context.t('mob.clearance.records.title'),
      children: <Widget>[
        if (widget.task.records.isEmpty) Text(context.t('mob.clearance.records.none'), style: theme.textTheme.bodyMedium),
        for (final InventoryRecord record in widget.task.records) ...<Widget>[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.clearance.records.item', <String, Object>{'kind': itemKindLabel(context, record.itemKind), 'description': record.description}), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  Text(
                    context.t('mob.clearance.records.count', <String, Object>{'quantity': record.quantity, 'unit': record.unitCode, 'parcel': record.parcelCode, 'amount': dongLabel(context, record.amountVnd)}),
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(context.t('mob.clearance.records.state', <String, Object>{'status': recordStatusLabel(context, record.status), 'day': formatDay(record.surveyedOn)}), style: theme.textTheme.bodySmall),
                  if (record.note != null) Text(context.t('mob.clearance.records.note', <String, Object>{'note': record.note!}), style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
          if (mayAnswer(record, session.membershipId)) _answerBlock(context, record, gate),
        ],
      ],
    );
  }

  Widget _answerBlock(BuildContext context, InventoryRecord record, ClearanceGate gate) {
    final bool open = gate == ClearanceGate.open && !sending;
    if (_answering != record.id) {
      return Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton(
          onPressed: () => setState(() {
            _answering = record.id;
            _answerDay.text = vietnamDayOf(ref.read(clockProvider)());
            _answerProblems = const <String, AnswerProblem>{};
          }),
          child: Text(context.t('mob.clearance.answer.open.action')),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        DropdownButtonFormField<String>(
          initialValue: _outcomeChoice,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.answer.outcome.label'), errorText: _answerError('outcome')),
          items: <DropdownMenuItem<String>>[
            DropdownMenuItem<String>(value: 'CONFIRMED', child: Text(context.t('mob.clearance.answer.outcome.confirmed'))),
            DropdownMenuItem<String>(value: 'DISPUTED', child: Text(context.t('mob.clearance.answer.outcome.disputed'))),
          ],
          onChanged: sending ? null : (String? value) => setState(() => _outcomeChoice = value),
        ),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _answerDay, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.clearance.answer.day.label'), errorText: _answerError('day'))),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _answerNote, readOnly: sending, maxLines: 3, decoration: InputDecoration(labelText: context.t('mob.clearance.answer.note.label'), errorText: _answerError('note'))),
        const SizedBox(height: MachvonSpace.space8),
        if (gate != ClearanceGate.open) GateNote(text: gateText(context, gate)),
        FilledButton(onPressed: open ? () => _answer(record) : null, child: Text(sending ? context.t('mob.clearance.sending.label') : context.t('mob.clearance.answer.submit.action'))),
      ],
    );
  }

  String? _answerError(String field) {
    final AnswerProblem? problem = _answerProblems[field];
    return problem == null ? null : answerProblemText(context, problem);
  }

  String? _problem(String field) {
    final InventoryProblem? problem = _problems[field];
    return problem == null ? null : inventoryProblemText(context, problem);
  }

  Widget _formCard(BuildContext context, ClearanceGate sendGate) {
    final ThemeData theme = Theme.of(context);
    final String? amount = amountOf(_quantity.text, _price.text);
    final bool open = sendGate == ClearanceGate.open && !sending;
    return SectionCard(
      title: _editing == null ? context.t('mob.clearance.form.title') : context.t('mob.clearance.form.title.edit'),
      children: <Widget>[
        DropdownButtonFormField<String>(
          initialValue: _parcelId,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.parcel.label'), errorText: _problem('parcel')),
          items: <DropdownMenuItem<String>>[for (final HouseholdParcel parcel in _household.parcels) DropdownMenuItem<String>(value: parcel.parcelId, child: Text(parcel.parcelCode))],
          onChanged: (String? value) => setState(() => _parcelId = value),
        ),
        const SizedBox(height: MachvonSpace.space8),
        DropdownButtonFormField<String>(
          initialValue: _itemKind,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.kind.label'), errorText: _problem('kind')),
          items: <DropdownMenuItem<String>>[for (final String kind in itemKinds) DropdownMenuItem<String>(value: kind, child: Text(itemKindLabel(context, kind)))],
          onChanged: (String? value) => setState(() => _itemKind = value),
        ),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _description, maxLines: 2, decoration: InputDecoration(labelText: context.t('mob.clearance.form.description.label'), errorText: _problem('description'))),
        const SizedBox(height: MachvonSpace.space8),
        TextField(
          controller: _quantity,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.quantity.label'), errorText: _problem('quantity')),
        ),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _unit, decoration: InputDecoration(labelText: context.t('mob.clearance.form.unit.label'), errorText: _problem('unit'))),
        const SizedBox(height: MachvonSpace.space8),
        TextField(
          controller: _price,
          keyboardType: TextInputType.number,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.price.label'), errorText: _problem('price')),
        ),
        if (amount != null) Padding(padding: const EdgeInsets.only(top: MachvonSpace.space4), child: Text(context.t('mob.clearance.form.amount', <String, Object>{'amount': dongLabel(context, amount)}), style: theme.textTheme.bodySmall)),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _reference, decoration: InputDecoration(labelText: context.t('mob.clearance.form.reference.label'), errorText: _problem('reference'))),
        const SizedBox(height: MachvonSpace.space8),
        TextField(controller: _day, decoration: InputDecoration(labelText: context.t('mob.clearance.form.day.label'), errorText: _problem('day'))),
        const SizedBox(height: MachvonSpace.space12),
        if (sendGate != ClearanceGate.open) GateNote(text: gateText(context, sendGate)),
        OutlinedButton(onPressed: sending ? null : _keep, child: Text(context.t('mob.clearance.form.keep.action'))),
        const SizedBox(height: MachvonSpace.space8),
        FilledButton(onPressed: open ? _keepAndSend : null, child: Text(sending ? context.t('mob.clearance.sending.label') : context.t('mob.clearance.form.send.action'))),
      ],
    );
  }

  Widget _draftsCard(BuildContext context, ClearanceGate sendGate) {
    final ThemeData theme = Theme.of(context);
    final bool open = sendGate == ClearanceGate.open && !sending;
    return SectionCard(
      title: context.t('mob.clearance.drafts.title'),
      children: <Widget>[
        Text(context.t('mob.clearance.drafts.note'), style: theme.textTheme.bodySmall),
        if (_storeUnavailable) Text(context.t('mob.clearance.drafts.unavailable'), style: theme.textTheme.bodyMedium),
        if (_drafts.isEmpty && !_storeUnavailable) Text(context.t('mob.clearance.drafts.none'), style: theme.textTheme.bodyMedium),
        for (final InventoryDraft draft in _drafts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                MergeSemantics(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        context.t('mob.clearance.drafts.line', <String, Object>{
                          'kind': itemKindLabel(context, draft.form.itemKind ?? 'OTHER'),
                          'quantity': draft.form.quantity,
                          'unit': draft.form.unitCode,
                          'parcel': draft.parcelCode,
                        }),
                        style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      Text(draft.form.description, style: theme.textTheme.bodySmall),
                      Text(
                        draft.lastRefusal == null ? context.t('mob.clearance.drafts.waiting') : context.t('mob.clearance.drafts.refused', <String, Object>{'code': draft.lastRefusal!}),
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    FilledButton(onPressed: open ? () => _send(draft) : null, child: Text(context.t('mob.clearance.drafts.send.action'))),
                    OutlinedButton(onPressed: sending ? null : () => _edit(draft), child: Text(context.t('mob.clearance.drafts.edit.action'))),
                    OutlinedButton(onPressed: sending ? null : () => _discard(draft), child: Text(context.t('mob.clearance.drafts.discard.action'))),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _photosCard(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool hasPicker = ref.watch(attachmentPickerProvider) != null;
    return SectionCard(
      title: context.t('mob.clearance.photos.title'),
      children: <Widget>[
        Text(context.t('mob.clearance.photos.note'), style: theme.textTheme.bodySmall),
        if (_photoRefusal != null) Text(context.t('mob.clearance.photos.refused', <String, Object>{'code': _photoRefusal!}), style: theme.textTheme.bodyMedium),
        if (!hasPicker) Text(context.t('mob.clearance.photos.noPicker'), style: theme.textTheme.bodyMedium),
        const SizedBox(height: MachvonSpace.space8),
        if (hasPicker) FilledButton(onPressed: _addPhotos, child: Text(context.t('mob.clearance.photos.add.action'))),
        if (hasPicker) const SizedBox(height: MachvonSpace.space8),
        OutlinedButton(
          onPressed: () => openScreen(context, 'MOB-19', query: <String, String>{'owner': clearancePhotoOwner, 'ref': _household.id}, stacked: true),
          child: Text(context.t('mob.clearance.photos.list.action')),
        ),
      ],
    );
  }
}

/// The kind of record the photos of a household's site are filed under in the upload list (MOB-19).
const String clearancePhotoOwner = 'land_inventory';
