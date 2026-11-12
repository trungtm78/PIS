import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/filter_chips.dart';
import '../../../core/widgets/section_panel.dart';
import '../../read_support/navigate.dart';
import '../../read_support/paged.dart';
import '../../read_support/widgets.dart';
import '../ai_models.dart';
import '../ai_read.dart';
import '../ai_support.dart';

/// MOB-38: what the model proposed for each criterion of one analysis run, one finding to a card. Every card says it is a proposal of
/// the AI that an expert verifies; a finding that no person has decided yet carries "needs verification", and one that claimed without a
/// citation found on its page says so (BR-BID-07). What a person decided is shown apart from what the model said (BR-BID-09). The only
/// thing a card offers is to open a citation at its source (MOB-39): there is no approve, reject, swipe or push action, on the card or
/// anywhere on this screen, because the review is the expert's act on the web.
///
/// A run is `?run=<id>`; without it the screen lists the runs of the person's scope.
Widget buildFindingsScreen(BuildContext context, ScreenContext screen) {
  final String? run = screen.queryParameters['run'];
  return run == null || run.isEmpty ? const _RunList() : _RunFindings(runId: run);
}

class _RunList extends StatelessWidget {
  const _RunList();

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.ai.runs.title'),
      body: FreshRead<RunList>(
        resource: 'runs',
        read: (MachvonApiClient client) async => parseRunList(await readMerged(client, 'get_resources_analysis_run', query: <String, Object?>{'limit': 50}, maxPages: 4)),
        isEmpty: (RunList list) => list.runs.isEmpty,
        builder: (BuildContext context, RunList list) => ListView(
          children: <Widget>[
            const AiNotice(),
            for (final Run run in list.runs) _RunRow(run: run),
            if (list.more)
              Padding(
                padding: const EdgeInsets.all(MachvonV2Space.s16),
                child: Text(context.t('mob.ai.runs.more'), style: context.v2text.caption),
              ),
          ],
        ),
      ),
    );
  }
}

class _RunRow extends StatelessWidget {
  const _RunRow({required this.run});

  final Run run;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String facts = context.t('mob.ai.runs.row.facts', <String, Object>{'status': runStatusLabel(context, run.status), 'findings': run.findingCount, 'reviewed': run.reviewedCount});
    return TappableRow(
      semanticLabel: context.t('mob.ai.runs.row.aria', <String, Object>{'package': run.packageCode, 'contractor': run.contractorName, 'facts': facts}),
      onTap: () => openScreen(context, 'MOB-38', query: <String, String>{'run': run.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(run.packageCode, style: text.bodyStrong),
                Text(run.contractorName, style: text.body),
                Text(facts, style: text.caption),
              ],
            ),
          ),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}

class _RunFindings extends StatelessWidget {
  const _RunFindings({required this.runId});

  final String runId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.ai.findings.title'),
      body: FreshRead<FindingList>(
        resource: runId,
        read: (MachvonApiClient client) async => parseFindingList(await readMerged(client, 'listAnalysisFindings', path: <String, Object?>{'id': runId}, query: <String, Object?>{'limit': 50}, maxPages: 4)),
        builder: (BuildContext context, FindingList list) => _Findings(list: list),
      ),
    );
  }
}

enum _View { all, awaiting, missingSource }

class _Findings extends StatefulWidget {
  const _Findings({required this.list});

  final FindingList list;

  @override
  State<_Findings> createState() => _FindingsState();
}

class _FindingsState extends State<_Findings> {
  _View _view = _View.all;

  List<Finding> get _shown => switch (_view) {
        _View.all => widget.list.findings,
        _View.awaiting => <Finding>[for (final Finding f in widget.list.findings) if (f.awaitsVerification) f],
        _View.missingSource => <Finding>[for (final Finding f in widget.list.findings) if (f.missingSource) f],
      };

