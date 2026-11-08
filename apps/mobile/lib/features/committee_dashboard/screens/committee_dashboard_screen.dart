import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../dashboard/committee_workspace.dart';
import '../../dashboard/widgets/committee_card.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/money.dart';
import '../../read_support/widgets.dart';
import '../committee_dashboard.dart';

/// MOB-72: the dashboard of the head of the provincial steering committee on the phone. It only reads. One read of `getCommitteeWorkspace` gives the
/// figures of the province, the progress by sector, district, investor and funding source, the projects that need attention, the units that do not
/// report, the directives that are late and the live alerts. The server writes one row of the log of views for every read, so the screen reads when
/// it opens and when the person presses refresh, never on a timer, and keeps no copy on the device (the workspace is confidential). A reader without
/// the right to the committee sees the refusal, not an empty page. A colour is always said in words and with a shape.
Widget buildCommitteeDashboardScreen(BuildContext context, ScreenContext screen) => const CommitteeDashboardScreen();

class CommitteeDashboardScreen extends StatelessWidget {
  const CommitteeDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.ban.dashboard.title'),
      body: DataView<CommitteeDashboard>(
        cacheKey: 'committee.dashboard',
        keepCopy: false,
        read: readCommitteeWorkspace,
        parse: parseCommitteeDashboard,
        asOf: (CommitteeDashboard dashboard) => dashboard.workspace.asOf,
        builder: (BuildContext context, Loaded<CommitteeDashboard> loaded) => _Body(dashboard: loaded.value),
      ),
    );
  }
}

class _Body extends StatefulWidget {
  const _Body({required this.dashboard});

  final CommitteeDashboard dashboard;

  @override
  State<_Body> createState() => _BodyState();
}

class _BodyState extends State<_Body> {
  CommitteeDimension _dimension = CommitteeDimension.sector;

  @override
  Widget build(BuildContext context) {
    final CommitteeDashboard dashboard = widget.dashboard;
    final CommitteeWorkspace workspace = dashboard.workspace;
    final ThemeData theme = Theme.of(context);
    final CommitteeProvince province = workspace.province;
    final CommitteeFigure? gap = workspace.figure(committeeGapMetric);
    final CommitteeRag rag = gap != null && gap.hasValue ? province.rag : CommitteeRag.noData;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonSpace.space16, MachvonSpace.space12, MachvonSpace.space16, MachvonSpace.space4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.home.committee.asOf.text', <String, Object>{'day': asOfLabel(workspace.asOf), 'year': workspace.fiscalYear}), style: theme.textTheme.titleSmall),
              Text(_basisText(context, dashboard.basis), style: theme.textTheme.bodySmall),
              if (dashboard.reference != null) Text(context.t('mob.ban.dashboard.reference', <String, Object>{'reference': dashboard.reference!}), style: theme.textTheme.bodySmall),
              if (dashboard.policy != null) Text(_policyText(context, dashboard.policy!), style: theme.textTheme.bodySmall),
              if (dashboard.policy?.unverified == true) Text(context.t('mob.ban.dashboard.unverified'), style: theme.textTheme.bodySmall),
              Text(context.t('mob.ban.dashboard.readonly'), style: theme.textTheme.bodySmall),
              if (workspace.isStale)
                Padding(
                  padding: const EdgeInsets.only(top: MachvonSpace.space4),
                  child: Semantics(liveRegion: true, child: Wrap(children: <Widget>[StatusPill(label: context.t('mob.home.committee.stale.text'), warn: true)])),
                ),
            ],
          ),
        ),
        if (workspace.feedEmpty)
          SectionCard(title: context.t('mob.home.committee.title.text'), children: <Widget>[Semantics(liveRegion: true, container: true, child: Text(context.t('mob.home.committee.empty.text')))])
        else ...<Widget>[
        SectionCard(
          title: context.t('mob.home.committee.title.text'),
          children: <Widget>[
            CommitteeRagLine(rag: rag),
            CommitteeFigureRow(figure: workspace.figure(committeeRateMetric), label: context.t('mob.home.committee.label.rate'), headline: true),
            CommitteeFigureRow(figure: gap, label: context.t('mob.home.committee.label.gap'), signed: true),
            FactLine(label: context.t('mob.home.committee.label.expected'), value: context.t('mob.home.tile.value.percent', <String, Object>{'value': formatPercent(province.expectedPct, AppStrings.of(context).language)})),
            CommitteeFigureRow(figure: workspace.figure(committeePlanMetric), label: context.t('mob.home.committee.label.plan')),
            CommitteeFigureRow(figure: workspace.figure(committeeDisbursedMetric), label: context.t('mob.home.committee.label.disbursed')),
            CommitteeLastYearRow(workspace: workspace),
            CommitteeOutlookRow(workspace: workspace),
            const Divider(),
            CommitteeFigureRow(figure: workspace.figure(committeeAttentionMetric), label: context.t('mob.home.committee.label.attention')),
            CommitteeFigureRow(figure: workspace.figure(committeeUnitsMetric), label: context.t('mob.home.committee.label.units')),
            CommitteeFigureRow(figure: workspace.figure(committeeDirectivesMetric), label: context.t('mob.home.committee.label.directives')),
          ],
        ),
        SectionCard(
          title: context.t('mob.ban.dim.title'),
          children: <Widget>[
            _DimensionPicker(selected: _dimension, onChanged: (CommitteeDimension value) => setState(() => _dimension = value)),
            const SizedBox(height: MachvonSpace.space8),
            _Rows(rows: dashboard.rows[_dimension] ?? const <CommitteeRow>[]),
          ],
        ),
        SectionCard(title: context.t('mob.ban.attention.title'), children: <Widget>[_Attention(dashboard: dashboard)]),
        SectionCard(title: context.t('mob.ban.units.title'), children: <Widget>[_Units(units: dashboard.unitsNotReporting)]),
        SectionCard(title: context.t('mob.ban.directives.title'), children: <Widget>[_Directives(directives: dashboard.directives)]),
        SectionCard(title: context.t('mob.ban.alerts.title'), children: <Widget>[_Alerts(alerts: dashboard.alerts)]),
        ],
      ],
    );
  }
}

