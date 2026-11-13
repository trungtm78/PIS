import 'package:flutter/material.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/progress.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../dashboard/committee_workspace.dart';
import '../../dashboard/widgets/committee_card.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
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
    return AppScaffold(
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
    final MachvonV2Text text = context.v2text;
    final CommitteeProvince province = workspace.province;
    final CommitteeFigure? gap = workspace.figure(committeeGapMetric);
    final CommitteeRag rag = gap != null && gap.hasValue ? province.rag : CommitteeRag.noData;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s12, MachvonV2Space.s16, MachvonV2Space.s4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(context.t('mob.home.committee.asOf.text', <String, Object>{'day': asOfLabel(workspace.asOf), 'year': workspace.fiscalYear}), style: text.label),
              Text(_basisText(context, dashboard.basis), style: text.caption),
              if (dashboard.reference != null) Text(context.t('mob.ban.dashboard.reference', <String, Object>{'reference': dashboard.reference!}), style: text.caption),
              if (dashboard.policy != null) Text(_policyText(context, dashboard.policy!), style: text.caption),
              if (dashboard.policy?.unverified == true) Text(context.t('mob.ban.dashboard.unverified'), style: text.caption),
              Text(context.t('mob.ban.dashboard.readonly'), style: text.caption),
            ],
          ),
        ),
        if (workspace.isStale) StatusBanner(text: context.t('mob.home.committee.stale.text'), icon: Icons.history_toggle_off_outlined),
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
            const _Hairline(),
            CommitteeFigureRow(figure: workspace.figure(committeeAttentionMetric), label: context.t('mob.home.committee.label.attention')),
            CommitteeFigureRow(figure: workspace.figure(committeeUnitsMetric), label: context.t('mob.home.committee.label.units')),
            CommitteeFigureRow(figure: workspace.figure(committeeDirectivesMetric), label: context.t('mob.home.committee.label.directives')),
          ],
        ),
        SectionCard(
          title: context.t('mob.ban.dim.title'),
          children: <Widget>[
            _DimensionPicker(selected: _dimension, onChanged: (CommitteeDimension value) => setState(() => _dimension = value)),
            const SizedBox(height: MachvonV2Space.s8),
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
    return UnderlineTabs(
      index: CommitteeDimension.values.indexOf(selected),
      onChanged: (int index) => onChanged(CommitteeDimension.values[index]),
      tabs: <TabOption>[for (final CommitteeDimension dimension in CommitteeDimension.values) TabOption(label: _dimensionWord(context, dimension))],
    );
  }
}

/// A hairline between two rows of a block.
class _Hairline extends StatelessWidget {
  const _Hairline();

