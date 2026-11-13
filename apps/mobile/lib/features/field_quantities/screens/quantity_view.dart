import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/command_flow.dart';
import '../../command_support/field_widgets.dart';
import '../quantity_labels.dart';
import '../quantity_models.dart';

/// What the person has typed for one quantity, with the controllers that hold the text as it was typed (the text is what is kept and what is
/// sent: the screen only shows next to it how it reads in the digits of the language).
class QuantityFields {
  const QuantityFields({required this.quantity, required this.reference, required this.override, required this.periodId});

  final TextEditingController quantity;
  final TextEditingController reference;
  final TextEditingController override;
  final TextEditingController periodId;
}

/// The screen of MOB-63 as a function of its state (design B): the contract, the notices and the quantities on their way, then one column of
/// fields (item, period, the quantity with its unit next to the field, the number of the record), the place, the photographs, the quantities
/// recorded as rows with their state and evidence, and the sticky bar at the foot. The logic (the draft, the queue, the commands) stays in
/// `QuantityScreen`; this widget holds nothing but what it is given, so every state of the screen can be drawn.
class QuantityEntryView extends StatelessWidget {
  const QuantityEntryView({
    required this.contractLabel,
    required this.contractStatus,
    required this.items,
    required this.periods,
    required this.form,
    required this.fields,
    required this.errors,
    required this.saving,
    required this.onItem,
    required this.onPeriod,
    required this.onPeriodText,
    required this.onQuantity,
    required this.onReference,
    required this.onOverride,
    required this.placeField,
    required this.photosField,
    required this.measurements,
    required this.submitWhy,
    required this.busy,
    required this.onSubmit,
    required this.onReload,
    required this.bar,
    this.fromCopy = false,
    this.notices = const <Widget>[],
    this.waiting = const <Widget>[],
    this.outcome,
    this.remaining,
    this.unit,
    this.echo,
    super.key,
  });

  final String contractLabel;
  final String contractStatus;
  final bool fromCopy;
  final List<BoqItem> items;

  /// Null when the reader may not read the periods: the period is then typed as an identifier, as on the web.
  final List<MeasurePeriod>? periods;
  final QuantityForm form;
  final QuantityFields fields;

  /// The words of what is wrong, by field (`item`, `period`, `quantity`, `reference`, `override`), shown under the field.
  final Map<String, String> errors;
  final bool saving;
  final ValueChanged<String> onItem;
  final ValueChanged<String> onPeriod;
  final ValueChanged<String> onPeriodText;
  final ValueChanged<String> onQuantity;
  final ValueChanged<String> onReference;
  final ValueChanged<String> onOverride;
  final Widget placeField;
  final Widget photosField;
  final List<Measurement> measurements;

  /// Why a recorded quantity cannot be sent for approval now (offline, a copy, read-only), or null when it can.
  final String? submitWhy;
  final bool busy;
  final ValueChanged<Measurement> onSubmit;
  final VoidCallback onReload;

  /// The sticky bar at the foot (`FieldSendBar`).
  final Widget bar;
  final List<Widget> notices;

  /// The rows of the quantities of this phone that are on their way.
  final List<Widget> waiting;
  final Widget? outcome;

  /// What is left of the item chosen, as it reads in the digits of the language ("7.879,5"), and its unit.
  final String? remaining;
  final String? unit;