  @override
  Widget build(BuildContext context) {
    final Run run = widget.list.run;
    final List<Finding> shown = _shown;
    final MachvonV2Text text = context.v2text;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        const AiNotice(),
        SectionCard(
          title: context.t('mob.ai.findings.run.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.ai.findings.run.package'), value: run.packageCode),
            FactLine(label: context.t('mob.ai.findings.run.contractor'), value: run.contractorName),
            FactLine(label: context.t('mob.ai.findings.run.status'), value: runStatusLabel(context, run.status)),
            FactLine(label: context.t('mob.ai.findings.run.counts'), value: context.t('mob.ai.findings.run.countsValue', <String, Object>{'findings': run.findingCount, 'reviewed': run.reviewedCount, 'missing': run.missingSourceCount})),
            if (run.failureCode != null) ...<Widget>[
              Text(context.t('mob.ai.findings.run.failed'), style: text.body),
              Text(run.failureCode!, style: text.caption),
            ],
            if (widget.list.asOf != null) Text(context.t('mob.ai.findings.asOf', <String, Object>{'time': formatMoment(widget.list.asOf!)}), style: text.caption),
          ],
        ),
        FilterChips<_View>(
          options: <ChipOption<_View>>[
            ChipOption<_View>(value: _View.all, label: context.t('mob.ai.findings.view.all')),
            ChipOption<_View>(value: _View.awaiting, label: context.t('mob.ai.findings.view.awaiting')),
            ChipOption<_View>(value: _View.missingSource, label: context.t('mob.ai.findings.view.missing')),
          ],
          selected: _view,
          onChanged: (_View view) => setState(() => _view = view),
        ),
        if (widget.list.findings.isEmpty)
          Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.ai.findings.none'), style: text.body))
        else if (shown.isEmpty)
          Padding(padding: const EdgeInsets.all(MachvonV2Space.s16), child: Text(context.t('mob.ai.findings.noneInView'), style: text.body)),
        for (final Finding finding in shown) FindingCard(finding: finding),
        if (widget.list.more)
          Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
            child: Text(context.t('mob.ai.findings.more'), style: text.caption),
          ),
      ],
    );
  }
}

/// One finding. It reads, and it opens the sources it cites; it has no other control.
class FindingCard extends StatelessWidget {
  const FindingCard({required this.finding, super.key});

  final Finding finding;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String? decided = finding.finalStatus;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: OutlinedBlock(
        child: Padding(
          padding: const EdgeInsets.all(MachvonV2Space.s16),
          child: Semantics(
            container: true,
            label: context.t('mob.ai.finding.aria', <String, Object>{'criterion': finding.criterionId}),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Semantics(header: true, child: Text(context.t('mob.ai.finding.heading', <String, Object>{'criterion': finding.criterionId}), style: text.heading)),
                const SizedBox(height: MachvonV2Space.s8),
                Pills(
                  pills: <StatusPill>[
                    StatusPill(label: context.t('mob.ai.finding.aiLabel')),
                    if (finding.awaitsVerification) StatusPill(label: context.t('mob.ai.finding.needsVerification'), warn: true),
                    if (finding.missingSource) StatusPill(label: context.t('mob.ai.finding.missingSource'), warn: true),
                  ],
                ),
                const SizedBox(height: MachvonV2Space.s8),
                FactLine(label: context.t('mob.ai.finding.proposed'), value: findingStatusLabel(context, finding.status)),
                if (decided != null) FactLine(label: context.t('mob.ai.finding.decided'), value: findingStatusLabel(context, decided)),
                if (finding.text.isNotEmpty) Text(finding.text, style: text.body),
                const SizedBox(height: MachvonV2Space.s4),
                Text(context.t('mob.ai.finding.signal', <String, Object>{'signal': confidenceLabel(context, finding.confidenceType)}), style: text.caption),
                Text(context.t('mob.ai.finding.evidenceCount', <String, Object>{'verified': finding.verifiedCount, 'total': finding.evidence.length}), style: text.caption),
                if (finding.evidence.isEmpty) Text(context.t('mob.ai.finding.noEvidence'), style: text.body),
                for (final Evidence evidence in finding.evidence) _EvidenceRow(finding: finding, evidence: evidence),
                if (finding.awaitsVerification) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.ai.finding.webOnly'), style: text.caption)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EvidenceRow extends StatelessWidget {
  const _EvidenceRow({required this.finding, required this.evidence});

  final Finding finding;
  final Evidence evidence;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String where = evidenceWhere(context, evidence);
    final String verdict = evidence.verified ? context.t('mob.ai.evidence.verified') : context.t('mob.ai.evidence.notFound');
    final Widget body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(where, style: text.label),
        Text(verdict, style: text.captionStrong),
        if (evidence.quote != null) Text('“${evidence.quote}”', style: text.body, maxLines: 4, overflow: TextOverflow.ellipsis),
      ],
    );
    if (!evidence.hasSource) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: MergeSemantics(child: body));
    }
    return TappableRow(
      semanticLabel: context.t('mob.ai.evidence.aria', <String, Object>{'where': where, 'verdict': verdict}),
      onTap: () => openScreen(context, 'MOB-39', query: <String, String>{'run': finding.runId, 'finding': finding.id, 'evidence': evidence.id}, stacked: true),
      child: Row(
        children: <Widget>[
          Expanded(child: body),
          const ExcludeSemantics(child: Icon(Icons.chevron_right)),
        ],
      ),
    );
  }
}
