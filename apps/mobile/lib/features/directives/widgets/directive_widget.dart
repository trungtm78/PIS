import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/widgets/figure_info.dart';
import '../../read_support/amounts.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../directive_models.dart';
import '../labels.dart';
import '../screens/directive_detail_sheet.dart';

/// The screen that lists the directives (DIR-06): the way in from the summary of the dashboard.
const String kDirectiveListScreenId = 'DIR-06';

/// The definition behind one count of the widget: the formula the server gave it, and where and when it was counted. The thresholds the counts depend
/// on are the policy of the tenant; when it is a starting value the definition says so.
FigureInfo _definition(
  BuildContext context, {
  required String name,
  required String formula,
  required DirectiveWidgetData data,
}) => FigureInfo(
  name: name,
  formula: formula,
  source: context.t('mob.dir.widget.source.text'),
  asOf: asOfLabel(data.asOf),
  owner: context.t('mob.dir.widget.owner.text'),
  unverified: data.policy.unverified,
);

/// The summary of the directives of the steering meetings on the phone home of a leader (DIR-1, roadmap CN.03 and QT.02, the web's `DirectiveWidget`): how
/// many directives are overdue, raised to the head of the unit and due soon, the oldest overdue ones, and the way to the list. Every count has its "i"
/// (formula, source, time, policy). It is told apart from the rest of the home: a failure to read it is named here, with a retry, and is never "no
/// directive is late"; a reader with no right to read directives is told so in words.
class DirectiveWidgetCard extends StatelessWidget {
  const DirectiveWidgetCard({
    required this.data,
    required this.errorCode,
    required this.onRetry,
    super.key,
  });

  /// The directives, or null when they could not be read.
  final DirectiveWidgetData? data;

  /// The stable code of the failure when [data] is null.
  final String? errorCode;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final DirectiveWidgetData? read = data;
    if (read == null) {
      return SectionCard(
        title: context.t('mob.dir.widget.title'),
        children: <Widget>[
          Semantics(
            liveRegion: true,
            container: true,
            child:
                errorCode == 'PERMISSION_DENIED' || errorCode == 'SCOPE_DENIED'
                ? Text(
                    context.t('mob.dir.widget.denied.text'),
                    style: theme.textTheme.bodyMedium,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        context.t('mob.dir.widget.error.text', <String, Object>{
                          'code': errorCode ?? 'UNKNOWN',
                        }),
                        style: theme.textTheme.bodyMedium,
                      ),
                      const SizedBox(height: MachvonSpace.space8),
                      OutlinedButton(
                        onPressed: onRetry,
                        child: Text(context.t('mob.dir.widget.retry.action')),
                      ),
                    ],
                  ),
          ),
        ],
      );
    }
    final String unit = context.t('mob.dir.list.summary.unit');
    final String overdueLabel = context.t('mob.dir.widget.overdue.label');
    final String escalatedLabel = context.t('mob.dir.widget.escalated.label');
    final String soonLabel = context.t('mob.dir.widget.soon.label');
    final String? overdueFormula = read.definitions['overdue'];
    final String? escalatedFormula = read.definitions['escalated'];
    final String? soonFormula = read.definitions['due_soon'];
    return SectionCard(
      title: context.t('mob.dir.widget.title'),
      children: <Widget>[
        KpiGroup(
          tiles: <Widget>[
            KpiTile(
              label: overdueLabel,
              value: '${read.overdue}',
              unit: unit,
              info: overdueFormula == null
                  ? null
                  : _definition(
                      context,
                      name: overdueLabel,
                      formula: overdueFormula,
                      data: read,
                    ),
            ),
            KpiTile(
              label: escalatedLabel,
              value: '${read.escalated}',
              unit: unit,
              info: escalatedFormula == null
                  ? null
                  : _definition(
                      context,
                      name: escalatedLabel,
                      formula: escalatedFormula,
                      data: read,
                    ),
            ),
            KpiTile(
              label: soonLabel,
              value: '${read.dueSoon}',
              unit: unit,
              info: soonFormula == null
                  ? null
                  : _definition(
                      context,
                      name: soonLabel,
                      formula: soonFormula,
                      data: read,
                    ),
            ),
          ],
        ),
        const SizedBox(height: MachvonSpace.space8),
        if (read.items.isEmpty)
          Text(
            context.t('mob.dir.widget.none.text'),
            style: theme.textTheme.bodyMedium,
          )
        else ...<Widget>[
          Semantics(
            header: true,
            child: Text(
              context.t('mob.dir.widget.items.label'),
              style: theme.textTheme.titleSmall,
            ),
          ),
          for (final DirectiveLine line in read.items) _WidgetRow(line: line),
        ],
        if (read.truncated)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(
              context.t('mob.dir.list.summary.truncated'),
              style: theme.textTheme.bodySmall,
            ),
          ),
        if (read.policy.unverified)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(
              context.t('mob.dir.list.policy.unverified'),
              style: theme.textTheme.bodySmall,
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: MachvonSpace.space8),
          child: Text(
            context.t('mob.read.asOf.line', <String, Object>{
              'time': asOfLabel(read.asOf),
            }),
            style: theme.textTheme.bodySmall,
          ),
        ),
        TappableRow(
          semanticLabel: context.t('mob.dir.widget.all.action'),
          onTap: () => openScreen(context, kDirectiveListScreenId),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  context.t('mob.dir.widget.all.action'),
                  style: theme.textTheme.bodyLarge,
                ),
              ),
              const ExcludeSemantics(child: Icon(Icons.chevron_right)),
            ],
          ),
        ),
      ],
    );
  }
}

class _WidgetRow extends StatelessWidget {
  const _WidgetRow({required this.line});

  final DirectiveLine line;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? clock = directiveClockLabel(context, line);
    final String status = directiveStatusLabel(context, line.status);
    return TappableRow(
      semanticLabel: context.t('mob.dir.row.aria', <String, Object>{
        'code': line.code,
        'status': status,
        'due': formatDay(line.dueOn),
        'text': line.text,
      }),
      onTap: () => showDirectiveDetail(context, line),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(line.code, style: theme.textTheme.titleSmall),
                Text(
                  line.text,
                  style: theme.textTheme.bodyMedium,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                Wrap(
                  spacing: MachvonSpace.space8,
                  runSpacing: MachvonSpace.space4,
                  children: <Widget>[
                    Text(
                      context.t('mob.dir.row.unit', <String, Object>{
                        'unit': line.assigneeUnit,
                      }),
                      style: theme.textTheme.bodySmall,
                    ),
                    Text(
                      context.t('mob.dir.row.due', <String, Object>{
                        'due': formatDay(line.dueOn),
                      }),
                      style: theme.textTheme.bodySmall,
                    ),
                    if (clock != null)
                      StatusPill(
                        label: clock,
                        tone: directiveClockTone(line.phase),
                        icon: line.escalated ? Icons.priority_high : null,
                      ),
                  ],
                ),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
