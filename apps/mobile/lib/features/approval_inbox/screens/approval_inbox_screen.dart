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
import '../approval_badge.dart';
import '../approval_models.dart';
import '../approval_support.dart';
import '../pending_decisions.dart';
import 'pending_decision_sheet.dart';

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
        // The first read is the answer the badge of the tab asked for when the shell came up (L9), while it is fresh; otherwise the server is asked.
        read: (MachvonApiClient client) => ref.read(approvalBadgeProvider.notifier).readForInbox(client),
        parse: parseApprovalInbox,
        asOf: (ApprovalInbox inbox) => inbox.asOf,
        isEmpty: (ApprovalInbox inbox) => inbox.waitingCount == 0 && !inbox.pendingUnavailable,
        emptyBody: context.t('mob.apv.inbox.none.body'),
        onLoaded: (Loaded<ApprovalInbox> loaded) => ref.read(tabBadgeProvider.notifier).set(AppTab.approval, loaded.value.waitingCount),
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
      ChipOption<String>(value: _chipAll, label: context.t('mob.apv.inbox.filter.all'), count: inbox.waitingCount),
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
            context.t('mob.apv.inbox.counts', <String, Object>{'open': inbox.waitingCount, 'late': inbox.overdueCount}),
            style: text.caption.copyWith(color: context.v2.palette.ink2),
          ),
        ),
        FilterChips<String>(options: chips, selected: chip, onChanged: (String next) => onFilter(_filterOfChip(next))),
        if (inbox.pendingUnavailable)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
            child: Semantics(liveRegion: true, container: true, child: Text(context.t('mob.apv.pend.unavailable'), key: const ValueKey<String>('pending-unavailable'), style: text.captionStrong.copyWith(color: context.v2.palette.soonFg))),
          ),
        if (shown.isEmpty && !(filter.isEmpty && inbox.pending.isNotEmpty))
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
        // The records of the modules that wait outside the engine are listed when nothing narrows the list: a kind or the late ones filter the tasks of the engine.
        if (filter.isEmpty && inbox.pending.isNotEmpty) GroupHeader(title: context.t('mob.apv.pend.group'), count: inbox.pending.length),
        if (filter.isEmpty)
          for (int index = 0; index < inbox.pending.length; index += 1) PendingRow(item: inbox.pending[index], dividerAbove: index > 0),
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
    final String? amount = task.amountVnd == null ? null : moneyShortLabel(context, task.amountVnd);
    final DeadlineBand band = approvalBandOf(task);
    final MachvonV2Text text = context.v2text;
    final String subtitle = <String>[
      if (task.stepName.isNotEmpty) task.stepName,
      if (unitName != null) unitName!,
      ?amount,
    ].join(' · ');
    // What the record is of (lane fix11): its project, its period, the person it is about. A row of a response to a score says which period and whose.
    final ApprovalSummary? summary = task.summary;
    final String? periodLine = summary == null ? null : summaryPeriodLine(context, summary);
    final String context_ = <String>[
      if (summary != null && summaryProjectLine(summary) != null) summaryProjectLine(summary)!,
      if (periodLine != null) context.t('mob.apv.sum.inbox.period', <String, Object>{'period': periodLine}),
      if (summary?.subjectName != null) context.t('mob.apv.sum.inbox.subject', <String, Object>{'name': summary!.subjectName!}),
    ].join(' · ');
    // What tells two tasks of one kind apart (six weekly reports read alike otherwise): who sent the record, and the day it was sent.
    final String sender = <String>[
      if (task.initiatorName != null) context.t('mob.apv.inbox.row.sender', <String, Object>{'name': task.initiatorName!}),
      if (task.submittedAt != null) context.t('mob.apv.inbox.row.sent', <String, Object>{'day': formatDay(task.submittedAt!, language: Localizations.localeOf(context).languageCode)}),
    ].join(' · ');
    final String spoken = <String>[
      type,
      if (task.stepName.isNotEmpty) task.stepName,
      if (context_.isNotEmpty) context_,
      if (sender.isNotEmpty) sender,
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
      footer: sender.isEmpty && context_.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (context_.isNotEmpty) Text(context_, style: text.caption),
                if (sender.isNotEmpty) Text(sender, style: text.caption),
              ],
            ),
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

/// One record that waits outside the approval engine (PWF 20.9): the kind, the project or the person, who sent it and the day. It opens as a sheet that reads the record in full
/// and offers the decisions its own command takes; no decision is made from the list.
class PendingRow extends StatelessWidget {
  const PendingRow({required this.item, this.dividerAbove = false, super.key});

  final PendingDecision item;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String kind = pendingKindLabel(context, item.kind);
    final ApprovalSummary summary = item.summary;
    final String? project = summaryProjectLine(summary);
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final String subtitle = <String>[?project, ?summary.subjectName, ?summary.unitName].join(' · ');
    final String sender = <String>[
      if (item.initiatorName != null) context.t('mob.apv.inbox.row.sender', <String, Object>{'name': item.initiatorName!}),
      context.t('mob.apv.inbox.row.sent', <String, Object>{'day': formatDay(item.submittedAt, language: language)}),
    ].join(' · ');
    final String spoken = <String>[kind, if (subtitle.isNotEmpty) subtitle, sender, context.t('mob.apv.pend.row.waiting')].join('. ');
    return WorkRow(
      title: kind,
      subtitle: subtitle.isEmpty ? null : subtitle,
      footer: Text(sender, style: text.caption),
      leading: const DeadlineGlyph(band: DeadlineBand.ok),
      trailing: Text(context.t('mob.apv.pend.row.waiting'), style: text.caption, textAlign: TextAlign.end),
      semanticLabel: spoken,
      dividerAbove: dividerAbove,
      onTap: () => showPendingDecisionSheet(context, item),
    );
  }
}