String _basisText(BuildContext context, String basis) {
  switch (basis) {
    case 'DIS_SNAPSHOT':
      return context.t('mob.ban.dashboard.basis.snapshot');
    case 'CORE_LIVE':
      return context.t('mob.ban.dashboard.basis.live');
    default:
      return context.t('mob.ban.dashboard.basis.other', <String, Object>{'basis': basis});
  }
}

String _policyText(BuildContext context, CommitteePolicy policy) =>
    policy.version == null ? context.t('mob.ban.dashboard.policyNoVersion', <String, Object>{'code': policy.code}) : context.t('mob.ban.dashboard.policy', <String, Object>{'code': policy.code, 'version': policy.version!});

String _dimensionWord(BuildContext context, CommitteeDimension dimension) {
  switch (dimension) {
    case CommitteeDimension.sector:
      return context.t('mob.ban.dim.sector');
    case CommitteeDimension.district:
      return context.t('mob.ban.dim.district');
    case CommitteeDimension.investor:
      return context.t('mob.ban.dim.investor');
    case CommitteeDimension.fundSource:
      return context.t('mob.ban.dim.fund');
  }
}

/// The four cuts of the province as one choice; the chosen one is said by its selected state, not by colour.
class _DimensionPicker extends StatelessWidget {
  const _DimensionPicker({required this.selected, required this.onChanged});

  final CommitteeDimension selected;
  final ValueChanged<CommitteeDimension> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: MachvonSpace.space8,
      runSpacing: MachvonSpace.space4,
      children: <Widget>[
        for (final CommitteeDimension dimension in CommitteeDimension.values)
          Semantics(
            button: true,
            selected: dimension == selected,
            label: _dimensionWord(context, dimension),
            onTap: () => onChanged(dimension),
            excludeSemantics: true,
            child: ChoiceChip(
              label: Text(_dimensionWord(context, dimension)),
              selected: dimension == selected,
              onSelected: (_) => onChanged(dimension),
              materialTapTargetSize: MaterialTapTargetSize.padded,
            ),
          ),
      ],
    );
  }
}

