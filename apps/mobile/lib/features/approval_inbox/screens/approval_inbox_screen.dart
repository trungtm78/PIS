import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/route_catalogue.dart';
import '../../../core/navigation/tab_badges.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/wire.dart';
import '../approval_models.dart';
import '../approval_support.dart';

/// MOB-23: the approvals waiting for the person, the late ones first. A row opens the detail (MOB-24); there is no swipe and no
/// one-tap way to approve from the list. The number of tasks waiting is the badge of the Approvals tab.
Widget buildApprovalInboxScreen(BuildContext context, ScreenContext screen) => const ApprovalInboxScreen();

class ApprovalInboxScreen extends ConsumerStatefulWidget {
  const ApprovalInboxScreen({super.key});

  @override
  ConsumerState<ApprovalInboxScreen> createState() => _ApprovalInboxScreenState();
}

class _ApprovalInboxScreenState extends ConsumerState<ApprovalInboxScreen> {
  InboxFilter _filter = const InboxFilter();

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      largeTitle: context.t('mob.apv.inbox.title'),
      actions: <Widget>[
        AppBarAction(icon: Icons.fact_check_outlined, label: context.t('mob.apv.inbox.acceptance.action'), onPressed: () => openScreen(context, 'MOB-65', stacked: true)),
        AppBarAction(icon: Icons.draw_outlined, label: context.t('mob.apv.inbox.signDocs.action'), onPressed: () => openScreen(context, 'DOC-22', stacked: true)),
        AppBarAction(icon: Icons.move_to_inbox_outlined, label: context.t('mob.apv.inbox.incomingDocs.action'), onPressed: () => openScreen(context, 'DOC-23', stacked: true)),
      ],
      body: DataView<ApprovalInbox>(
        cacheKey: 'approvals.inbox',
        reloadKey: ref.watch(approvalsChangedProvider),
        read: _read,
        parse: parseApprovalInbox,
        asOf: (ApprovalInbox inbox) => inbox.asOf,
        isEmpty: (ApprovalInbox inbox) => inbox.tasks.isEmpty,
        onLoaded: (Loaded<ApprovalInbox> loaded) => ref.read(tabBadgeProvider.notifier).set(AppTab.approval, loaded.value.tasks.length),
        builder: (BuildContext context, Loaded<ApprovalInbox> loaded) {
          return _InboxBody(
            inbox: loaded.value,
            filter: _filter,
            onFilter: (InboxFilter next) => setState(() => _filter = next),
          );
        },
      ),
    );
  }

  /// The tasks given to the person that still wait, then the names of the units (best effort: a unit the reader may not read
  /// is left without a name, and a lost connection fails the read so that the copy is shown).
  static Future<Object?> _read(MachvonApiClient client) async {
    final Json tasks = await readMerged(client, 'get_resources_approval_task', query: <String, Object?>{'mine': 'true', 'status': 'Pending', 'limit': 200});
    Json? units;
    try {
      units = await readMerged(client, 'get_resources_organization_unit', query: <String, Object?>{'limit': 200});
    } on ApiError catch (error) {
      if (error.code == networkErrorCode) rethrow;
    }
    return <String, Object?>{'items': tasks['items'], 'as_of': tasks['as_of'], 'units': units};
  }
}

/// The chip that is on: every task, the late ones, or one kind of record. One chip at a time; the late ones always head the list, so a kind
/// of record keeps its late tasks on top.
const String _chipAll = '';
const String _chipLate = '!late';

InboxFilter _filterOfChip(String chip) {
  if (chip == _chipAll) return const InboxFilter();
  if (chip == _chipLate) return const InboxFilter(onlyOverdue: true);
  return InboxFilter(businessType: chip);
}

String _chipOfFilter(InboxFilter filter) {
  if (filter.businessType != null) return filter.businessType!;
  return filter.onlyOverdue ? _chipLate : _chipAll;
}

class _InboxBody extends StatelessWidget {
  const _InboxBody({required this.inbox, required this.filter, required this.onFilter});

  final ApprovalInbox inbox;
  final InboxFilter filter;
  final ValueChanged<InboxFilter> onFilter;

