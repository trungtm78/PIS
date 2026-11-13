import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/context_line.dart';
import '../../../core/widgets/stat_strip.dart';
import '../../../core/widgets/state_view.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/underline_tabs.dart';
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
    return AppScaffold(
      title: context.t('mob.ai.runs.title'),
      body: FreshRead<RunList>(
        resource: 'runs',
        read: (MachvonApiClient client) async => parseRunList(await readMerged(client, 'get_resources_analysis_run', query: <String, Object?>{'limit': 50}, maxPages: 4)),
        isEmpty: (RunList list) => list.runs.isEmpty,
        builder: (BuildContext context, RunList list) => ListView(
          children: <Widget>[
            const AiNotice(),
            for (int index = 0; index < list.runs.length; index += 1) _RunRow(run: list.runs[index], dividerAbove: index > 0),
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
  const _RunRow({required this.run, required this.dividerAbove});

  final Run run;
  final bool dividerAbove;

  @override
  Widget build(BuildContext context) {
    final String facts = context.t('mob.ai.runs.row.facts', <String, Object>{'status': runStatusLabel(context, run.status), 'findings': run.findingCount, 'reviewed': run.reviewedCount});
    return AiRow(
      title: run.packageCode,
      subtitle: run.contractorName,
      caption: facts,
      dividerAbove: dividerAbove,
      semanticLabel: context.t('mob.ai.runs.row.aria', <String, Object>{'package': run.packageCode, 'contractor': run.contractorName, 'facts': facts}),
      onTap: () => openScreen(context, 'MOB-38', query: <String, String>{'run': run.id}, stacked: true),
    );
  }
}

class _RunFindings extends StatelessWidget {
  const _RunFindings({required this.runId});

  final String runId;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
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
        if (widget.list.asOf != null) ContextLine(parts: <String>[context.t('mob.ai.findings.asOf', <String, Object>{'time': formatMoment(widget.list.asOf!)})]),
        SectionCard(
          title: context.t('mob.ai.findings.run.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.ai.findings.run.package'), value: run.packageCode),
            FactLine(label: context.t('mob.ai.findings.run.contractor'), value: run.contractorName),
            FactLine(label: context.t('mob.ai.findings.run.status'), value: runStatusLabel(context, run.status)),
          ],
        ),
        StatStrip(
          cells: <StatCell>[
            StatCell(value: '${run.findingCount}', label: context.t('mob.ai.findings.stat.findings')),
            StatCell(value: '${run.reviewedCount}', label: context.t('mob.ai.findings.stat.reviewed')),
            StatCell(
              value: '${run.missingSourceCount}',
              label: context.t('mob.ai.findings.stat.missing'),
              band: run.missingSourceCount > 0 ? DeadlineBand.soon : null,
              bandText: run.missingSourceCount > 0 ? context.t('mob.ai.findings.stat.missing.band') : null,
            ),
          ],
        ),
        if (run.failureCode != null) ...<Widget>[
          StatusBanner(text: context.t('mob.ai.findings.run.failed'), tone: BannerTone.late),
          Padding(padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8), child: Text(run.failureCode!, style: text.caption)),
        ],
        UnderlineTabs(
          index: _View.values.indexOf(_view),
          onChanged: (int index) => setState(() => _view = _View.values[index]),
          tabs: <TabOption>[
            TabOption(label: context.t('mob.ai.findings.view.all')),
            TabOption(label: context.t('mob.ai.findings.view.awaiting')),
            TabOption(label: context.t('mob.ai.findings.view.missing')),
          ],
        ),
        if (widget.list.findings.isEmpty)
          StateView(kind: StateKind.empty, title: context.t('mob.ai.findings.none'), body: context.t('mob.ai.findings.none.body'))
        else if (shown.isEmpty)
          StateView(
            kind: StateKind.empty,
            icon: Icons.filter_alt_off_outlined,
            title: context.t('mob.ai.findings.noneInView'),
            body: context.t('mob.ai.findings.noneInView.body'),
            actionLabel: context.t('mob.ai.findings.view.clear'),
            onAction: () => setState(() => _view = _View.all),
          ),
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

/// One finding. It reads, and it opens the sources it cites; it has no other control. What the model proposed is told by a glyph, the words
/// and the tone together, never by colour alone.
class FindingCard extends StatelessWidget {
  const FindingCard({required this.finding, super.key});

  final Finding finding;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final String? decided = finding.finalStatus;
    return SectionCard(
      title: context.t('mob.ai.finding.heading', <String, Object>{'criterion': finding.criterionId}),
      semanticLabel: context.t('mob.ai.finding.aria', <String, Object>{'criterion': finding.criterionId}),
      children: <Widget>[
        Pills(
          pills: <StatusPill>[
            StatusPill(label: context.t('mob.ai.finding.aiLabel')),
            if (finding.awaitsVerification) StatusPill(label: context.t('mob.ai.finding.needsVerification'), warn: true),
            if (finding.missingSource) StatusPill(label: context.t('mob.ai.finding.missingSource'), warn: true),
          ],
        ),
        const SizedBox(height: MachvonV2Space.s8),
        _VerdictLine(label: context.t('mob.ai.finding.proposed'), status: finding.status),
        if (decided != null) _VerdictLine(label: context.t('mob.ai.finding.decided'), status: decided),
        if (finding.text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s4), child: Text(finding.text, style: text.body)),
        const SizedBox(height: MachvonV2Space.s4),
        Text(context.t('mob.ai.finding.signal', <String, Object>{'signal': confidenceLabel(context, finding.confidenceType)}), style: text.caption),
        Text(context.t('mob.ai.finding.evidenceCount', <String, Object>{'verified': finding.verifiedCount, 'total': finding.evidence.length}), style: text.caption),
        if (finding.evidence.isEmpty) Text(context.t('mob.ai.finding.noEvidence'), style: text.body),
        for (final Evidence evidence in finding.evidence) _EvidenceRow(finding: finding, evidence: evidence),
        if (finding.awaitsVerification) Padding(padding: const EdgeInsets.only(top: MachvonV2Space.s8), child: Text(context.t('mob.ai.finding.webOnly'), style: text.caption)),
      ],
    );
  }
}

