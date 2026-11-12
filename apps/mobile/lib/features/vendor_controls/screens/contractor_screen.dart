import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/underline_tabs.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../vendor_models.dart';

/// MOB-74: the risk and the performance of one contractor. The grade the contractor carries and the grade the rules give from today's data, the points of
/// each factor with its readings, the reasons in order, the history of assessments, and the adopted ratings of its contracts with the clock of their
/// posting and the review of the contractor's response, in three tabs (the grade, the history, the performance). It only reads; nothing here decides
/// anything: a proposed grade is confirmed by a second person on the computer, and a suggestion of the performance rule is for a person to act on, so the
/// screen has no action bar. The performance is read on its own: when it fails, the risk part still shows and says why the rest is missing.
Widget buildContractorScreen(BuildContext context, ScreenContext screen) => ContractorScreen(contractorId: screen.pathParameters['contractorId'] ?? '');

class ContractorScreen extends StatelessWidget {
  const ContractorScreen({required this.contractorId, super.key});

  final String contractorId;

  Future<Object?> _read(MachvonApiClient client) async {
    final Object? risk = await client.getVendorRiskGrade(id: contractorId);
    Object? performance;
    String? error;
    try {
      performance = await client.getVendorPerformance(id: contractorId);
    } on ApiError catch (failure) {
      error = failure.code;
    }
    return <String, Object?>{'risk': risk, 'performance': performance, 'performance_error': error};
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.vnd.detail.title'),
      body: DataView<VendorDetailData>(
        cacheKey: 'vnd.contractor.$contractorId',
        read: _read,
        parse: parseVendorDetailData,
        asOf: (VendorDetailData data) => data.risk.asOf,
        builder: (BuildContext context, Loaded<VendorDetailData> loaded) => _Body(data: loaded.value),
      ),
    );
  }
}

class _Body extends StatefulWidget {
  const _Body({required this.data});

  final VendorDetailData data;

  @override
  State<_Body> createState() => _BodyState();
}

class _BodyState extends State<_Body> {
  int _tab = 0;

  /// The figures at the top: the points of the grade from today's data, the run of poor ratings and the number of rated contracts; each only when it is known.
  List<StatCell> _cells(BuildContext context) {
    final VendorGrade? live = widget.data.risk.live;
    final VendorPerformance? performance = widget.data.performance;
    return <StatCell>[
      if (live != null)
        StatCell(value: '${live.score}', label: context.t('mob.vnd.stat.score'), band: bandOfTier(live.tier), bandText: tierWord(context, live.tier)),
      if (performance != null) ...<StatCell>[
        StatCell(value: '${performance.streak}', label: context.t('mob.vnd.stat.streak'), band: performance.streak > 0 ? DeadlineBand.soon : null, bandText: performance.streak > 0 ? context.t('mob.vnd.stat.streak.note') : null),
        StatCell(value: '${performance.lines.length}', label: context.t('mob.vnd.stat.rated')),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final VendorDetailData data = widget.data;
    final VendorRiskDetail risk = data.risk;
    final List<StatCell> cells = _cells(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Semantics(header: true, child: Text(risk.name, style: text.title)),
              const SizedBox(height: MachvonV2Space.s4),
              Text(context.t('mob.vnd.list.readonly'), style: text.caption),
            ],
          ),
        ),
        if (cells.isNotEmpty) StatStrip(cells: cells),
        UnderlineTabs(
          tabs: <TabOption>[
            TabOption(label: context.t('mob.vnd.tab.grade')),
            TabOption(label: context.t('mob.vnd.tab.history'), count: risk.history.length),
            TabOption(label: context.t('mob.vnd.tab.performance')),
          ],
          index: _tab,
          onChanged: (int index) => setState(() => _tab = index),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        switch (_tab) {
          0 => _GradeTab(risk: risk),
          1 => _HistoryTab(risk: risk),
          _ => SectionCard(title: context.t('mob.vnd.perf.title'), children: <Widget>[_Performance(data: data)]),
        },
      ],
    );
  }
}

class _GradeTab extends StatelessWidget {
  const _GradeTab({required this.risk});

