import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/components.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../clearance_models.dart';
import '../clearance_support.dart';
import '../inventory_drafts.dart';

/// The household as the phone knows it: its code and the facts the work needs, as rows; what stops the work (data processing restricted, the
/// personal data erased) as a notice. Nothing here names a person: the phone never holds a name, an identity number, a telephone or an address.
class HouseholdFacts extends StatelessWidget {
  const HouseholdFacts({required this.household, super.key});

  final Household household;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final String status = householdStatusLabel(context, household.status);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        GroupHeader(title: context.t('mob.clearance.household.title')),
        InfoRow(label: context.t('mob.clearance.household.code'), value: household.code, divider: false),
        InfoRow(label: context.t('mob.clearance.household.status'), value: status, valueWidget: StatusPill(label: status, tone: householdStatusTone(household.status))),
        InfoRow(label: context.t('mob.clearance.household.members'), value: household.memberCount?.toString()),
        InfoRow(label: context.t('mob.clearance.household.basis'), value: legalBasisLabel(context, household.legalBasis)),
        if (household.legalBasis == 'CONSENT')
          InfoRow(label: context.t('mob.clearance.household.consent'), value: household.hasConsentRecord ? context.t('mob.clearance.household.consent.yes') : context.t('mob.clearance.household.consent.no')),
        if (household.restricted) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.clearance.household.restricted'), live: false),
        if (household.anonymised) NoticePanel(tone: NoticeTone.warning, title: context.t('mob.clearance.household.anonymised'), live: false),
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Text(context.t('mob.clearance.household.privacy'), style: text.caption.copyWith(color: v2.palette.ink2)),
        ),
        GroupHeader(title: context.t('mob.clearance.parcels.title'), count: household.parcels.length),
        if (household.parcels.isEmpty) Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.clearance.parcels.none'), style: text.body)),
        for (int index = 0; index < household.parcels.length; index += 1)
          WorkRow(
            title: context.t('mob.clearance.parcels.line', <String, Object>{'code': household.parcels[index].parcelCode, 'right': rightKindLabel(context, household.parcels[index].rightKind)}),
            dividerAbove: index > 0,
          ),
      ],
    );
  }
}

/// One line of the inventory counted: what it is, how much and what it comes to as the server computed it, and where the household's answer
/// stands. The way to record the answer (a quiet button, then its form) is [answer], under the line.
class InventoryRecordRow extends StatelessWidget {
  const InventoryRecordRow({required this.record, this.answer, this.dividerAbove = false, super.key});

  final InventoryRecord record;
  final Widget? answer;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) Divider(height: 1, thickness: 1, indent: MachvonV2Space.s16, color: v2.palette.line),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.clearance.records.item', <String, Object>{'kind': itemKindLabel(context, record.itemKind), 'description': record.description}), style: text.bodyStrong),
                    Text(
                      context.t('mob.clearance.records.count', <String, Object>{
                        'quantity': formatNumber(record.quantity, AppStrings.of(context).language),
                        'unit': record.unitCode,
                        'parcel': record.parcelCode,
                        'amount': moneyExactLabel(context, record.amountVnd),
                      }),
                      style: text.body,
                    ),
                    Text(context.t('mob.clearance.records.state', <String, Object>{'status': recordStatusLabel(context, record.status), 'day': formatDay(record.surveyedOn)}), style: text.caption),
                    if (record.note != null) Text(context.t('mob.clearance.records.note', <String, Object>{'note': record.note!}), style: text.caption),
                  ],
                ),
              ),
              if (answer != null) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: answer),
            ],
          ),
        ),
      ],
    );
  }
}

/// The answer of the household to a record: the choice (confirmed or disputed), the day, the words; with the consent that gates a confirmation
/// said in words as soon as the choice makes it matter. The server judges the answer; this only tells what it will ask.
class HouseholdAnswerFields extends StatelessWidget {
  const HouseholdAnswerFields({
    required this.outcome,
    required this.day,
    required this.note,
    required this.errors,
    required this.sending,
    required this.consentMissing,
    required this.onOutcome,
    super.key,
  });

