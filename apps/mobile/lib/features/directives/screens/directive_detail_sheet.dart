import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/typography.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../directive_models.dart';
import '../labels.dart';

/// Opens the read-only detail of a directive over the list: its timeline, the requests to move the due day and the evidence. The phone gives no
/// command in this round (noting progress, extending and closing are done on the computer), so the sheet only reads.
Future<void> showDirectiveDetail(BuildContext context, DirectiveLine line) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (BuildContext sheet) => FractionallySizedBox(heightFactor: 0.92, child: DirectiveDetailSheet(line: line)),
  );
}

class DirectiveDetailSheet extends StatelessWidget {
  const DirectiveDetailSheet({required this.line, super.key});

  final DirectiveLine line;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Semantics(header: true, child: Text(context.t('mob.dir.detail.title', <String, Object>{'code': line.code}), style: text.heading)),
              ),
              IconButton(tooltip: context.t('mob.dir.detail.close'), icon: const Icon(Icons.close), onPressed: () => Navigator.of(context).maybePop()),
            ],
          ),
        ),
        Expanded(
          child: DataView<DirectiveDetail>(
            cacheKey: 'directives.detail.${line.id}',
            read: (MachvonApiClient client) async => client.execute('getDirective', path: <String, Object?>{'id': line.id}),
            parse: parseDirectiveDetail,
            asOf: (DirectiveDetail detail) => detail.asOf,
            builder: (BuildContext context, Loaded<DirectiveDetail> loaded) => _Body(detail: loaded.value),
          ),
        ),
      ],
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.detail});

  final DirectiveDetail detail;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final DirectiveLine line = detail.directive;
    final String? clock = directiveClockLabel(context, line);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        SectionCard(
          title: line.code,
          children: <Widget>[
            Text(line.text, style: text.bodyStrong),
            const SizedBox(height: MachvonV2Space.s8),
            Wrap(
              spacing: MachvonV2Space.s8,
              runSpacing: MachvonV2Space.s4,
              children: <Widget>[
                StatusPill(label: directiveStatusLabel(context, line.status), tone: directiveStatusTone(line.status)),
                if (clock != null) StatusPill(label: clock, tone: directiveClockTone(line.phase)),
              ],
            ),
            const SizedBox(height: MachvonV2Space.s8),
            if (detail.meetingCode.isNotEmpty) Text(context.t('mob.dir.detail.meeting', <String, Object>{'code': detail.meetingCode}), style: text.caption),
            Text(context.t('mob.dir.row.unit', <String, Object>{'unit': line.assigneeUnit}), style: text.caption),
            Text(line.assignee == null ? context.t('mob.dir.row.personNone') : context.t('mob.dir.row.person', <String, Object>{'name': line.assignee!}), style: text.caption),
            Text(context.t('mob.dir.detail.dueNow', <String, Object>{'due': formatDay(line.dueOn)}), style: text.caption),
            if (detail.originalDueOn != line.dueOn) Text(context.t('mob.dir.detail.dueOriginal', <String, Object>{'due': formatDay(detail.originalDueOn)}), style: text.caption),
            if (detail.extensionCount > 0) Text(context.t('mob.dir.detail.extensions', <String, Object>{'count': detail.extensionCount}), style: text.caption),
            Text(context.t('mob.dir.detail.evidenceCount', <String, Object>{'count': line.evidenceCount}), style: text.caption),
            if (detail.asOf != null) Text(context.t('mob.read.asOf.line', <String, Object>{'time': asOfLabel(detail.asOf!)}), style: text.caption),
          ],
        ),
        SectionCard(
          title: context.t('mob.dir.detail.timeline.title'),
          children: <Widget>[for (final DirectiveEvent event in detail.events) _EventRow(event: event)],
        ),
        if (detail.extensions.isNotEmpty)
          SectionCard(
            title: context.t('mob.dir.detail.extension.title'),
            children: <Widget>[for (final DirectiveExtension extension in detail.extensions) _ExtensionRow(extension: extension)],
          ),
        if (detail.evidence.isNotEmpty)
          SectionCard(
            title: context.t('mob.dir.detail.evidence.title'),
            children: <Widget>[
              for (final DirectiveEvidence item in detail.evidence)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
                  child: Text(
                    context.t('mob.dir.detail.evidence.line', <String, Object>{
                      'title': item.title ?? context.t('mob.dir.detail.evidence.untitled'),
                      'name': item.addedBy,
                      'time': item.addedAt.isEmpty ? '' : formatMoment(item.addedAt),
                    }),
                    style: text.body,
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event});

  final DirectiveEvent event;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final List<String> facts = <String>[
      if (event.progressPct != null) context.t('mob.dir.event.pct', <String, Object>{'pct': event.progressPct!}),
      if (event.fromDueOn != null && event.toDueOn != null) context.t('mob.dir.event.dueMove', <String, Object>{'from': formatDay(event.fromDueOn!), 'to': formatDay(event.toDueOn!)}),
      if (event.toUnit != null && event.kind == DirectiveEventKind.assigned) context.t('mob.dir.event.toUnit', <String, Object>{'unit': event.toUnit!}),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(directiveEventLabel(context, event.kind), style: text.label),
            Text(context.t('mob.dir.detail.timeline.by', <String, Object>{'name': event.actor, 'time': formatMoment(event.at)}), style: text.caption),
            for (final String fact in facts) Text(fact, style: text.caption),
            if (event.note != null) Text(event.note!, style: text.body),
          ],
        ),
      ),
    );
  }
}

class _ExtensionRow extends StatelessWidget {
  const _ExtensionRow({required this.extension});

  final DirectiveExtension extension;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Wrap(spacing: MachvonV2Space.s8, children: <Widget>[StatusPill(label: extensionStateLabel(context, extension.state), tone: extension.state == ExtensionState.approved ? MachvonTone.success : (extension.state == ExtensionState.rejected ? MachvonTone.danger : MachvonTone.warning))]),
            Text(
              context.t('mob.dir.detail.extension.line', <String, Object>{'from': formatDay(extension.fromDueOn), 'to': formatDay(extension.proposedDueOn), 'reason': extension.reason}),
              style: text.body,
            ),
            Text(context.t('mob.dir.detail.extension.by', <String, Object>{'name': extension.requestedBy}), style: text.caption),
            if (extension.decidedBy != null) Text(context.t('mob.dir.detail.extension.decided', <String, Object>{'name': extension.decidedBy!, 'reason': extension.decisionReason ?? ''}), style: text.caption),
          ],
        ),
      ),
    );
  }
}
