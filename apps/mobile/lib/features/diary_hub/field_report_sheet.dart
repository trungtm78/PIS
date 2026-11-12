import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/connectivity/reachability.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/queue/queued_command.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/sheets.dart';
import '../../core/widgets/tap_target.dart';
import '../../core/widgets/work_row.dart';
import '../command_support/field_contract.dart';
import '../read_support/navigate.dart';
import '../site_diary/diary_models.dart' show kDiaryDraftKind;
import 'hub_models.dart';
import 'hub_support.dart';

/// The four things a person reports from the field (key flow 5): the kind of report and where it opens.
enum FieldReportKind { photo, issue, diary, quantity }

/// Opens the quick "Report" sheet: four kinds, the contract the person worked on last already chosen. The button that opens it (the floating
/// "Report" button of a root screen) and the kind they pick are two taps, and the form that opens saves for later when there is no network.
/// [onChosen] replaces the navigation (a test records what was chosen).
Future<void> showFieldReportSheet(BuildContext context, {void Function(FieldReportKind kind, String? contractId)? onChosen}) {
  return showActionSheet<void>(
    context,
    title: context.t('mob.field.report.title'),
    builder: (BuildContext sheet) => FieldReportSheet(
      onChosen: (FieldReportKind kind, String? contractId) {
        Navigator.pop(sheet);
        if (onChosen != null) {
          onChosen(kind, contractId);
        } else if (context.mounted) {
          openFieldReport(context, kind, contractId);
        }
      },
    ),
  );
}

/// Opens the form of [kind]. A kind that belongs to a contract opens that contract's form when it is known, and the list of contracts (MOB-61)
/// where one is chosen when it is not; an obstacle needs no contract.
void openFieldReport(BuildContext context, FieldReportKind kind, String? contractId) {
  switch (kind) {
    case FieldReportKind.issue:
      openScreen(context, 'MOB-28', stacked: true);
    case FieldReportKind.photo:
      openScreen(context, 'QMS-10', query: <String, String>{'contract': ?contractId}, stacked: true);
    case FieldReportKind.diary:
      contractId == null ? openScreen(context, 'MOB-61', stacked: true) : openScreen(context, 'MOB-62', pathSuffix: '/$contractId', stacked: true);
    case FieldReportKind.quantity:
      contractId == null ? openScreen(context, 'MOB-61', stacked: true) : openScreen(context, 'MOB-63', pathSuffix: '/$contractId', stacked: true);
  }
}

/// The contract to offer first: the one worked on last in this run, else the one of the newest diary on the phone, else the only contract
/// the person has. Null when none is known (the form of a contract is then reached through the list).
String? recentFieldContract({required String? last, required Iterable<LocalDiary> diaries, required Map<String, String> codes}) {
  if (last != null) return last;
  for (final LocalDiary diary in diaries) {
    if (diary.contractId != null) return diary.contractId;
  }
  return codes.length == 1 ? codes.keys.single : null;
}

/// The content of the sheet.
class FieldReportSheet extends ConsumerWidget {
  const FieldReportSheet({required this.onChosen, super.key});

  final void Function(FieldReportKind kind, String? contractId) onChosen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final Map<String, String> codes = ref.watch(contractCodesProvider).value ?? const <String, String>{};
    final AsyncValue<DraftStore> drafts = ref.watch(draftStoreProvider);
    final List<QueuedCommand> commands = ref.watch(queuedCommandsProvider).value ?? const <QueuedCommand>[];
    final List<LocalDiary> diaries = drafts.hasValue ? localDiaries(drafts.requireValue.list(kind: kDiaryDraftKind), commands) : const <LocalDiary>[];
    final String? contractId = recentFieldContract(last: ref.watch(lastFieldContractProvider), diaries: diaries, codes: codes);
    final String? code = contractId == null ? null : codes[contractId];
    final bool offline = ref.watch(reachabilityProvider) == Reachability.offline;
    Widget row(FieldReportKind kind, IconData icon, String title, String hint, {bool first = false}) => WorkRow(
          title: title,
          subtitle: hint,
          leading: _Glyph(icon: icon),
          dividerAbove: !first,
          onTap: () => onChosen(kind, contractId),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (code != null)
          Padding(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s8),
            child: Row(
              children: <Widget>[
                Expanded(child: Text(context.t('mob.field.report.project', <String, Object>{'contract': code}), style: text.caption.copyWith(color: v2.palette.ink2))),
                TapTarget(
                  onTap: () => onChosen(FieldReportKind.diary, null),
                  alignment: Alignment.center,
                  child: Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s8), child: Text(context.t('mob.field.report.change'), style: text.label.copyWith(color: v2.palette.primaryStrong))),
                ),
              ],
            ),
          )
        else
          Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s8), child: Text(context.t('mob.field.report.choose'), style: text.caption.copyWith(color: v2.palette.ink2))),
        row(FieldReportKind.photo, Icons.photo_camera_outlined, context.t('mob.field.report.photo.title'), context.t('mob.field.report.photo.hint'), first: true),
        row(FieldReportKind.issue, Icons.report_problem_outlined, context.t('mob.field.report.issue.title'), context.t('mob.field.report.issue.hint')),
        row(FieldReportKind.diary, Icons.edit_note_outlined, context.t('mob.field.report.diary.title'), context.t('mob.field.report.diary.hint')),
        row(FieldReportKind.quantity, Icons.straighten_outlined, context.t('mob.field.report.quantity.title'), context.t('mob.field.report.quantity.hint')),
        if (offline) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s12), child: Text(context.t('mob.field.report.offline'), style: text.caption.copyWith(color: v2.palette.infoFg))),
      ],
    );
  }
}

class _Glyph extends StatelessWidget {
  const _Glyph({required this.icon});

  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return ExcludeSemantics(
      child: SizedBox(
        width: MachvonV2Size.glyph,
        height: MachvonV2Size.glyph,
        child: Material(
          color: v2.palette.primarySoft,
          borderRadius: BorderRadius.circular(MachvonV2Radius.glyph),
          child: Icon(icon, size: 24, color: v2.palette.primaryStrong),
        ),
      ),
    );
  }
}
