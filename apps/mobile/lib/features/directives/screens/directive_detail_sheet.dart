import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/deadline.dart';
import '../../../core/widgets/sheets.dart';
import '../../../core/widgets/timeline.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../directive_models.dart';
import '../labels.dart';

/// Opens the read-only detail of a directive over the list: its timeline, the requests to move the due day and the evidence. The phone gives no
/// command in this round (noting progress, extending and closing are done on the computer), so the sheet only reads.
Future<void> showDirectiveDetail(BuildContext context, DirectiveLine line) {
  return showActionSheet<void>(
    context,
    builder: (BuildContext sheet) => DirectiveDetailSheet(line: line, height: MediaQuery.sizeOf(sheet).height * 0.75),
  );
}

class DirectiveDetailSheet extends StatelessWidget {
  const DirectiveDetailSheet({required this.line, this.height = 560, super.key});

  final DirectiveLine line;

  /// The height the sheet gives the detail under its header: the sheet itself scrolls, the detail needs a bounded place.
  final double height;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Semantics(
                container: true,
                header: true,
                child: Text(context.t('mob.dir.detail.title', <String, Object>{'code': line.code}), style: context.v2text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap)),
              ),
            ),
            AppBarAction(icon: Icons.close, label: context.t('mob.dir.detail.close'), onPressed: () => Navigator.of(context).maybePop()),
          ],
        ),
        SizedBox(
          height: height,
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
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                StatusPill(label: directiveStatusLabel(context, line.status), tone: directiveStatusTone(line.status)),
                if (clock != null) DeadlineLabel(band: directiveBandOf(line.phase), text: clock, dueDay: line.dueOn),
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
          children: <Widget>[TimelineList(entries: <TimelineEntry>[for (final DirectiveEvent event in detail.events) _entry(context, event)])],
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

/// One event of the directive as an entry of the timeline: what happened, who and when, then the facts of the event and the note, one under the other.
TimelineEntry _entry(BuildContext context, DirectiveEvent event) {
  final List<String> lines = <String>[
    if (event.progressPct != null) context.t('mob.dir.event.pct', <String, Object>{'pct': event.progressPct!}),
    if (event.fromDueOn != null && event.toDueOn != null) context.t('mob.dir.event.dueMove', <String, Object>{'from': formatDay(event.fromDueOn!), 'to': formatDay(event.toDueOn!)}),
    if (event.toUnit != null && event.kind == DirectiveEventKind.assigned) context.t('mob.dir.event.toUnit', <String, Object>{'unit': event.toUnit!}),
    if (event.note != null) event.note!,
  ];
  return TimelineEntry(
    title: directiveEventLabel(context, event.kind),
    when: context.t('mob.dir.detail.timeline.by', <String, Object>{'name': event.actor, 'time': formatMoment(event.at)}),
    detail: lines.isEmpty ? null : lines.join('\n'),
    icon: directiveEventIcon(event.kind),
  );
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
            Wrap(
              spacing: MachvonV2Space.s8,
              children: <Widget>[StatusPill(label: extensionStateLabel(context, extension.state), tone: extensionStateTone(extension.state))],
            ),
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
