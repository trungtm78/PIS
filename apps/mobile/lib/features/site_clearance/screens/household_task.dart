import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/attachments/attachment_uploader.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/command_outcome.dart';
import '../../command_support/field_widgets.dart';
import '../../read_support/clock.dart';
import '../../read_support/navigate.dart';
import '../clearance_commands.dart';
import '../clearance_models.dart';
import '../clearance_support.dart';
import '../inventory_drafts.dart';
import '../inventory_rules.dart';
import 'household_views.dart';

/// The body of the task of one household: who it is (by code), the parcels, the inventory counted and its answer, the record being
/// typed and the ones kept on the phone, the photos of the site and the appointments. The bar at the foot is the one action of the moment:
/// recording the answer of the household while one is open, else keeping or sending the count being typed.
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
    // From here the request may reach the server whatever happens to the answer (or to the application): the draft cannot be edited
    // until the answer settles it.
    final InventoryDrafts? keeper = await _store();
    if (keeper != null) {
      keeper.sent(draft);
      if (mounted) {
        setState(() {
          // What is sent is the draft as it was kept: an edit of it that was not kept is abandoned, it could not be kept any more.
          if (_editing == draft.id) _clearForm();
          _drafts = keeper.of(_household.id);
        });
      }
    }
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
    if (result is CommandOffline) {
      final InventoryDrafts? drafts = await _store();
      drafts?.notSent(draft);
      if (mounted && drafts != null) setState(() => _drafts = drafts.of(_household.id));
    }
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
        return OutcomeCard(title: context.t('mob.clearance.result.done.title'), lines: <String>[context.t('mob.clearance.result.done.body')], tone: NoticeTone.ok);
      case CommandUnknown():
        return OutcomeCard(
          title: context.t('mob.clearance.result.unknown.title'),
          lines: <String>[context.t('mob.clearance.result.unknown.body')],
          tone: NoticeTone.warning,
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
        return OutcomeCard(title: gateText(context, ClearanceGate.offline), tone: NoticeTone.info);
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
    final List<InventoryRecord> records = widget.task.records;
    // The outcome of a command is pinned above the list, so it is seen whatever the page is scrolled to.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (result != null) ConstrainedBox(constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.35), child: SingleChildScrollView(child: _outcome(context, result))),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              HouseholdFacts(household: _household),
              GroupHeader(title: context.t('mob.clearance.records.title'), count: records.length),
              if (records.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.clearance.records.none'), style: context.v2text.body)),
              for (int index = 0; index < records.length; index += 1)
                InventoryRecordRow(record: records[index], dividerAbove: index > 0, answer: mayAnswer(records[index], session.membershipId) ? _answerBlock(context, records[index], answerGate) : null),
              if (_household.workable) _formSection(context) else NoticePanel(tone: NoticeTone.warning, title: context.t('mob.clearance.household.notWorkable'), live: false),
              _draftsSection(context, sendGate),
              _photosSection(context),
              FormSection(
                title: context.t('mob.clearance.appointments.title'),
                children: <Widget>[Text(context.t('mob.clearance.appointments.note'), style: context.v2text.body)],
              ),
            ],
          ),
        ),
        ?_bar(context, records, sendGate, answerGate),
      ],
    );
  }

  /// The one action of the moment: the answer of the household while its form is open, else the count being typed (kept on the phone, or kept
  /// and sent). A household that may not be worked on has none. A locked send says why in the line above the buttons.
  Widget? _bar(BuildContext context, List<InventoryRecord> records, ClearanceGate sendGate, ClearanceGate answerGate) {
    InventoryRecord? answering;
    for (final InventoryRecord record in records) {
      if (record.id == _answering) answering = record;
    }
    if (answering != null) {
      final InventoryRecord record = answering;
      final bool open = answerGate == ClearanceGate.open && !sending;
      return ActionBar(
        primary: ActionBarButton(label: sending ? context.t('mob.clearance.sending.label') : context.t('mob.clearance.answer.submit.action'), onPressed: open ? () => _answer(record) : null),
        secondary: ActionBarButton(label: context.t('mob.clearance.answer.close.action'), onPressed: sending ? null : () => setState(() => _answering = null)),
        why: answerGate == ClearanceGate.open ? null : gateText(context, answerGate),
      );
    }
    if (!_household.workable) return null;
    final bool open = sendGate == ClearanceGate.open && !sending;
    return ActionBar(
      primary: ActionBarButton(label: sending ? context.t('mob.clearance.sending.label') : context.t('mob.clearance.form.send.action'), onPressed: open ? _keepAndSend : null),
      secondary: ActionBarButton(label: context.t('mob.clearance.form.keep.action'), onPressed: sending ? null : _keep),
      why: sendGate == ClearanceGate.open ? null : gateText(context, sendGate),
    );
  }

  Widget _answerBlock(BuildContext context, InventoryRecord record, ClearanceGate gate) {
    if (_answering != record.id) {
      return Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton(
          style: v2QuietButtonStyle(context.v2),
          onPressed: () => setState(() {
            _answering = record.id;
            _answerDay.text = vietnamDayOf(ref.read(clockProvider)());
            _answerProblems = const <String, AnswerProblem>{};
          }),
          child: Text(context.t('mob.clearance.answer.open.action')),
        ),
      );
    }
    return HouseholdAnswerFields(
      outcome: _outcomeChoice,
      day: _answerDay,
      note: _answerNote,
      errors: <String, String>{for (final MapEntry<String, AnswerProblem> entry in _answerProblems.entries) entry.key: answerProblemText(context, entry.value)},
      sending: sending,
      consentMissing: _household.legalBasis == 'CONSENT' && !_household.hasConsentRecord,
      onOutcome: (String? value) => setState(() => _outcomeChoice = value),
    );
  }

  String? _problem(String field) {
    final InventoryProblem? problem = _problems[field];
    return problem == null ? null : inventoryProblemText(context, problem);
  }

  Widget _formSection(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String? amount = amountOf(_quantity.text, _price.text);
    final Widget quantity = TextField(
      controller: _quantity,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      textInputAction: TextInputAction.next,
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(labelText: context.t('mob.clearance.form.quantity.label'), errorText: _problem('quantity'), errorMaxLines: 3),
    );
    final Widget unit = TextField(controller: _unit, textInputAction: TextInputAction.next, decoration: InputDecoration(labelText: context.t('mob.clearance.form.unit.label'), errorText: _problem('unit'), errorMaxLines: 3));
    return FormSection(
      title: _editing == null ? context.t('mob.clearance.form.title') : context.t('mob.clearance.form.title.edit'),
      children: <Widget>[
        DropdownButtonFormField<String>(
          initialValue: _parcelId,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.parcel.label'), errorText: _problem('parcel')),
          items: <DropdownMenuItem<String>>[for (final HouseholdParcel parcel in _household.parcels) DropdownMenuItem<String>(value: parcel.parcelId, child: Text(parcel.parcelCode))],
          onChanged: (String? value) => setState(() => _parcelId = value),
        ),
        const SizedBox(height: MachvonV2Space.s12),
        DropdownButtonFormField<String>(
          initialValue: _itemKind,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.kind.label'), errorText: _problem('kind')),
          items: <DropdownMenuItem<String>>[for (final String kind in itemKinds) DropdownMenuItem<String>(value: kind, child: Text(itemKindLabel(context, kind)))],
          onChanged: (String? value) => setState(() => _itemKind = value),
        ),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(controller: _description, maxLines: 2, decoration: InputDecoration(labelText: context.t('mob.clearance.form.description.label'), errorText: _problem('description'), errorMaxLines: 3)),
        const SizedBox(height: MachvonV2Space.s12),
        // The count and its unit sit side by side; at a large text scale they stack, so neither label is cut.
        if (largeText(context))
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: <Widget>[quantity, const SizedBox(height: MachvonV2Space.s12), unit])
        else
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[Expanded(flex: 3, child: quantity), const SizedBox(width: MachvonV2Space.s12), Expanded(flex: 2, child: unit)]),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(
          controller: _price,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.next,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(labelText: context.t('mob.clearance.form.price.label'), errorText: _problem('price'), errorMaxLines: 3),
        ),
        if (amount != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(context.t('mob.clearance.form.amount', <String, Object>{'amount': moneyExactLabel(context, amount)}), style: text.caption)),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(controller: _reference, textInputAction: TextInputAction.next, decoration: InputDecoration(labelText: context.t('mob.clearance.form.reference.label'), errorText: _problem('reference'), errorMaxLines: 3)),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(controller: _day, decoration: InputDecoration(labelText: context.t('mob.clearance.form.day.label'), errorText: _problem('day'), errorMaxLines: 3)),
      ],
    );
  }

  Widget _draftsSection(BuildContext context, ClearanceGate sendGate) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final bool canSend = sendGate == ClearanceGate.open;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.clearance.drafts.title'), count: _drafts.length),
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
          child: Text(context.t('mob.clearance.drafts.note'), style: text.caption.copyWith(color: v2.palette.ink2)),
        ),
        // A household that may not be worked on has no form and so no bar: the reason a draft cannot be sent is said here.
        if (!_household.workable && !canSend && _drafts.isNotEmpty) Padding(padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16), child: GateNote(text: gateText(context, sendGate))),
        if (_storeUnavailable) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.clearance.drafts.unavailable')),
        if (_drafts.isEmpty && !_storeUnavailable) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.clearance.drafts.none'), style: text.body)),
        for (int index = 0; index < _drafts.length; index += 1)
          InventoryDraftRow(
            draft: _drafts[index],
            dividerAbove: index > 0,
            canSend: canSend,
            busy: sending,
            onSend: () => _send(_drafts[index]),
            onEdit: () => _edit(_drafts[index]),
            onDiscard: () => _discard(_drafts[index]),
          ),
      ],
    );
  }

  Widget _photosSection(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final bool hasPicker = ref.watch(attachmentPickerProvider) != null;
    return FormSection(
      title: context.t('mob.clearance.photos.title'),
      children: <Widget>[
        Text(context.t('mob.clearance.photos.note'), style: text.caption.copyWith(color: v2.palette.ink2)),
        if (_photoRefusal != null) NoticePanel(tone: NoticeTone.problem, title: context.t('mob.clearance.photos.refused', <String, Object>{'code': _photoRefusal!}), margin: const EdgeInsets.only(top: MachvonV2Space.s8)),
        if (!hasPicker) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.clearance.photos.noPicker'), style: text.body)),
        const SizedBox(height: MachvonV2Space.s12),
        if (hasPicker) ...<Widget>[
          OutlinedButton.icon(style: v2QuietButtonStyle(v2), onPressed: _addPhotos, icon: const Icon(Icons.add_a_photo_outlined, size: 20), label: Text(context.t('mob.clearance.photos.add.action'))),
          const SizedBox(height: MachvonV2Space.s8),
        ],
        OutlinedButton(
          style: v2QuietButtonStyle(v2),
          onPressed: () => openScreen(context, 'MOB-19', query: <String, String>{'owner': clearancePhotoOwner, 'ref': _household.id}, stacked: true),
          child: Text(context.t('mob.clearance.photos.list.action')),
        ),
      ],
    );
  }
}

/// The kind of record the photos of a household's site are filed under in the upload list (MOB-19).
const String clearancePhotoOwner = 'land_inventory';
