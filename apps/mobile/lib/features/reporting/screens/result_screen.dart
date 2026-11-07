import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../read_support/amounts.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../labels.dart';
import '../model/report_view.dart';

/// MOB-21: what the server did with the report: its code (the project and the period), the revision it is, the status, the moment
/// the server received it (never the clock of the phone) and whether it was late, with no way to change a submitted figure. A report
/// that was handed in is corrected by a new revision, which the server reviews again (ST-MOB-012, DIS-07).
Widget buildResultScreen(BuildContext context, ScreenContext screen) => ResultScreen(reportId: screen.pathParameters['reportId'] ?? '');

class ResultScreen extends ConsumerWidget {
  const ResultScreen({required this.reportId, super.key});

  final String reportId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final DateTime Function() now = ref.watch(clockProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.rep.result.title'))),
      body: SafeArea(
        child: DataView<ReportView>(
          cacheKey: 'reporting.result.$reportId',
          read: (MachvonApiClient client) => client.getReportRevision(id: reportId),
          parse: (Object? raw) => parseReportView(raw, fetchedAt: now().toUtc().toIso8601String()),
          asOf: (ReportView view) => view.submittedAt,
          builder: (BuildContext context, Loaded<ReportView> loaded) => _Result(view: loaded.value),
        ),
      ),
    );
  }
}

class _Result extends StatelessWidget {
  const _Result({required this.view});

  final ReportView view;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool handedIn = !view.isDraft;
    final String? submittedAt = view.submittedAt;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space16),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
          child: Semantics(
            header: true,
            liveRegion: true,
            child: Row(
              children: <Widget>[
                ExcludeSemantics(child: Icon(handedIn ? Icons.check_circle : Icons.info_outline, color: theme.colorScheme.primary, size: MachvonSpace.space32)),
                const SizedBox(width: MachvonSpace.space12),
                Expanded(child: Text(handedIn ? context.t('mob.rep.result.done.title') : context.t('mob.rep.result.notSent.title'), style: theme.textTheme.titleLarge)),
              ],
            ),
          ),
        ),
        SectionCard(
          title: context.t('mob.rep.result.facts.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.rep.result.code.label'), value: context.t('mob.rep.header.context.label', <String, Object>{'project': view.context.projectCode, 'period': view.context.periodCode})),
            FactLine(label: context.t('mob.rep.result.revision.label'), value: context.t('mob.rep.result.revision.value', <String, Object>{'revision': view.revision})),
            FactLine(label: context.t('mob.rep.result.status.label'), value: reportStatusLabel(context, view.status)),
            FactLine(label: context.t('mob.rep.result.submittedAt.label'), value: submittedAt == null ? context.t('mob.rep.result.notSubmitted.body') : formatMoment(submittedAt)),
            if (handedIn) FactLine(label: context.t('mob.rep.result.timeliness.label'), value: view.isLate ? context.t('mob.rep.result.late.body') : context.t('mob.rep.result.onTime.body')),
            FactLine(label: context.t('mob.rep.totals.six.label'), value: millionsLabel(context, view.cumulativeTotal)),
            FactLine(label: context.t('mob.rep.totals.ctmtqg.label'), value: millionsLabel(context, view.ctmtqgTotal)),
          ],
        ),
        SectionCard(
          title: context.t('mob.rep.result.next.title'),
          children: <Widget>[
            Text(handedIn ? context.t('mob.rep.result.nextReview.body') : context.t('mob.rep.result.nextDraft.body')),
            const SizedBox(height: MachvonSpace.space8),
            Text(context.t('mob.rep.result.correction.body'), style: theme.textTheme.bodyMedium),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16),
          child: Wrap(
            spacing: MachvonSpace.space8,
            runSpacing: MachvonSpace.space8,
            children: <Widget>[
              FilledButton(
                onPressed: () => openScreen(context, 'MOB-09'),
                child: Text(context.t('mob.rep.result.projects.action')),
              ),
              OutlinedButton(
                onPressed: () => openScreen(context, 'MOB-41', stacked: true),
                child: Text(context.t('mob.rep.result.queue.action')),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