  final String? outcome;
  final TextEditingController day;
  final TextEditingController note;

  /// The words of what is wrong, by field: `outcome`, `day`, `note`.
  final Map<String, String> errors;
  final bool sending;

  /// The household's basis is its consent and no record of it is on file: confirming will be refused until there is one.
  final bool consentMissing;
  final ValueChanged<String?> onOutcome;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        DropdownButtonFormField<String>(
          initialValue: outcome,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.clearance.answer.outcome.label'), errorText: errors['outcome'], errorMaxLines: 3),
          items: <DropdownMenuItem<String>>[
            DropdownMenuItem<String>(value: 'CONFIRMED', child: Text(context.t('mob.clearance.answer.outcome.confirmed'), overflow: TextOverflow.ellipsis)),
            DropdownMenuItem<String>(value: 'DISPUTED', child: Text(context.t('mob.clearance.answer.outcome.disputed'), overflow: TextOverflow.ellipsis)),
          ],
          onChanged: sending ? null : onOutcome,
        ),
        if (consentMissing && outcome == 'CONFIRMED')
          NoticePanel(tone: NoticeTone.warning, title: context.t('mob.clearance.answer.consent.missing'), live: true, margin: const EdgeInsets.only(top: MachvonV2Space.s8)),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(controller: day, readOnly: sending, decoration: InputDecoration(labelText: context.t('mob.clearance.answer.day.label'), errorText: errors['day'], errorMaxLines: 3)),
        const SizedBox(height: MachvonV2Space.s12),
        TextField(controller: note, readOnly: sending, maxLines: 3, decoration: InputDecoration(labelText: context.t('mob.clearance.answer.note.label'), errorText: errors['note'], errorMaxLines: 3)),
      ],
    );
  }
}

/// A record counted in the field and kept on the phone until it is sent: what was counted, where it stands (waiting, unsettled after a lost
/// answer, refused with the code), and the three things to do with it (send, change, delete). A draft whose answer is unknown cannot be changed:
/// the first request may exist under its key.
class InventoryDraftRow extends StatelessWidget {
  const InventoryDraftRow({required this.draft, required this.canSend, required this.busy, required this.onSend, required this.onEdit, required this.onDiscard, this.dividerAbove = false, super.key});

  final InventoryDraft draft;
  final bool canSend;
  final bool busy;
  final VoidCallback onSend;
  final VoidCallback onEdit;
  final VoidCallback onDiscard;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String state = draft.awaitingAnswer
        ? context.t('mob.clearance.drafts.unsettled')
        : draft.lastRefusal == null
            ? context.t('mob.clearance.drafts.waiting')
            : context.t('mob.clearance.drafts.refused', <String, Object>{'code': draft.lastRefusal!});
    final MachvonTone tone = draft.awaitingAnswer ? MachvonTone.warning : (draft.lastRefusal == null ? MachvonTone.info : MachvonTone.danger);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (dividerAbove) Divider(height: 1, thickness: 1, indent: MachvonV2Space.s16, color: v2.palette.line),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
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
                      style: text.bodyStrong,
                    ),
                    Text(draft.form.description, style: text.caption),
                    const SizedBox(height: MachvonV2Space.s8),
                    StatusPill(label: state, tone: tone),
                  ],
                ),
              ),
              const SizedBox(height: MachvonV2Space.s8),
              Wrap(
                spacing: MachvonV2Space.s8,
                runSpacing: MachvonV2Space.s8,
                children: <Widget>[
                  FilledButton(style: v2PrimaryButtonStyle(v2), onPressed: canSend && !busy ? onSend : null, child: Text(context.t('mob.clearance.drafts.send.action'))),
                  OutlinedButton(style: v2QuietButtonStyle(v2), onPressed: busy || draft.awaitingAnswer ? null : onEdit, child: Text(context.t('mob.clearance.drafts.edit.action'))),
                  OutlinedButton(style: v2QuietButtonStyle(v2), onPressed: busy ? null : onDiscard, child: Text(context.t('mob.clearance.drafts.discard.action'))),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
