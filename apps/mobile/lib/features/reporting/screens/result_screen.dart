import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/status_pill.dart';
import '../../../core/widgets/work_row.dart';
import '../../read_support/clock.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/navigate.dart';
import '../labels.dart';
import '../model/report_view.dart';
import '../widgets/step_parts.dart';

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
    return AppScaffold(
      title: context.t('mob.rep.result.title'),
      body: DataView<ReportView>(
        cacheKey: 'reporting.result.$reportId',
        read: (MachvonApiClient client) => client.getReportRevision(id: reportId),
        parse: (Object? raw) => parseReportView(raw, fetchedAt: now().toUtc().toIso8601String()),
        asOf: (ReportView view) => view.submittedAt,
        builder: (BuildContext context, Loaded<ReportView> loaded) => ResultBody(
          view: loaded.value,
          onProjects: () => openScreen(context, 'MOB-09'),
          onQueue: () => openScreen(context, 'MOB-41', stacked: true),
        ),
      ),
    );
  }
}

/// The tone of the status of a report: accepted is green, waiting for the reviewer is blue, what needs the person again is amber.
MachvonTone _statusTone(String status) {
  switch (status) {
    case 'ACCEPTED':
      return MachvonTone.success;
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return MachvonTone.info;
    case 'RETURNED':
    case 'AMENDMENT_REQUESTED':
      return MachvonTone.warning;
    default:
      return MachvonTone.neutral;
  }
}

/// The result as rows: the headline that says whether the server has the report, the facts with the state as a pill, what comes next, and in the
/// sticky bar the two ways on (the projects, the send queue). It is pure, so a test or a golden can hold it with no server behind it.
class ResultBody extends StatelessWidget {
  const ResultBody({required this.view, required this.onProjects, required this.onQueue, super.key});

  final ReportView view;
  final VoidCallback onProjects;
  final VoidCallback onQueue;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool handedIn = !view.isDraft;
    final String? submittedAt = view.submittedAt;
    final String status = reportStatusLabel(context, view.status);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s8),
                child: Semantics(
                  header: true,
                  liveRegion: true,
                  child: Row(
                    children: <Widget>[
                      ExcludeSemantics(child: Icon(handedIn ? Icons.check_circle : Icons.info_outline, color: handedIn ? v2.palette.okFg : v2.palette.infoFg, size: MachvonV2Space.s32)),
                      const SizedBox(width: MachvonV2Space.s12),
                      Expanded(child: Text(handedIn ? context.t('mob.rep.result.done.title') : context.t('mob.rep.result.notSent.title'), style: text.title)),
                    ],
                  ),
                ),
              ),
              GroupHeader(title: context.t('mob.rep.result.facts.title')),
              InfoRow(
                label: context.t('mob.rep.result.code.label'),
                value: context.t('mob.rep.header.context.label', <String, Object>{'project': view.context.projectCode, 'period': view.context.periodCode}),
                divider: false,
              ),
              InfoRow(label: context.t('mob.rep.result.revision.label'), value: context.t('mob.rep.result.revision.value', <String, Object>{'revision': view.revision})),
              InfoRow(label: context.t('mob.rep.result.status.label'), value: status, valueWidget: StatusPill(label: status, tone: _statusTone(view.status))),
              InfoRow(label: context.t('mob.rep.result.submittedAt.label'), value: submittedAt == null ? context.t('mob.rep.result.notSubmitted.body') : formatMoment(submittedAt)),
              if (handedIn)
                InfoRow(
                  label: context.t('mob.rep.result.timeliness.label'),
                  value: view.isLate ? context.t('mob.rep.result.late.body') : context.t('mob.rep.result.onTime.body'),
                  valueWidget: StatusPill(
                    label: view.isLate ? context.t('mob.rep.result.late.body') : context.t('mob.rep.result.onTime.body'),
                    tone: view.isLate ? MachvonTone.warning : MachvonTone.success,
                  ),
                ),
              InfoRow(label: context.t('mob.rep.totals.six.label'), value: moneyLabel(context, view.cumulativeTotal)),
              InfoRow(label: context.t('mob.rep.totals.ctmtqg.label'), value: moneyLabel(context, view.ctmtqgTotal)),
              GroupHeader(title: context.t('mob.rep.result.next.title')),
              StepNote(handedIn ? context.t('mob.rep.result.nextReview.body') : context.t('mob.rep.result.nextDraft.body')),
              StepNote(context.t('mob.rep.result.correction.body'), small: true),
            ],
          ),
        ),
        ActionBar(
          primary: ActionBarButton(label: context.t('mob.rep.result.projects.action'), onPressed: onProjects),
          secondary: ActionBarButton(label: context.t('mob.rep.result.queue.action'), onPressed: onQueue),
        ),
      ],
    );
  }
}
