import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../vendor_models.dart';

/// MOB-74: the risk and the performance of one contractor. The grade the contractor carries and the grade the rules give from today's data, the points of
/// each factor with its readings, the reasons in order, the history of assessments, and the adopted ratings of its contracts with the clock of their
/// posting and the review of the contractor's response. It only reads; nothing here decides anything: a proposed grade is confirmed by a second person
/// on the computer, and a suggestion of the performance rule is for a person to act on. The performance is read on its own: when it fails, the risk
/// part still shows and says why the rest is missing.
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
    return ScreenFrame(
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

class _Body extends StatelessWidget {
  const _Body({required this.data});

  final VendorDetailData data;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final VendorRiskDetail risk = data.risk;
    final VendorGrade? live = risk.live;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.all(MachvonSpace.space16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Semantics(header: true, child: Text(risk.name, style: theme.textTheme.titleLarge)),
              const SizedBox(height: MachvonSpace.space4),
              Text(context.t('mob.vnd.list.readonly'), style: theme.textTheme.bodySmall),
            ],
          ),
        ),
        SectionCard(
          title: context.t('mob.vnd.grade.title'),
          children: <Widget>[
            Wrap(
              spacing: MachvonSpace.space8,
              runSpacing: MachvonSpace.space4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                TierPill(tier: risk.tier),
                Text(risk.tier == null ? context.t('mob.vnd.grade.none') : context.t('mob.vnd.grade.carried', <String, Object>{'tier': tierWord(context, risk.tier!)}), style: theme.textTheme.titleSmall),
              ],
            ),
            if (live != null) ...<Widget>[
              Text(context.t('mob.vnd.grade.live', <String, Object>{'tier': tierWord(context, live.tier), 'score': live.score}), style: theme.textTheme.bodyMedium),
              if (live.floored && live.scoreTier != null) Text(context.t('mob.vnd.grade.floored', <String, Object>{'tier': tierWord(context, live.scoreTier!)}), style: theme.textTheme.bodyMedium),
              if (live.reviewMonths != null && live.nextReviewOn != null)
                Text(context.t('mob.vnd.grade.review', <String, Object>{'months': live.reviewMonths!, 'day': formatDay(live.nextReviewOn!)}), style: theme.textTheme.bodySmall),
              if (live.dualCheck) Text(context.t('mob.vnd.grade.dual'), style: theme.textTheme.bodySmall),
            ],
            if (risk.policy != null) ...<Widget>[
              Text(context.t('mob.vnd.policy.line', <String, Object>{'code': risk.policy!.code, 'version': risk.policy!.version}), style: theme.textTheme.bodySmall),
              if (risk.policy!.unverified) Text(context.t('mob.vnd.policy.unverified'), style: theme.textTheme.bodySmall),
            ],
          ],
        ),
        if (live != null) ...<Widget>[
          SectionCard(title: context.t('mob.vnd.factors.title'), children: <Widget>[_Factors(factors: live.factors)]),
          SectionCard(title: context.t('mob.vnd.reasons.title'), children: <Widget>[_Reasons(reasons: live.reasons)]),
        ],
        SectionCard(
          title: context.t('mob.vnd.confirmed.title'),
          children: <Widget>[risk.confirmed == null ? Text(context.t('mob.vnd.confirmed.none')) : _SnapshotView(snapshot: risk.confirmed!)],
        ),
        if (risk.pending != null)
          SectionCard(
            title: context.t('mob.vnd.pending.title'),
            children: <Widget>[_SnapshotView(snapshot: risk.pending!), Text(context.t('mob.vnd.pending.text'), style: theme.textTheme.bodySmall)],
          ),
        SectionCard(title: context.t('mob.vnd.history.title'), children: <Widget>[_History(history: risk.history)]),
        SectionCard(title: context.t('mob.vnd.perf.title'), children: <Widget>[_Performance(data: data)]),
      ],
    );
  }
}

class _Factors extends StatelessWidget {
  const _Factors({required this.factors});

  final List<VendorFactor> factors;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final VendorFactor factor in factors)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.vnd.factors.line', <String, Object>{'factor': factorWord(context, factor.factor), 'points': factor.points, 'max': factor.max}), style: theme.textTheme.bodyMedium?.copyWith(fontWeight: factor.points > 0 ? FontWeight.w700 : null)),
                  for (final MapEntry<String, String> reading in factor.reading.entries)
                    Text(context.t('mob.vnd.reading.line', <String, Object>{'name': readingName(context, reading.key), 'value': readingValue(context, reading.value)}), style: theme.textTheme.bodySmall),
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
    if (reasons.isEmpty) return Text(context.t('mob.vnd.reasons.none'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int index = 0; index < reasons.length; index += 1) Text('${index + 1}. ${factorWord(context, reasons[index])}'),
      ],
    );
  }
}

