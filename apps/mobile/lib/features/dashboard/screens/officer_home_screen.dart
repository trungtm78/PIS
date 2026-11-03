import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../my_work.dart';

/// The page size of the work list; the screen follows the pages to the end (or to the limit of pages).
const int workPageSize = 50;

/// MOB-08: the home of a reporting officer. What is asked of the person who opens it, in every module, in one place: the
/// report deadlines and the reports that came back, the drafts past their period, and the work given to them. Late first.
/// Read-only: each task is done in the screen of its module; only an approval task opens here (MOB-24).
Widget buildOfficerHomeScreen(BuildContext context, ScreenContext screen) => const OfficerHomeScreen();

class OfficerHomeScreen extends StatelessWidget {
  const OfficerHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.home.officer.title'),
      body: DataView<MyWork>(
        cacheKey: 'home.work',
        read: (MachvonApiClient client) => readMerged(client, 'getMyWork', query: <String, Object?>{'limit': workPageSize}),
        parse: parseMyWork,
        isEmpty: (MyWork work) => work.items.isEmpty,
        builder: (BuildContext context, loaded) => _WorkBody(work: loaded.value),
      ),
    );
  }
}

const Set<WorkKind> _deadlineKinds = <WorkKind>{WorkKind.reportReturned, WorkKind.mneObligation};
const Set<WorkKind> _draftKinds = <WorkKind>{WorkKind.reportDraftOverdue};

class _WorkBody extends StatelessWidget {
  const _WorkBody({required this.work});

  final MyWork work;

  @override
  Widget build(BuildContext context) {
    final List<WorkItem> deadlines = work.ofKinds(_deadlineKinds);
    final List<WorkItem> drafts = work.ofKinds(_draftKinds);
    final List<WorkItem> assigned = <WorkItem>[
      for (final WorkItem item in work.items)
        if (!_deadlineKinds.contains(item.kind) && !_draftKinds.contains(item.kind)) item,
    ];
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.home.work.summary', <String, Object>{'total': work.total, 'overdue': work.overdue}),
          children: <Widget>[
            if (work.truncated) StatusPill(label: context.t('mob.home.work.truncated'), warn: true),
            for (final WorkKind kind in WorkKind.values)
              if (work.countOf(_countKey(kind)) > 0) FactLine(label: _kindLabel(context, kind), value: '${work.countOf(_countKey(kind))}'),
          ],
        ),
        _Group(title: context.t('mob.home.work.deadlines.title'), items: deadlines),
        _Group(title: context.t('mob.home.work.drafts.title'), items: drafts),
        _Group(title: context.t('mob.home.work.assigned.title'), items: assigned),
        TappableRow(
          semanticLabel: context.t('mob.home.link.unreported'),
          onTap: () => openScreen(context, 'MOB-57'),
          child: Row(
            children: <Widget>[
              Expanded(child: Text(context.t('mob.home.link.unreported'), style: Theme.of(context).textTheme.bodyLarge)),
              const ExcludeSemantics(child: Icon(Icons.chevron_right)),
            ],
          ),
        ),
      ],
    );
  }
}

String _countKey(WorkKind kind) {
  switch (kind) {
    case WorkKind.approval:
      return 'APPROVAL';
    case WorkKind.explanation:
      return 'EXPLANATION';
    case WorkKind.reportReturned:
      return 'REPORT_RETURNED';
    case WorkKind.reportDraftOverdue:
      return 'REPORT_DRAFT_OVERDUE';
    case WorkKind.explanationReview:
      return 'EXPLANATION_REVIEW';
    case WorkKind.mneObligation:
      return 'MNE_OBLIGATION';
  }
}

String _kindLabel(BuildContext context, WorkKind kind) {
  switch (kind) {
    case WorkKind.approval:
      return context.t('mob.home.work.kind.approval');
    case WorkKind.explanation:
      return context.t('mob.home.work.kind.explanation');
    case WorkKind.reportReturned:
      return context.t('mob.home.work.kind.reportReturned');
    case WorkKind.reportDraftOverdue:
      return context.t('mob.home.work.kind.reportDraft');
    case WorkKind.explanationReview:
      return context.t('mob.home.work.kind.explanationReview');
    case WorkKind.mneObligation:
      return context.t('mob.home.work.kind.mne');
  }
}

String _bucketLabel(BuildContext context, WorkBucket bucket) {
  switch (bucket) {
    case WorkBucket.overdue:
      return context.t('mob.home.work.bucket.overdue');
    case WorkBucket.near:
      return context.t('mob.home.work.bucket.near');
    case WorkBucket.later:
      return context.t('mob.home.work.bucket.later');
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.items});

  final String title;
  final List<WorkItem> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: '$title (${items.length})',
      children: <Widget>[for (final WorkItem item in items) _WorkCard(item: item)],
    );
  }
}

class _WorkCard extends StatelessWidget {
  const _WorkCard({required this.item});

  final WorkItem item;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String due = item.dueOn == null ? context.t('mob.home.work.due.none') : context.t('mob.home.work.due.on', <String, Object>{'date': asOfLabel(item.dueOn!)});
    final String late = item.bucket == WorkBucket.overdue ? ', ${context.t('mob.home.work.due.late', <String, Object>{'days': item.daysLate})}' : '';
    final String moved = item.dueMoved ? ', ${context.t('mob.home.work.due.original', <String, Object>{'date': asOfLabel(item.originalDueOn!)})}' : '';
    final String kind = _kindLabel(context, item.kind);
    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Wrap(spacing: MachvonSpace.space8, children: <Widget>[StatusPill(label: kind), StatusPill(label: _bucketLabel(context, item.bucket), warn: item.bucket == WorkBucket.overdue)]),
        Text(item.title, style: theme.textTheme.bodyLarge),
        if (item.subtitle != null) Text(item.subtitle!, style: theme.textTheme.bodySmall),
        Text('$due$late$moved', style: theme.textTheme.bodySmall),
      ],
    );
    if (!item.opensApproval) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8), child: body);
    }
    return TappableRow(
      semanticLabel: context.t('mob.home.work.open.aria', <String, Object>{'title': item.title}),
      onTap: () => openScreen(context, 'MOB-24', pathSuffix: '/${Uri.encodeComponent(item.targetId)}'),
      child: Row(children: <Widget>[Expanded(child: body), const ExcludeSemantics(child: Icon(Icons.chevron_right))]),
    );
  }
}