  final VendorRiskDetail risk;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final VendorGrade? live = risk.live;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionCard(
          title: context.t('mob.vnd.grade.title'),
          children: <Widget>[
            Wrap(
              spacing: MachvonV2Space.s8,
              runSpacing: MachvonV2Space.s4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                TierPill(tier: risk.tier),
                Text(risk.tier == null ? context.t('mob.vnd.grade.none') : context.t('mob.vnd.grade.carried', <String, Object>{'tier': tierWord(context, risk.tier!)}), style: text.heading),
              ],
            ),
            if (live != null) ...<Widget>[
              Text(context.t('mob.vnd.grade.live', <String, Object>{'tier': tierWord(context, live.tier), 'score': live.score}), style: text.body),
              if (live.floored && live.scoreTier != null) Text(context.t('mob.vnd.grade.floored', <String, Object>{'tier': tierWord(context, live.scoreTier!)}), style: text.body),
              if (live.reviewMonths != null && live.nextReviewOn != null)
                Text(context.t('mob.vnd.grade.review', <String, Object>{'months': live.reviewMonths!, 'day': formatDay(live.nextReviewOn!)}), style: text.caption),
              if (live.dualCheck) Text(context.t('mob.vnd.grade.dual'), style: text.caption),
            ],
            if (risk.policy != null) ...<Widget>[
              Text(context.t('mob.vnd.policy.line', <String, Object>{'code': risk.policy!.code, 'version': risk.policy!.version}), style: text.caption),
              if (risk.policy!.unverified) Text(context.t('mob.vnd.policy.unverified'), style: text.caption),
            ],
          ],
        ),
        if (live != null) ...<Widget>[
          SectionCard(title: context.t('mob.vnd.factors.title'), children: <Widget>[_Factors(factors: live.factors)]),
          SectionCard(title: context.t('mob.vnd.reasons.title'), children: <Widget>[_Reasons(reasons: live.reasons)]),
        ],
        if (risk.pending != null)
          SectionCard(
            title: context.t('mob.vnd.pending.title'),
            children: <Widget>[_SnapshotView(snapshot: risk.pending!), Text(context.t('mob.vnd.pending.text'), style: text.caption)],
          ),
      ],
    );
  }
}

class _HistoryTab extends StatelessWidget {
  const _HistoryTab({required this.risk});

  final VendorRiskDetail risk;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SectionCard(
          title: context.t('mob.vnd.confirmed.title'),
          children: <Widget>[risk.confirmed == null ? Text(context.t('mob.vnd.confirmed.none'), style: context.v2text.body) : _SnapshotView(snapshot: risk.confirmed!)],
        ),
        SectionCard(title: context.t('mob.vnd.history.title'), children: <Widget>[_History(history: risk.history)]),
      ],
    );
  }
}

class _Factors extends StatelessWidget {
  const _Factors({required this.factors});

  final List<VendorFactor> factors;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final VendorFactor factor in factors)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.vnd.factors.line', <String, Object>{'factor': factorWord(context, factor.factor), 'points': factor.points, 'max': factor.max}), style: factor.points > 0 ? text.bodyStrong : text.body),
                  for (final MapEntry<String, String> reading in factor.reading.entries)
                    Text(context.t('mob.vnd.reading.line', <String, Object>{'name': readingName(context, reading.key), 'value': readingValue(context, reading.value)}), style: text.caption),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Reasons extends StatelessWidget {
  const _Reasons({required this.reasons});

  final List<String> reasons;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    if (reasons.isEmpty) return Text(context.t('mob.vnd.reasons.none'), style: text.body);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int index = 0; index < reasons.length; index += 1) Text('${index + 1}. ${factorWord(context, reasons[index])}', style: text.body),
      ],
    );
  }
}

class _SnapshotView extends StatelessWidget {
  const _SnapshotView({required this.snapshot});