class _Rows extends StatelessWidget {
  const _Rows({required this.rows});

  final List<CommitteeRow> rows;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return Text(context.t('mob.ban.dim.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < rows.length; index += 1) ...<Widget>[
          if (index > 0) const Divider(),
          _RowTile(row: rows[index]),
        ],
      ],
    );
  }
}

class _RowTile extends StatelessWidget {
  const _RowTile({required this.row});

  final CommitteeRow row;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String language = AppStrings.of(context).language;
    final String? gap = row.gapPoints;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(row.label, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)),
            Padding(padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4), child: Wrap(children: <Widget>[_RagPill(rag: row.hasRate ? row.rag : CommitteeRag.noData)])),
            Text(context.t('mob.ban.row.projects', <String, Object>{'count': row.projects, 'attention': row.attentionProjects}), style: theme.textTheme.bodySmall),
            Text(context.t('mob.ban.row.plan', <String, Object>{'amount': millionsLabel(context, row.planVnd)}), style: theme.textTheme.bodyMedium),
            if (row.planSharePct != null) Text(context.t('mob.ban.row.share', <String, Object>{'share': '${formatPercent(row.planSharePct!, language)}%'}), style: theme.textTheme.bodySmall),
            Text(
              row.disbursedVnd == null ? context.t('mob.home.committee.value.none') : context.t('mob.ban.row.disbursed', <String, Object>{'amount': millionsLabel(context, row.disbursedVnd)}),
              style: theme.textTheme.bodyMedium,
            ),
            Text(
              row.ratePct == null
                  ? context.t('mob.ban.row.noRate')
                  : context.t('mob.ban.row.rate', <String, Object>{'rate': '${formatPercent(row.ratePct!, language)}%', 'expected': '${formatPercent(row.expectedPct, language)}%'}),
              style: theme.textTheme.bodyMedium,
            ),
            if (gap != null && row.ratePct != null) Text(context.t('mob.home.committee.value.points', <String, Object>{'points': _signed(formatPercent(gap, language), gap)}), style: theme.textTheme.bodySmall),
            if (row.unknownLines > 0) Text(context.t('mob.ban.row.unknown', <String, Object>{'count': row.unknownLines}), style: theme.textTheme.bodySmall),
            if (row.lastYearTotal > 0 && row.lastYearKnown < row.lastYearTotal) Text(context.t('mob.home.committee.lastYear.partial', <String, Object>{'known': row.lastYearKnown, 'total': row.lastYearTotal}), style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

String _signed(String digits, String raw) {
  if (raw.startsWith('-') || raw.startsWith('+')) return digits;
  final double? number = double.tryParse(raw);
  return number != null && number > 0 ? '+$digits' : digits;
}

/// The colour of a row in words and with a shape.
class _RagPill extends StatelessWidget {
  const _RagPill({required this.rag});

  final CommitteeRag rag;

  @override
  Widget build(BuildContext context) {
    switch (rag) {
      case CommitteeRag.red:
        return StatusPill(label: context.t('mob.home.committee.rag.red'), tone: MachvonTone.danger, icon: Icons.report_outlined);
      case CommitteeRag.amber:
        return StatusPill(label: context.t('mob.home.committee.rag.amber'), tone: MachvonTone.warning, icon: Icons.warning_amber_rounded);
      case CommitteeRag.green:
        return StatusPill(label: context.t('mob.home.committee.rag.green'), tone: MachvonTone.success, icon: Icons.check_circle_outline);
      case CommitteeRag.noData:
        return StatusPill(label: context.t('mob.home.committee.rag.noData'), tone: MachvonTone.neutral, icon: Icons.help_outline);
    }
  }
}

class _Attention extends StatelessWidget {
  const _Attention({required this.dashboard});

  final CommitteeDashboard dashboard;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String language = AppStrings.of(context).language;
    final List<CommitteeProject> projects = dashboard.projects;
    if (projects.isEmpty) return Text(context.t('mob.ban.attention.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.ban.attention.shown', <String, Object>{'shown': projects.length, 'total': dashboard.attentionTotal}), style: theme.textTheme.bodySmall),
        for (final CommitteeProject project in projects)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.home.committee.attention.item', <String, Object>{'code': project.code, 'name': project.name}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                  if (project.sectorName != null || project.districtName != null || project.investorName != null)
                    Text(
                      context.t('mob.ban.attention.where', <String, Object>{'sector': project.sectorName ?? '-', 'district': project.districtName ?? '-', 'investor': project.investorName ?? '-'}),
                      style: theme.textTheme.bodySmall,
                    ),
                  Text(
                    context.t('mob.ban.attention.progress', <String, Object>{
                      'plan': millionsLabel(context, project.planVnd),
                      'rate': project.ratePct == null ? context.t('mob.home.committee.value.none') : '${formatPercent(project.ratePct!, language)}%',
                      'expected': '${formatPercent(project.expectedPct, language)}%',
                    }),
                    style: theme.textTheme.bodySmall,
                  ),
                  for (final CommitteeSignal signal in project.signals) Text(_signalText(context, signal, language), style: theme.textTheme.bodyMedium),
                ],
              ),
            ),
          ),
        if (dashboard.attentionMore > 0) Text(context.t('mob.home.committee.attention.more', <String, Object>{'count': dashboard.attentionMore}), style: theme.textTheme.bodySmall),
      ],
    );
  }
}