class _SnapshotView extends StatelessWidget {
  const _SnapshotView({required this.snapshot});

  final VendorSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Wrap(
            spacing: MachvonSpace.space8,
            runSpacing: MachvonSpace.space4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              TierPill(tier: snapshot.tier),
              Text(context.t('mob.vnd.snapshot.line', <String, Object>{'tier': tierWord(context, snapshot.tier), 'score': snapshot.score, 'day': formatDay(snapshot.asOf)}), style: theme.textTheme.bodyMedium),
            ],
          ),
          Text(stateWord(context, snapshot.state), style: theme.textTheme.bodySmall),
          if (snapshot.assessedBy != null) Text(context.t('mob.vnd.snapshot.assessed', <String, Object>{'name': snapshot.assessedBy!}), style: theme.textTheme.bodySmall),
          if (snapshot.decidedBy != null) Text(context.t('mob.vnd.snapshot.decided', <String, Object>{'name': snapshot.decidedBy!}), style: theme.textTheme.bodySmall),
          if (snapshot.decisionReason != null) Text(context.t('mob.vnd.snapshot.reason', <String, Object>{'reason': snapshot.decisionReason!}), style: theme.textTheme.bodySmall),
          if (snapshot.ruleVersion != null) Text(context.t('mob.vnd.snapshot.rule', <String, Object>{'version': snapshot.ruleVersion!}), style: theme.textTheme.bodySmall),
          if (snapshot.ruleUnverified) Text(context.t('mob.vnd.snapshot.unverified'), style: theme.textTheme.bodySmall),
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
    if (history.isEmpty) return Text(context.t('mob.vnd.history.none'));
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
    final ThemeData theme = Theme.of(context);
    final VendorPerformance? performance = data.performance;
    if (performance == null) return Text(context.t('mob.vnd.perf.unavailable', <String, Object>{'code': data.performanceError ?? 'UNKNOWN'}));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.vnd.perf.streak', <String, Object>{'count': performance.streak}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
        if (performance.suggestion == 'REMEDY_PLAN') Text(context.t('mob.vnd.perf.suggestRemedy'), style: theme.textTheme.bodyMedium),
        if (performance.suggestion == 'PROPOSE_RESTRICTION') Text(context.t('mob.vnd.perf.suggestRestrict'), style: theme.textTheme.bodyMedium),
        if (performance.policy != null) ...<Widget>[
          Text(context.t('mob.vnd.policy.line', <String, Object>{'code': performance.policy!.code, 'version': performance.policy!.version}), style: theme.textTheme.bodySmall),
          if (performance.policy!.unverified) Text(context.t('mob.vnd.policy.unverified'), style: theme.textTheme.bodySmall),
        ],
        if (performance.lines.isEmpty)
          Padding(padding: const EdgeInsets.only(top: MachvonSpace.space8), child: Text(context.t('mob.vnd.perf.none')))
        else
          for (final VendorPerformanceLine line in performance.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space8),
              child: MergeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.t('mob.vnd.perf.line', <String, Object>{'contract': line.contractCode, 'period': line.periodLabel}), style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
                      child: Wrap(
                        spacing: MachvonSpace.space8,
                        runSpacing: MachvonSpace.space4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: <Widget>[RatingPill(rating: line.rating), if (line.score != null) Text(context.t('mob.vnd.perf.score', <String, Object>{'score': line.score!}), style: theme.textTheme.bodyMedium)],
                      ),
                    ),
                    if (line.adoptedOn != null) Text(context.t('mob.vnd.perf.adopted', <String, Object>{'day': formatDay(line.adoptedOn!)}), style: theme.textTheme.bodySmall),
                    if (line.publicationDueOn != null) Text(context.t('mob.vnd.perf.due', <String, Object>{'day': formatDay(line.publicationDueOn!)}), style: theme.textTheme.bodySmall),
                    Wrap(
                      children: <Widget>[
                        publicationClockLate(line.publicationClock)
                            ? StatusPill(label: publicationClockWord(context, line.publicationClock), warn: true, icon: Icons.schedule)
                            : Text(publicationClockWord(context, line.publicationClock), style: theme.textTheme.bodyMedium),
                      ],
                    ),
                    Text(responseReviewWord(context, line.responseReview), style: theme.textTheme.bodyMedium),
                    if (line.updates > 0) Text(context.t('mob.vnd.perf.updates', <String, Object>{'count': line.updates}), style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
            ),
      ],
    );
  }
}