  /// The quantity typed as it reads in the digits of the language, once it is a number the server takes.
  final String? echo;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String? chosenValue = items.any((BoqItem item) => item.lineId == form.itemLineId) ? form.itemLineId : null;
    final List<MeasurePeriod>? known = periods;
    final String quantityLabelText = unit == null || unit!.isEmpty ? context.t('mob.qty.form.quantity') : context.t('mob.qty.form.quantity.unit', <String, Object>{'unit': unit!});
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s4),
                child: Wrap(
                  spacing: MachvonV2Space.s8,
                  runSpacing: MachvonV2Space.s4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    Semantics(header: true, child: Text(contractLabel, style: text.title)),
                    StatusPill(label: contractStatus),
                  ],
                ),
              ),
              if (fromCopy)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
                  child: Text(context.t('mob.qty.copy.notice'), style: text.caption.copyWith(color: v2.palette.ink2)),
                ),
              ...notices,
              if (waiting.isNotEmpty) ...<Widget>[
                const SizedBox(height: MachvonV2Space.s8),
                GroupHeader(title: context.t('mob.qty.waiting.title'), count: waiting.length),
                ...waiting,
              ],
              FormSection(
                title: context.t('mob.qty.form.title'),
                first: true,
                children: <Widget>[
                  if (items.isEmpty)
                    NoticePanel(
                      tone: NoticeTone.info,
                      title: context.t('mob.qty.items.none'),
                      actionLabel: context.t('mob.states.retry.action'),
                      onAction: onReload,
                      live: false,
                      margin: EdgeInsets.zero,
                    )
                  else
                    DropdownButtonFormField<String>(
                      key: ValueKey<String>('item-${form.itemLineId}'),
                      initialValue: chosenValue,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: context.t('mob.qty.form.item'), errorText: errors['item']),
                      items: <DropdownMenuItem<String>>[for (final BoqItem item in items) DropdownMenuItem<String>(value: item.lineId, child: Text(item.label, overflow: TextOverflow.ellipsis))],
                      onChanged: saving ? null : (String? id) => onItem(id ?? ''),
                    ),
                  if (remaining != null)
                    Padding(
                      padding: const EdgeInsets.only(top: MachvonV2Space.s4),
                      child: Text(context.t('mob.qty.item.left', <String, Object>{'left': remaining!, 'unit': unit ?? ''}), style: text.caption),
                    ),
                  const SizedBox(height: MachvonV2Space.s12),
                  if (known != null)
                    DropdownButtonFormField<String>(
                      key: ValueKey<String>('period-${form.periodId}'),
                      initialValue: known.any((MeasurePeriod period) => period.id == form.periodId) ? form.periodId : null,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: context.t('mob.qty.form.period'), errorText: errors['period']),
                      items: <DropdownMenuItem<String>>[for (final MeasurePeriod period in known) DropdownMenuItem<String>(value: period.id, child: Text(period.code))],
                      onChanged: saving ? null : (String? id) => onPeriod(id ?? ''),
                    )
                  else
                    TextField(
                      controller: fields.periodId,
                      readOnly: saving,
                      decoration: InputDecoration(labelText: context.t('mob.qty.form.periodId'), helperText: context.t('mob.qty.form.periodId.hint'), helperMaxLines: 3, errorText: errors['period']),
                      onChanged: onPeriodText,
                    ),
                  const SizedBox(height: MachvonV2Space.s12),
                  TextField(
                    controller: fields.quantity,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    textInputAction: TextInputAction.next,
                    readOnly: saving,
                    decoration: InputDecoration(
                      labelText: quantityLabelText,
                      suffixText: unit == null || unit!.isEmpty ? null : unit,
                      helperText: echo == null ? context.t('mob.qty.form.quantity.hint') : context.t('mob.qty.form.quantity.echo', <String, Object>{'quantity': echo!, 'unit': unit ?? ''}),
                      helperMaxLines: 3,
                      errorText: errors['quantity'],
                      errorMaxLines: 3,
                    ),
                    onChanged: onQuantity,
                  ),
                  const SizedBox(height: MachvonV2Space.s12),
                  TextField(
                    controller: fields.reference,
                    readOnly: saving,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(labelText: context.t('mob.qty.form.reference'), errorText: errors['reference']),
                    onChanged: onReference,
                  ),
                  const SizedBox(height: MachvonV2Space.s12),
                  TextField(
                    controller: fields.override,
                    readOnly: saving,
                    decoration: InputDecoration(labelText: context.t('mob.qty.form.override'), helperText: context.t('mob.qty.form.override.hint'), helperMaxLines: 3, errorText: errors['override']),
                    onChanged: onOverride,
                  ),
                ],
              ),
              FormSection(title: context.t('mob.qty.place.title'), children: <Widget>[placeField]),
              FormSection(
                title: context.t('mob.qty.photos.title'),
                children: <Widget>[
                  photosField,
                  Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.qty.photos.note'), style: text.caption)),
                ],
              ),
              ?outcome,
              const SizedBox(height: MachvonV2Space.s8),
              GroupHeader(title: context.t('mob.qty.recorded.title'), count: measurements.length),
              if (measurements.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(MachvonV2Space.s16),
                  child: Text(context.t('mob.qty.recorded.none'), style: text.body.copyWith(color: v2.palette.ink2)),
                ),
              for (int index = 0; index < measurements.length; index += 1)
                MeasurementRow(measurement: measurements[index], dividerAbove: index > 0, why: submitWhy, busy: busy, onSubmit: measurements[index].canSubmit ? () => onSubmit(measurements[index]) : null),
            ],
          ),
        ),
        bar,
      ],
    );
  }
}

/// A quantity that was recorded: the item, the figure with its unit and the period as the title, the files that are its basis as the context,
/// its state as a pill; and, when the server lets the maker send it, the quiet button that sends it for approval (online only: locked with the
/// reason beside it while there is no network).
class MeasurementRow extends StatelessWidget {
  const MeasurementRow({required this.measurement, required this.why, required this.busy, required this.onSubmit, this.dividerAbove = false, super.key});

  final Measurement measurement;
  final String? why;
  final bool busy;
  final VoidCallback? onSubmit;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        WorkRow(
          title: context.t('mob.qty.recorded.line', <String, Object>{'item': measurement.itemKey, 'quantity': quantityLabel(context, measurement.quantityPeriod), 'unit': measurement.unitCode, 'period': measurement.periodCode}),
          subtitle: context.t('mob.qty.recorded.evidence', <String, Object>{'count': measurement.evidenceCount}),
          trailing: StatusPill(label: measurementStatusText(context, measurement.status), tone: measurementTone(measurement.status)),
          dividerAbove: dividerAbove,
        ),
        if (onSubmit != null)
          Padding(
            padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (why != null) GateNote(text: why!),
                OutlinedButton(style: v2QuietButtonStyle(v2), onPressed: why == null && !busy ? onSubmit : null, child: Text(context.t('mob.qty.submit.action'))),
              ],
            ),
          ),
      ],
    );
  }
}