  @override
  Widget build(BuildContext context) {
    final List<ApprovalTask> shown = applyInboxFilter(inbox.tasks, filter);
    final List<ApprovalTask> late = <ApprovalTask>[for (final ApprovalTask task in shown) if (task.overdue) task];
    final List<ApprovalTask> open = <ApprovalTask>[for (final ApprovalTask task in shown) if (!task.overdue) task];
    final List<ChipOption<String>> chips = <ChipOption<String>>[
      ChipOption<String>(value: _chipAll, label: context.t('mob.apv.inbox.filter.all'), count: inbox.tasks.length),
      if (inbox.overdueCount > 0) ChipOption<String>(value: _chipLate, label: context.t('mob.apv.inbox.chip.late'), count: inbox.overdueCount),
      for (final String type in businessTypes)
        if (inbox.tasks.any((ApprovalTask task) => task.businessType == type))
          ChipOption<String>(value: type, label: businessTypeLabel(context, type), count: inbox.tasks.where((ApprovalTask task) => task.businessType == type).length),
    ];
    final String chip = _chipOfFilter(filter);
    final MachvonV2Text text = context.v2text;
    return ListView(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(left: MachvonV2Space.s16, right: MachvonV2Space.s16, bottom: MachvonV2Space.s4),
          child: Text(
            context.t('mob.apv.inbox.counts', <String, Object>{'open': inbox.tasks.length, 'late': inbox.overdueCount}),
            style: text.caption.copyWith(color: context.v2.palette.ink2),
          ),
        ),
        FilterChips<String>(options: chips, selected: chip, onChanged: (String next) => onFilter(_filterOfChip(next))),
        if (shown.isEmpty)
          SizedBox(
            height: 360,
            child: StateView(
              kind: StateKind.empty,
              title: context.t('mob.apv.inbox.empty.title'),
              body: context.t('mob.apv.inbox.empty.body', <String, Object>{
                'filters': <String>[
                  if (filter.businessType != null) businessTypeLabel(context, filter.businessType!),
                  if (filter.onlyOverdue) context.t('mob.apv.inbox.chip.late'),
                ].join(', '),
              }),
              actionLabel: context.t('mob.apv.inbox.empty.clear'),
              onAction: () => onFilter(const InboxFilter()),
            ),
          ),
        if (late.isNotEmpty) GroupHeader(title: context.t('mob.apv.inbox.group.late'), count: late.length),
        for (int index = 0; index < late.length; index += 1) ApprovalRow(task: late[index], unitName: inbox.unitNames[late[index].unitId], dividerAbove: index > 0),
        if (open.isNotEmpty) GroupHeader(title: context.t('mob.apv.inbox.group.open'), count: open.length),
        for (int index = 0; index < open.length; index += 1) ApprovalRow(task: open[index], unitName: inbox.unitNames[open[index].unitId], dividerAbove: index > 0),
      ],
    );
  }
}

/// One approval waiting: the kind of record, the step, the unit and the amount (rounded to one decimal; the detail says it in full), the
/// deadline with its real day and whether it is overdue (the server's word, never the clock of the phone). It carries what a person needs
/// to know whether to open it; the decision itself is made on the detail, behind a confirmation.
class ApprovalRow extends StatelessWidget {
  const ApprovalRow({required this.task, required this.unitName, this.dividerAbove = false, super.key});

  final ApprovalTask task;
  final String? unitName;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String type = businessTypeLabel(context, task.businessType);
    final String due = formatMoment(task.dueAt);
    final String? amount = task.amountVnd == null ? null : moneyLabel(context, task.amountVnd, decimals: 1);
    final DeadlineBand band = approvalBandOf(task);
    final MachvonV2Text text = context.v2text;
    final String subtitle = <String>[
      if (task.stepName.isNotEmpty) task.stepName,
      if (unitName != null) unitName!,
      ?amount,
    ].join(' · ');
    final String spoken = <String>[
      type,
      if (task.stepName.isNotEmpty) task.stepName,
      if (unitName != null) context.t('mob.apv.inbox.row.unit', <String, Object>{'unit': unitName!}),
      if (task.amountVnd != null) context.t('mob.apv.inbox.row.amount', <String, Object>{'value': moneyLabel(context, task.amountVnd)}),
      if (task.overdue) context.t('mob.apv.inbox.row.late'),
      if (task.escalated) context.t('mob.apv.inbox.row.escalated'),
      if (!task.canDecide) context.t('mob.apv.inbox.row.cannot'),
      context.t('mob.apv.inbox.row.due', <String, Object>{'time': due}),
    ].join('. ');
    return WorkRow(
      title: type,
      subtitle: subtitle.isEmpty ? null : subtitle,
      leading: DeadlineGlyph(band: band),
      trailing: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          DeadlineLabel(
            band: band,
            text: task.overdue ? context.t('mob.apv.inbox.row.late') : context.t('mob.apv.inbox.row.dueShort', <String, Object>{'day': formatDayShort(task.dueAt)}),
            dueDay: task.dueAt,
          ),
          if (task.overdue) Text(context.t('mob.apv.inbox.row.dueShort', <String, Object>{'day': formatDayShort(task.dueAt)}), style: text.caption),
          if (task.escalated) Text(context.t('mob.apv.inbox.row.escalated'), style: text.caption, textAlign: TextAlign.end),
          if (!task.canDecide) Text(context.t('mob.apv.inbox.row.viewOnly'), style: text.caption),
        ],
      ),
      semanticLabel: spoken,
      dividerAbove: dividerAbove,
      onTap: () => openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(task.id)}'),
    );
  }
}