  @override
  Widget build(BuildContext context) => SizedBox(height: 1, child: ColoredBox(color: context.v2.palette.line));
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
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final String? gap = row.gapPoints;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: MergeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(row.label, style: text.bodyStrong),
            Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4), child: Wrap(children: <Widget>[_RagPill(rag: row.hasRate ? row.rag : CommitteeRag.noData)])),
            if (row.ratePct != null && double.tryParse(row.ratePct!) != null) Padding(padding: const EdgeInsets.only(bottom: MachvonV2Space.s4), child: ProgressMeter(value: double.parse(row.ratePct!) / 100)),
            Text(context.t('mob.ban.row.projects', <String, Object>{'count': row.projects, 'attention': row.attentionProjects}), style: text.caption),
            Text(context.t('mob.ban.row.plan', <String, Object>{'amount': moneyLabel(context, row.planVnd)}), style: text.body),
            if (row.planSharePct != null) Text(context.t('mob.ban.row.share', <String, Object>{'share': '${formatPercent(row.planSharePct!, language)}%'}), style: text.caption),
            Text(
              row.disbursedVnd == null ? context.t('mob.home.committee.value.none') : context.t('mob.ban.row.disbursed', <String, Object>{'amount': moneyLabel(context, row.disbursedVnd)}),
              style: text.body,
            ),
            Text(
              row.ratePct == null
                  ? context.t('mob.ban.row.noRate')
                  : context.t('mob.ban.row.rate', <String, Object>{'rate': '${formatPercent(row.ratePct!, language)}%', 'expected': '${formatPercent(row.expectedPct, language)}%'}),
              style: text.body,
            ),
            if (gap != null && row.ratePct != null) Text(context.t('mob.home.committee.value.points', <String, Object>{'points': _signed(formatPercent(gap, language), gap)}), style: text.caption),
            if (row.unknownLines > 0) Text(context.t('mob.ban.row.unknown', <String, Object>{'count': row.unknownLines}), style: text.caption),
            if (row.lastYearTotal > 0 && row.lastYearKnown < row.lastYearTotal) Text(context.t('mob.home.committee.lastYear.partial', <String, Object>{'known': row.lastYearKnown, 'total': row.lastYearTotal}), style: text.caption),
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
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final List<CommitteeProject> projects = dashboard.projects;
    if (projects.isEmpty) return Text(context.t('mob.ban.attention.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.ban.attention.shown', <String, Object>{'shown': projects.length, 'total': dashboard.attentionTotal}), style: text.caption),
        for (final CommitteeProject project in projects)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.home.committee.attention.item', <String, Object>{'code': project.code, 'name': project.name}), style: text.bodyStrong),
                  if (project.sectorName != null || project.districtName != null || project.investorName != null)
                    Text(
                      context.t('mob.ban.attention.where', <String, Object>{'sector': project.sectorName ?? '-', 'district': project.districtName ?? '-', 'investor': project.investorName ?? '-'}),
                      style: text.caption,
                    ),
                  Text(
                    context.t('mob.ban.attention.progress', <String, Object>{
                      'plan': moneyLabel(context, project.planVnd),
                      'rate': project.ratePct == null ? context.t('mob.home.committee.value.none') : '${formatPercent(project.ratePct!, language)}%',
                      'expected': '${formatPercent(project.expectedPct, language)}%',
                    }),
                    style: text.caption,
                  ),
                  for (final CommitteeSignal signal in project.signals) Text(_signalText(context, signal, language), style: text.body),
                ],
              ),
            ),
          ),
        if (dashboard.attentionMore > 0) Text(context.t('mob.home.committee.attention.more', <String, Object>{'count': dashboard.attentionMore}), style: text.caption),
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
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    if (units.isEmpty) return Text(context.t('mob.ban.units.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final CommitteeUnit unit in units)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(unit.name, style: text.bodyStrong),
                  Text(_unitReason(context, unit.reason), style: text.body),
                  Text(context.t('mob.ban.unit.received', <String, Object>{'received': unit.received, 'expected': unit.expected}), style: text.caption),
                  if (unit.ratePct != null) Text(context.t('mob.ban.unit.rate', <String, Object>{'rate': '${formatPercent(unit.ratePct!, language)}%'}), style: text.caption),
                  Text(
                    unit.lastReportedOn == null
                        ? context.t('mob.ban.unit.never')
                        : context.t('mob.ban.unit.last', <String, Object>{'day': formatDay(unit.lastReportedOn!), 'days': unit.daysSince ?? 0}),
                    style: text.caption,
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
    final MachvonV2Text text = context.v2text;
    final CommitteeDirectives? tracker = directives;
    if (tracker == null) return Text(context.t('mob.ban.directives.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.ban.directives.totals', <String, Object>{'open': tracker.open, 'overdue': tracker.overdue, 'escalated': tracker.escalated}), style: text.bodyStrong),
        if (tracker.escalateAfterDays != null) Text(context.t('mob.ban.directives.after', <String, Object>{'days': tracker.escalateAfterDays!}), style: text.caption),
        for (final ({String unitName, int open, int overdue, int escalated}) unit in tracker.units)
          Text(context.t('mob.ban.directives.unit', <String, Object>{'unit': unit.unitName, 'open': unit.open, 'overdue': unit.overdue, 'escalated': unit.escalated}), style: text.body),
        if (tracker.directives.isEmpty)
          Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.ban.directives.none')))
        else
          for (final CommitteeDirective directive in tracker.directives)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Wrap(
                      spacing: MachvonV2Space.s8,
                      runSpacing: MachvonV2Space.s4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: <Widget>[
                        directive.escalated
                            ? StatusPill(label: context.t('mob.ban.directive.escalated'), tone: MachvonTone.danger, icon: Icons.arrow_upward)
                            : StatusPill(label: context.t('mob.ban.directive.overdue'), tone: MachvonTone.warning, icon: Icons.schedule),
                        Text(context.t('mob.ban.directive.line', <String, Object>{'code': directive.code, 'unit': directive.unitName}), style: text.bodyStrong),
                      ],
                    ),
                    Text(directive.text, style: text.body, maxLines: 4, overflow: TextOverflow.ellipsis),
                    Text(context.t('mob.ban.directive.due', <String, Object>{'day': formatDay(directive.dueOn), 'days': directive.overdueDays}), style: text.caption),
                    if (directive.projectCode != null) Text(context.t('mob.ban.directive.project', <String, Object>{'project': directive.projectCode!}), style: text.caption),
                    if (directive.extensionCount > 0) Text(context.t('mob.ban.directive.extended', <String, Object>{'count': directive.extensionCount}), style: text.caption),
                  ],
                ),
              ),
            ),
        if (tracker.truncated) Text(context.t('mob.ban.directives.truncated'), style: text.caption),
      ],
    );
  }
}

class _Alerts extends StatelessWidget {
  const _Alerts({required this.alerts});

  final List<CommitteeAlertLine> alerts;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    if (alerts.isEmpty) return Text(context.t('mob.ban.alerts.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final CommitteeAlertLine alert in alerts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Wrap(
                    spacing: MachvonV2Space.s8,
                    runSpacing: MachvonV2Space.s4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: <Widget>[
                      CommitteeSeverityPill(severity: alert.severity),
                      Text(
                        alert.subjectLabel == null
                            ? committeeAlertTypeWord(context, alert.type)
                            : context.t('mob.home.committee.alert.subject', <String, Object>{'type': committeeAlertTypeWord(context, alert.type), 'subject': alert.subjectLabel!}),
                        style: text.bodyStrong,
                      ),
                    ],
                  ),
                  Text(context.t('mob.ban.alert.opened', <String, Object>{'day': formatDay(alert.openedOn)}), style: text.caption),
                  if (alert.acknowledged)
                    Text(
                      alert.acknowledgedBy == null ? context.t('mob.ban.alert.acknowledged') : context.t('mob.ban.alert.acknowledgedBy', <String, Object>{'name': alert.acknowledgedBy!}),
                      style: text.caption,
                    ),
                  if (alert.owner != null) Text(context.t('mob.ban.alert.owner', <String, Object>{'name': alert.owner!}), style: text.caption),
                  if (alert.expectedAction != null) Text(context.t('mob.ban.alert.action', <String, Object>{'text': alert.expectedAction!}), style: text.body),
                  if (alert.consequence != null) Text(context.t('mob.ban.alert.consequence', <String, Object>{'text': alert.consequence!}), style: text.body),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
