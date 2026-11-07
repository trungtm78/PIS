import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/navigation/route_catalogue.dart';
import '../../../core/navigation/tab_badges.dart';
import '../../../core/state/empty_state_view.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
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
    return ScreenFrame(
      title: context.t('mob.apv.inbox.title'),
      actions: <Widget>[
        IconButton(tooltip: context.t('mob.apv.inbox.acceptance.action'), icon: const Icon(Icons.fact_check_outlined), onPressed: () => openScreen(context, 'MOB-65', stacked: true)),
        IconButton(tooltip: context.t('mob.apv.inbox.signDocs.action'), icon: const Icon(Icons.draw_outlined), onPressed: () => openScreen(context, 'DOC-22', stacked: true)),
        IconButton(tooltip: context.t('mob.apv.inbox.incomingDocs.action'), icon: const Icon(Icons.move_to_inbox_outlined), onPressed: () => openScreen(context, 'DOC-23', stacked: true)),
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

class _InboxBody extends StatelessWidget {
  const _InboxBody({required this.inbox, required this.filter, required this.onFilter});

  final ApprovalInbox inbox;
  final InboxFilter filter;
  final ValueChanged<InboxFilter> onFilter;

  @override
  Widget build(BuildContext context) {
    final List<ApprovalTask> shown = applyInboxFilter(inbox.tasks, filter);
    final List<Widget> header = <Widget>[
      Padding(
        padding: const EdgeInsets.all(MachvonSpace.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(context.t('mob.apv.inbox.counts', <String, Object>{'open': inbox.tasks.length, 'late': inbox.overdueCount}), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: MachvonSpace.space12),
            DropdownButtonFormField<String?>(
              initialValue: filter.businessType,
              isExpanded: true,
              decoration: InputDecoration(labelText: context.t('mob.apv.inbox.filter.type')),
              items: <DropdownMenuItem<String?>>[
                DropdownMenuItem<String?>(child: Text(context.t('mob.apv.inbox.filter.all'))),
                for (final String type in businessTypes) DropdownMenuItem<String?>(value: type, child: Text(businessTypeLabel(context, type))),
              ],
              onChanged: (String? type) => onFilter(InboxFilter(businessType: type, onlyOverdue: filter.onlyOverdue)),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: filter.onlyOverdue,
              title: Text(context.t('mob.apv.inbox.filter.late')),
              onChanged: (bool? value) => onFilter(InboxFilter(businessType: filter.businessType, onlyOverdue: value ?? false)),
            ),
          ],
        ),
      ),
    ];
    if (shown.isEmpty) {
      return Column(
        children: <Widget>[
          ...header,
          Expanded(
            child: EmptyStateView(
              activeFilters: <String>[
                if (filter.businessType != null) businessTypeLabel(context, filter.businessType!),
                if (filter.onlyOverdue) context.t('mob.apv.inbox.filter.late'),
              ],
              onClearFilters: () => onFilter(const InboxFilter()),
            ),
          ),
        ],
      );
    }
    return ListView.builder(
      itemCount: header.length + shown.length,
      itemBuilder: (BuildContext context, int index) => index < header.length ? header[index] : _TaskRow(task: shown[index - header.length], unitName: inbox.unitNames[shown[index - header.length].unitId]),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task, required this.unitName});

  final ApprovalTask task;
  final String? unitName;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String type = businessTypeLabel(context, task.businessType);
    final String due = formatMoment(task.dueAt);
    return TappableRow(
      semanticLabel: context.t('mob.apv.inbox.row.aria', <String, Object>{'type': type, 'step': task.stepName, 'time': due}),
      onTap: () => openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(task.id)}'),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(type, style: theme.textTheme.bodyLarge),
                if (task.stepName.isNotEmpty) Text(task.stepName, style: theme.textTheme.bodyMedium),
                Wrap(
                  spacing: MachvonSpace.space8,
                  children: <Widget>[
                    if (task.overdue) StatusPill(label: context.t('mob.apv.inbox.row.late'), warn: true),
                    if (task.escalated) StatusPill(label: context.t('mob.apv.inbox.row.escalated')),
                    if (!task.canDecide) StatusPill(label: context.t('mob.apv.inbox.row.cannot')),
                  ],
                ),
                if (task.amountVnd != null) Text(context.t('mob.apv.inbox.row.amount', <String, Object>{'value': millionsLabel(context, task.amountVnd)}), style: theme.textTheme.bodySmall),
                if (unitName != null) Text(context.t('mob.apv.inbox.row.unit', <String, Object>{'unit': unitName!}), style: theme.textTheme.bodySmall),
                Text(context.t('mob.apv.inbox.row.due', <String, Object>{'time': due}), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
