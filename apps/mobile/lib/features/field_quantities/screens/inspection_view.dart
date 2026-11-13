import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_widgets.dart';
import '../inspection_labels.dart';
import '../inspection_models.dart';

/// The screen of MOB-64 as a function of its state (design B): the inspection and its state, the notices and the result on its way, then,
/// while the inspection is open for a result, the checklist (each item a question with three 48 high answers, an inline word when it is not
/// answered, and a note), the overall result, the place and the photographs, with the sticky bar at the foot; or what is known of the result,
/// the non-conformances it raised and the request for the acceptance. The logic stays in `InspectionScreen`; this widget holds only what it is given.
class InspectionEntryView extends StatelessWidget {
  const InspectionEntryView({
    required this.contractLabel,
    required this.inspections,
    required this.inspection,
    required this.onPick,
    required this.formOpen,
    required this.form,
    required this.itemNotes,
    required this.resultNote,
    required this.errors,
    required this.saving,
    required this.onOutcome,
    required this.onItemNote,
    required this.onResult,
    required this.onResultNote,
    required this.placeField,
    required this.photosField,
    required this.raised,
    this.fromCopy = false,
    this.notices = const <Widget>[],
    this.waiting = const <Widget>[],
    this.acceptance,
    this.outcome,
    this.bar,
    super.key,
  });

  final String contractLabel;
  final List<Inspection> inspections;
  final Inspection inspection;
  final ValueChanged<String> onPick;
  final bool fromCopy;

  /// The inspection is open for a result and none of this phone is on its way: the form is shown.
  final bool formOpen;
  final ResultForm form;
  final Map<String, TextEditingController> itemNotes;
  final TextEditingController resultNote;

  /// The words of what is wrong, by field: `answer:<item code>`, `result`, `whole`, `resultNote`.
  final Map<String, String> errors;
  final bool saving;
  final void Function(String code, String outcome) onOutcome;
  final void Function(String code, String note) onItemNote;
  final ValueChanged<String> onResult;
  final ValueChanged<String> onResultNote;
  final Widget placeField;
  final Widget photosField;
  final List<Nonconformance> raised;
  final List<Widget> notices;
  final List<Widget> waiting;

  /// The request for the acceptance (`AcceptanceFormSection`), when the result allows one.
  final Widget? acceptance;
  final Widget? outcome;

  /// The sticky bar at the foot: save the result, or ask for the acceptance. Null when the screen has nothing to do.
  final Widget? bar;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Semantics(header: true, child: Text(contractLabel, style: text.title)),
                    const SizedBox(height: MachvonV2Space.s8),
                    if (inspections.length > 1)
                      DropdownButtonFormField<String>(
                        key: ValueKey<String>('inspection-${inspection.id}'),
                        initialValue: inspection.id,
                        isExpanded: true,
                        decoration: InputDecoration(labelText: context.t('mob.chk.pick')),
                        items: <DropdownMenuItem<String>>[
                          for (final Inspection other in inspections) DropdownMenuItem<String>(value: other.id, child: Text('${other.inspectionNo} · ${other.title}', overflow: TextOverflow.ellipsis)),
                        ],
                        onChanged: (String? id) {
                          if (id != null) onPick(id);
                        },
                      )
                    else
                      Text('${inspection.inspectionNo} · ${inspection.title}', style: text.bodyStrong),
                    const SizedBox(height: MachvonV2Space.s8),
                    Align(alignment: Alignment.centerLeft, child: StatusPill(label: inspectionStatusText(context, inspection.status))),
                  ],
                ),
              ),
              InfoRow(label: context.t('mob.chk.location'), value: inspection.locationText, divider: false),
              if (fromCopy)
                Padding(
                  padding: const EdgeInsets.only(left: MachvonV2Space.s16, top: MachvonV2Space.s8, right: MachvonV2Space.s16),
                  child: Text(context.t('mob.chk.copy.notice'), style: text.caption.copyWith(color: v2.palette.ink2)),
                ),
              ...notices,
              if (waiting.isNotEmpty) ...<Widget>[
                const SizedBox(height: MachvonV2Space.s8),
                GroupHeader(title: context.t('mob.chk.waiting.title'), count: waiting.length),
                ...waiting,
              ],
              if (formOpen) ..._form(context) else if (!inspection.isOpen) _recorded(context),
              if (raised.isNotEmpty) ...<Widget>[
                const SizedBox(height: MachvonV2Space.s8),
                GroupHeader(title: context.t('mob.chk.ncr.title'), count: raised.length),
                for (int index = 0; index < raised.length; index += 1) _NonconformanceRow(ncr: raised[index], dividerAbove: index > 0),
              ],
              ?acceptance,
              ?outcome,
            ],
          ),
        ),
        ?bar,
      ],
    );
  }

  List<Widget> _form(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return <Widget>[
      FormSection(
        title: context.t('mob.chk.checklist.title'),
        children: <Widget>[
          for (final ChecklistItem item in inspection.checklist)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Semantics(header: true, child: Text(item.label, style: text.bodyStrong)),
                  const SizedBox(height: MachvonV2Space.s8),
                  _ChoiceRow(
                    values: kOutcomes,
                    labelOf: (String outcome) => outcomeText(context, outcome),
                    selected: form.answerOf(item.code).outcome,
                    onSelected: saving ? null : (String outcome) => onOutcome(item.code, outcome),
                  ),
                  if (errors['answer:${item.code}'] != null) _FieldError(text: errors['answer:${item.code}']!),
                  const SizedBox(height: MachvonV2Space.s8),
                  TextField(
                    controller: itemNotes[item.code],
                    readOnly: saving,
                    decoration: InputDecoration(labelText: context.t('mob.chk.item.note', <String, Object>{'item': item.label})),
                    onChanged: (String value) => onItemNote(item.code, value),
                  ),
                ],
              ),
            ),
        ],
      ),
      FormSection(
        title: context.t('mob.chk.result.title'),
        children: <Widget>[
          _ChoiceRow(
            values: kResults,
            labelOf: (String result) => resultText(context, result),
            selected: form.result,
            onSelected: saving ? null : onResult,
          ),
          if (errors['result'] != null) _FieldError(text: errors['result']!),
          if (errors['whole'] != null) _FieldError(text: errors['whole']!),
          const SizedBox(height: MachvonV2Space.s12),
          TextField(
            controller: resultNote,
            maxLines: 3,
            readOnly: saving,
            decoration: InputDecoration(labelText: context.t('mob.chk.result.note'), errorText: errors['resultNote']),
            onChanged: onResultNote,
          ),
        ],
      ),
      FormSection(title: context.t('mob.chk.place.title'), children: <Widget>[placeField]),
      FormSection(
        title: context.t('mob.chk.photos.title'),
        children: <Widget>[
          photosField,
          Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.chk.photos.note'), style: text.caption)),
        ],
      ),
    ];
  }

  Widget _recorded(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return FormSection(
      title: context.t('mob.chk.recorded.title'),
      children: <Widget>[
        if (inspection.result != null) InfoRow(label: context.t('mob.chk.result.title'), value: resultText(context, inspection.result!), divider: false),
        if (inspection.status != 'RESULT_RECORDED') Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: Text(context.t('mob.chk.recorded.notOpen'), style: text.body)),
      ],
    );
  }
}