String _signalText(BuildContext context, CommitteeSignal signal, String language) {
  final String reason = committeeReasonWord(context, signal.reason);
  final String? value = signal.value;
  if (value == null) return context.t('mob.ban.signal.plain', <String, Object>{'reason': reason});
  switch (signal.unit) {
    case 'DAYS':
      return context.t('mob.ban.signal.days', <String, Object>{'reason': reason, 'value': value});
    case 'PERCENT':
      return context.t('mob.ban.signal.percent', <String, Object>{'reason': reason, 'value': formatPercent(value, language)});
    case 'POINTS':
      return context.t('mob.ban.signal.points', <String, Object>{'reason': reason, 'value': formatPercent(value, language)});
    default:
      return context.t('mob.ban.signal.plain', <String, Object>{'reason': reason});
  }
}

class _Units extends StatelessWidget {
  const _Units({required this.units});

  final List<CommitteeUnit> units;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String language = AppStrings.of(context).language;
    if (units.isEmpty) return Text(context.t('mob.ban.units.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final CommitteeUnit unit in units)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(unit.name, style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                  Text(_unitReason(context, unit.reason), style: theme.textTheme.bodyMedium),
                  Text(context.t('mob.ban.unit.received', <String, Object>{'received': unit.received, 'expected': unit.expected}), style: theme.textTheme.bodySmall),
                  if (unit.ratePct != null) Text(context.t('mob.ban.unit.rate', <String, Object>{'rate': '${formatPercent(unit.ratePct!, language)}%'}), style: theme.textTheme.bodySmall),
                  Text(
                    unit.lastReportedOn == null
                        ? context.t('mob.ban.unit.never')
                        : context.t('mob.ban.unit.last', <String, Object>{'day': formatDay(unit.lastReportedOn!), 'days': unit.daysSince ?? 0}),
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

String _unitReason(BuildContext context, CommitteeUnitReason reason) {
  switch (reason) {
    case CommitteeUnitReason.neverReported:
      return context.t('mob.ban.unit.reasonNever');
    case CommitteeUnitReason.stale:
      return context.t('mob.ban.unit.reasonStale');
    case CommitteeUnitReason.lowRate:
      return context.t('mob.ban.unit.reasonLow');
    case CommitteeUnitReason.other:
      return context.t('mob.ban.unit.reasonOther');
  }
}

class _Directives extends StatelessWidget {
  const _Directives({required this.directives});

  final CommitteeDirectives? directives;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final CommitteeDirectives? tracker = directives;
    if (tracker == null) return Text(context.t('mob.ban.directives.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.ban.directives.totals', <String, Object>{'open': tracker.open, 'overdue': tracker.overdue, 'escalated': tracker.escalated}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
        if (tracker.escalateAfterDays != null) Text(context.t('mob.ban.directives.after', <String, Object>{'days': tracker.escalateAfterDays!}), style: theme.textTheme.bodySmall),
        for (final ({String unitName, int open, int overdue, int escalated}) unit in tracker.units)
          Text(context.t('mob.ban.directives.unit', <String, Object>{'unit': unit.unitName, 'open': unit.open, 'overdue': unit.overdue, 'escalated': unit.escalated}), style: theme.textTheme.bodyMedium),
        if (tracker.directives.isEmpty)
          Padding(padding: const EdgeInsets.only(top: MachvonSpace.space8), child: Text(context.t('mob.ban.directives.none')))
        else
          for (final CommitteeDirective directive in tracker.directives)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Wrap(
                      spacing: MachvonSpace.space8,
                      runSpacing: MachvonSpace.space4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: <Widget>[
                        directive.escalated
                            ? StatusPill(label: context.t('mob.ban.directive.escalated'), tone: MachvonTone.danger, icon: Icons.arrow_upward)
                            : StatusPill(label: context.t('mob.ban.directive.overdue'), tone: MachvonTone.warning, icon: Icons.schedule),
                        Text(context.t('mob.ban.directive.line', <String, Object>{'code': directive.code, 'unit': directive.unitName}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                      ],
                    ),
                    Text(directive.text, style: theme.textTheme.bodyMedium, maxLines: 4, overflow: TextOverflow.ellipsis),
                    Text(context.t('mob.ban.directive.due', <String, Object>{'day': formatDay(directive.dueOn), 'days': directive.overdueDays}), style: theme.textTheme.bodySmall),
                    if (directive.projectCode != null) Text(context.t('mob.ban.directive.project', <String, Object>{'project': directive.projectCode!}), style: theme.textTheme.bodySmall),
                    if (directive.extensionCount > 0) Text(context.t('mob.ban.directive.extended', <String, Object>{'count': directive.extensionCount}), style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
            ),
        if (tracker.truncated) Text(context.t('mob.ban.directives.truncated'), style: theme.textTheme.bodySmall),
      ],
    );
  }
}

class _Alerts extends StatelessWidget {
  const _Alerts({required this.alerts});

  final List<CommitteeAlertLine> alerts;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    if (alerts.isEmpty) return Text(context.t('mob.ban.alerts.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final CommitteeAlertLine alert in alerts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Wrap(
                    spacing: MachvonSpace.space8,
                    runSpacing: MachvonSpace.space4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: <Widget>[
                      CommitteeSeverityPill(severity: alert.severity),
                      Text(
                        alert.subjectLabel == null
                            ? committeeAlertTypeWord(context, alert.type)
                            : context.t('mob.home.committee.alert.subject', <String, Object>{'type': committeeAlertTypeWord(context, alert.type), 'subject': alert.subjectLabel!}),
                        style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                  Text(context.t('mob.ban.alert.opened', <String, Object>{'day': formatDay(alert.openedOn)}), style: theme.textTheme.bodySmall),
                  if (alert.acknowledged)
                    Text(
                      alert.acknowledgedBy == null ? context.t('mob.ban.alert.acknowledged') : context.t('mob.ban.alert.acknowledgedBy', <String, Object>{'name': alert.acknowledgedBy!}),
                      style: theme.textTheme.bodySmall,
                    ),
                  if (alert.owner != null) Text(context.t('mob.ban.alert.owner', <String, Object>{'name': alert.owner!}), style: theme.textTheme.bodySmall),
                  if (alert.expectedAction != null) Text(context.t('mob.ban.alert.action', <String, Object>{'text': alert.expectedAction!}), style: theme.textTheme.bodyMedium),
                  if (alert.consequence != null) Text(context.t('mob.ban.alert.consequence', <String, Object>{'text': alert.consequence!}), style: theme.textTheme.bodyMedium),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