  final VendorSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Wrap(
            spacing: MachvonV2Space.s8,
            runSpacing: MachvonV2Space.s4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              TierPill(tier: snapshot.tier),
              Text(context.t('mob.vnd.snapshot.line', <String, Object>{'tier': tierWord(context, snapshot.tier), 'score': snapshot.score, 'day': formatDay(snapshot.asOf)}), style: text.body),
            ],
          ),
          Text(stateWord(context, snapshot.state), style: text.caption),
          if (snapshot.assessedBy != null) Text(context.t('mob.vnd.snapshot.assessed', <String, Object>{'name': snapshot.assessedBy!}), style: text.caption),
          if (snapshot.decidedBy != null) Text(context.t('mob.vnd.snapshot.decided', <String, Object>{'name': snapshot.decidedBy!}), style: text.caption),
          if (snapshot.decisionReason != null) Text(context.t('mob.vnd.snapshot.reason', <String, Object>{'reason': snapshot.decisionReason!}), style: text.caption),
          if (snapshot.ruleVersion != null) Text(context.t('mob.vnd.snapshot.rule', <String, Object>{'version': snapshot.ruleVersion!}), style: text.caption),
          if (snapshot.ruleUnverified) Text(context.t('mob.vnd.snapshot.unverified'), style: text.caption),
        ],
      ),
    );
  }
}

class _History extends StatelessWidget {
  const _History({required this.history});

  final List<VendorSnapshot> history;

  @override
  Widget build(BuildContext context) {
    if (history.isEmpty) return Text(context.t('mob.vnd.history.none'), style: context.v2text.body);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int index = 0; index < history.length; index += 1) ...<Widget>[
          if (index > 0) const Divider(),
          _SnapshotView(snapshot: history[index]),
        ],
      ],
    );
  }
}

class _Performance extends StatelessWidget {
  const _Performance({required this.data});

  final VendorDetailData data;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final VendorPerformance? performance = data.performance;
    if (performance == null) return Text(context.t('mob.vnd.perf.unavailable', <String, Object>{'code': data.performanceError ?? 'UNKNOWN'}), style: text.body);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.vnd.perf.streak', <String, Object>{'count': performance.streak}), style: text.bodyStrong),
        if (performance.suggestion == 'REMEDY_PLAN') Text(context.t('mob.vnd.perf.suggestRemedy'), style: text.body),
        if (performance.suggestion == 'PROPOSE_RESTRICTION') Text(context.t('mob.vnd.perf.suggestRestrict'), style: text.body),
        if (performance.policy != null) ...<Widget>[
          Text(context.t('mob.vnd.policy.line', <String, Object>{'code': performance.policy!.code, 'version': performance.policy!.version}), style: text.caption),
          if (performance.policy!.unverified) Text(context.t('mob.vnd.policy.unverified'), style: text.caption),
        ],
        if (performance.lines.isEmpty)
          Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.vnd.perf.none'), style: text.body))
        else
          for (final VendorPerformanceLine line in performance.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.vnd.perf.line', <String, Object>{'contract': line.contractCode, 'period': line.periodLabel}), style: text.bodyStrong),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
                      child: Wrap(
                        spacing: MachvonV2Space.s8,
                        runSpacing: MachvonV2Space.s4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: <Widget>[RatingPill(rating: line.rating), if (line.score != null) Text(context.t('mob.vnd.perf.score', <String, Object>{'score': line.score!}), style: text.body)],
                      ),
                    ),
                    if (line.adoptedOn != null) Text(context.t('mob.vnd.perf.adopted', <String, Object>{'day': formatDay(line.adoptedOn!)}), style: text.caption),
                    if (line.publicationDueOn != null) Text(context.t('mob.vnd.perf.due', <String, Object>{'day': formatDay(line.publicationDueOn!)}), style: text.caption),
                    Wrap(
                      children: <Widget>[
                        publicationClockLate(line.publicationClock)
                            ? StatusPill(label: publicationClockWord(context, line.publicationClock), warn: true, icon: Icons.schedule)
                            : Text(publicationClockWord(context, line.publicationClock), style: text.body),
                      ],
                    ),
                    Text(responseReviewWord(context, line.responseReview), style: text.body),
                    if (line.updates > 0) Text(context.t('mob.vnd.perf.updates', <String, Object>{'count': line.updates}), style: text.caption),
                  ],
                ),
              ),
            ),
      ],
    );
  }
}