/// The answers of one question as a row of choice chips, each 48 high at least. The chosen one has a tick and bold words as well as its fill, so
/// the choice is not told by colour alone; the row is a mutually exclusive group for a screen reader.
class _ChoiceRow extends StatelessWidget {
  const _ChoiceRow({required this.values, required this.labelOf, required this.selected, required this.onSelected});

  final List<String> values;
  final String Function(String value) labelOf;
  final String selected;
  final ValueChanged<String>? onSelected;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Semantics(
      container: true,
      inMutuallyExclusiveGroup: true,
      child: Wrap(
        spacing: MachvonV2Space.s8,
        runSpacing: MachvonV2Space.s8,
        children: <Widget>[
          for (final String value in values)
            ChoiceChip(
              label: Text(labelOf(value), style: selected == value ? text.bodyStrong : text.body),
              selected: selected == value,
              showCheckmark: true,
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8, vertical: MachvonV2Space.s16),
              onSelected: onSelected == null ? null : (bool _) => onSelected!(value),
            ),
        ],
      ),
    );
  }
}

/// What is wrong with a choice, under it: an icon and the words in the colour of a late deadline, a live region so it is said when it appears.
class _FieldError extends StatelessWidget {
  const _FieldError({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.only(top: MachvonV2Space.s8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: Icon(Icons.error_outline, size: 16, color: v2.palette.lateFg)),
            const SizedBox(width: MachvonV2Space.s4),
            Expanded(child: Text(text, style: context.v2text.caption.copyWith(color: v2.palette.lateFg))),
          ],
        ),
      ),
    );
  }
}

/// A non-conformance the failed items raised, as a row: its number and title, its severity and, while it is open and stands in the way of the
/// acceptance, that it does.
class _NonconformanceRow extends StatelessWidget {
  const _NonconformanceRow({required this.ncr, required this.dividerAbove});

  final Nonconformance ncr;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final bool critical = ncr.severity == 'CRITICAL';
    final bool blocks = ncr.blocksAcceptance && ncr.isOpen;
    return WorkRow(
      title: context.t('mob.chk.ncr.line', <String, Object>{'no': ncr.ncrNo, 'title': ncr.title}),
      dividerAbove: dividerAbove,
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          StatusPill(label: severityOfNcrText(context, ncr.severity), tone: critical ? MachvonTone.danger : MachvonTone.warning),
          if (blocks) ...<Widget>[const SizedBox(height: MachvonV2Space.s4), StatusPill(label: context.t('mob.chk.ncr.blocks'), tone: MachvonTone.danger)],
        ],
      ),
    );
  }
}

/// The request for the quality acceptance: the number of the minutes and the file version, typed. It is made online on the result the server
/// holds, so the bar says why it is locked when there is no network.
class AcceptanceFormSection extends StatelessWidget {
  const AcceptanceFormSection({required this.record, required this.document, required this.errors, required this.sending, super.key});

  final TextEditingController record;
  final TextEditingController document;

  /// The words of what is wrong, by field: `record`, `document`.
  final Map<String, String> errors;
  final bool sending;

  @override
  Widget build(BuildContext context) {
    return FormSection(
      title: context.t('mob.chk.accept.title'),
      caption: context.t('mob.chk.accept.hint'),
      children: <Widget>[
        TextField(controller: record, readOnly: sending, textInputAction: TextInputAction.next, decoration: InputDecoration(labelText: context.t('mob.chk.accept.record'), errorText: errors['record'])),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(
          controller: document,
          readOnly: sending,
          decoration: InputDecoration(labelText: context.t('mob.chk.accept.document'), helperText: context.t('mob.chk.accept.document.hint'), helperMaxLines: 3, errorText: errors['document'], errorMaxLines: 3),
        ),
      ],
    );
  }
}