/// "AI proposed: Supported": the glyph and the tone of the verdict, then the label and the words, read as one.
class _VerdictLine extends StatelessWidget {
  const _VerdictLine({required this.label, required this.status});

  final String label;
  final String status;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final ({IconData icon, MachvonTone tone}) shape = findingTone(status);
    final Color mark = context.semantic.onSoft(shape.tone);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ExcludeSemantics(child: SizedBox(height: 22, child: Center(child: Icon(shape.icon, size: 18, color: mark)))),
            const SizedBox(width: MachvonV2Space.s8),
            Expanded(
              child: Wrap(
                spacing: MachvonV2Space.s8,
                children: <Widget>[
                  Text('$label:', style: text.caption),
                  Text(findingStatusLabel(context, status), style: text.bodyStrong),
                ],
              ),
            ),
          ],
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
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String where = evidenceWhere(context, evidence);
    final String verdict = evidence.verified ? context.t('mob.ai.evidence.verified') : context.t('mob.ai.evidence.notFound');
    final MachvonTone tone = evidence.verified ? MachvonTone.success : MachvonTone.warning;
    final Widget body = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ExcludeSemantics(child: SizedBox(height: 22, child: Center(child: Icon(evidence.verified ? Icons.task_alt : Icons.report_problem_outlined, size: 18, color: context.semantic.onSoft(tone))))),
        const SizedBox(width: MachvonV2Space.s8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(where, style: text.bodyStrong),
              Text(verdict, style: text.caption),
              if (evidence.quote != null) Text('“${evidence.quote}”', style: text.body.copyWith(color: v2.palette.ink2), maxLines: 4, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
        if (evidence.hasSource) ExcludeSemantics(child: Icon(Icons.chevron_right, color: v2.palette.ink2)),
      ],
    );
    if (!evidence.hasSource) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: MergeSemantics(child: body));
    }
    return TapTarget(
      minHeight: 48,
      semanticLabel: context.t('mob.ai.evidence.aria', <String, Object>{'where': where, 'verdict': verdict}),
      onTap: () => openScreen(context, 'MOB-39', query: <String, String>{'run': finding.runId, 'finding': finding.id, 'evidence': evidence.id}, stacked: true),
      child: SizedBox(width: double.infinity, child: Padding(padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8), child: body)),
    );
  }
}
