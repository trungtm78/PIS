import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/section_tabs.dart';
import '../../../core/widgets/state_view.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../approval_models.dart';
import '../approval_support.dart';
import 'decision_panels.dart';

/// Reads a task and, when the record is a report, the report and the revision it corrects; the unit is read for its name.
/// Those three are separate rights and each is optional: a refusal leaves the part out, a lost connection fails the read so
/// that the copy is shown (and a copy never lets a decision through).
Future<Object?> readApprovalDetail(MachvonApiClient client, String taskId, {bool withRecord = true}) async {
  final Object? task = await client.execute('get_resources_approval_task_id', path: <String, Object?>{'id': taskId});
  final ApprovalTask? parsed = parseApprovalTask(task);
  if (!withRecord || parsed == null) return <String, Object?>{'task': task};
  Object? report;
  Object? previous;
  if (parsed.businessType == reportAcceptType && parsed.resourceId.isNotEmpty) {
    report = await _optional(() => client.execute('getReportRevision', path: <String, Object?>{'id': parsed.resourceId}));
    final String? before = report is Map ? report['supersedes_id'] as String? : null;
    if (before != null) previous = await _optional(() => client.execute('getReportRevision', path: <String, Object?>{'id': before}));
  }
  final Object? unit = parsed.unitId == null ? null : await _optional(() => client.execute('get_resources_organization_unit_id', path: <String, Object?>{'id': parsed.unitId}));
  return <String, Object?>{'task': task, 'report': report, 'previous': previous, 'unit': unit};
}

Future<Object?> _optional(Future<Object?> Function() read) async {
  try {
    return await read();
  } on ApiError catch (error) {
    if (error.code == networkErrorCode) rethrow;
    return null;
  }
}

/// MOB-24: one approval. What the record is and what is at stake (the amount in full, the unit, the step, the deadline), the comparison with
/// the revision before it, and the evidence attached; then the two decisions on a bar that stays at the bottom. Each opens a sheet with the
/// facts of the decision and its button (the confirmation is MOB-25 and the return MOB-26 as sheets; the screens stay for a deep link).
/// Offline, or on a copy, the buttons are disabled and the bar says why: the approval is never queued.
Widget buildApprovalDetailScreen(BuildContext context, ScreenContext screen) => ApprovalDetailScreen(taskId: screen.pathParameters['taskId'] ?? '');

class ApprovalDetailScreen extends ConsumerWidget {
  const ApprovalDetailScreen({required this.taskId, super.key});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool offline = isOffline(ref);
    final SessionSnapshot session = ref.watch(sessionProvider);
    return AppScaffold(
      title: context.t('mob.apv.detail.title'),
      body: DataView<ApprovalDetail>(
        cacheKey: 'approvals.detail.$taskId',
        reloadKey: ref.watch(approvalsChangedProvider),
        read: (MachvonApiClient client) => readApprovalDetail(client, taskId),
        parse: parseApprovalDetail,
        builder: (BuildContext context, Loaded<ApprovalDetail> loaded) => _DetailBody(
          detail: loaded.value,
          fromCopy: loaded.fromCache,
          gate: gateOf(task: loaded.value.task, offline: offline, fromCopy: loaded.fromCache, session: session),
        ),
      ),
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.detail, required this.fromCopy, required this.gate});

  final ApprovalDetail detail;
  final bool fromCopy;
  final DecisionGate gate;

  @override
  Widget build(BuildContext context) {
    final ApprovalTask task = detail.task;
    final bool open = gate == DecisionGate.open;
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            children: <Widget>[
              if (task.overdue && task.isPending) StatusBanner(tone: BannerTone.late, text: context.t('mob.apv.detail.late.banner', <String, Object>{'time': formatMoment(task.dueAt)})),
              if (task.escalated && task.isPending) StatusBanner(tone: BannerTone.warning, text: context.t('mob.apv.detail.escalated.banner')),
              Padding(
                padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s16, MachvonV2Space.s12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Semantics(container: true, header: true, child: Text(businessTypeLabel(context, task.businessType), style: text.title, textScaler: cappedScaler(context, MachvonV2Type.titleScaleCap))),
                    if (task.amountVnd != null)
                      Padding(
                        padding: const EdgeInsets.only(top: MachvonV2Space.s4),
                        child: Semantics(
                          label: '${context.t('mob.apv.detail.content.amount')}: ${moneyFullLabel(context, task.amountVnd)}',
                          excludeSemantics: true,
                          child: Text(moneyFullLabel(context, task.amountVnd), style: text.title.copyWith(color: v2.palette.primaryStrong)),
                        ),
                      ),
                  ],
                ),
              ),
              // One purpose a tab: what is asked, what changed against the revision before, and the files that prove it. The decision stays in the bar below on every tab.
              SectionTabs(
                tabs: <SectionTab>[
                  SectionTab(
                    label: context.t('mob.apv.detail.content.title'),
                    children: <Widget>[
                      InfoRow(label: context.t('mob.apv.detail.content.type'), value: businessTypeLabel(context, task.businessType), divider: false),
                      InfoRow(label: context.t('mob.apv.detail.content.step'), value: task.stepName),
                      InfoRow(label: context.t('mob.apv.detail.content.unit'), value: detail.unitName),
                      InfoRow(label: context.t('mob.apv.detail.content.due'), value: formatMoment(task.dueAt)),
                      InfoRow(label: context.t('mob.apv.detail.content.status'), value: taskStatusLabel(context, task.status)),
                      if (detail.report != null)
                        InfoRow(label: context.t('mob.apv.detail.content.record'), value: '${detail.report!.projectCode} · ${detail.report!.projectName} · ${detail.report!.periodCode}'),
                    ],
                  ),
                  SectionTab(label: context.t('mob.apv.detail.compare.title'), children: <Widget>[_Comparison(detail: detail)]),
                  SectionTab(label: context.t('mob.apv.detail.evidence.title'), count: detail.report?.evidence.length, children: <Widget>[_Evidence(report: detail.report)]),
                ],
              ),
              const SizedBox(height: MachvonV2Space.s16),
            ],
          ),
        ),
        ActionBar(
          primary: ActionBarButton(
            label: context.t('mob.apv.detail.approve.action'),
            onPressed: open ? () => showApprovalConfirmSheet(context, task: task, unitName: detail.unitName, fromCopy: fromCopy) : null,
          ),
          secondary: ActionBarButton(
            label: context.t('mob.apv.detail.return.action'),
            onPressed: open ? () => showApprovalReturnSheet(context, task: task, unitName: detail.unitName, fromCopy: fromCopy) : null,
          ),
          why: open ? null : gateText(context, gate),
        ),
      ],
    );
  }
}

/// The change of an amount as a person reads it: a rise has a plus, a fall a minus, no change says so.
String _change(BuildContext context, String changeVnd) => changeVnd == '0' ? context.t('mob.apv.detail.compare.unchanged') : signedMoneyLabel(context, changeVnd);

class _Comparison extends StatelessWidget {
  const _Comparison({required this.detail});

  final ApprovalDetail detail;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final ReportFigures? report = detail.report;
    final ReportFigures? previous = detail.previous;
    final List<CellChange>? changes = detail.changes;
    Widget note(String line, {Color? color}) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
          child: Text(line, style: text.body.copyWith(color: color ?? v2.palette.ink2)),
        );
    if (report == null) return note(context.t('mob.apv.detail.compare.unavailable'));
    if (previous == null || changes == null) return note(context.t('mob.apv.detail.compare.first'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        note(context.t('mob.apv.detail.compare.revision', <String, Object>{'current': report.revision, 'previous': previous.revision})),
        if (report.amendmentReason != null) note(context.t('mob.apv.detail.compare.amendment', <String, Object>{'reason': report.amendmentReason!})),
        for (final CellChange change in changes)
          _FigureRow(
            label: cellLabel(context, change.bucket, change.level),
            previousVnd: change.previousVnd,
            currentVnd: change.currentVnd,
            changeVnd: change.changeVnd,
            changed: change.changed,
          ),
        _FigureRow(
          label: context.t('mob.apv.detail.compare.totalLabel'),
          previousVnd: previous.totalVnd,
          currentVnd: report.totalVnd,
          changeVnd: differenceDong(report.totalVnd, previous.totalVnd),
          changed: true,
          total: true,
        ),
        note(context.t('mob.apv.detail.compare.ctmtqg', <String, Object>{'value': moneyLabel(context, report.ctmtqgVnd)})),
      ],
    );
  }
}

/// One figure of two revisions: what the record says now, and under it what it said before and what changed (a fall carries a minus sign and
/// a down arrow, a rise a plus sign and an up arrow: never colour alone). A screen reader gets the whole sentence.
class _FigureRow extends StatelessWidget {
  const _FigureRow({required this.label, required this.previousVnd, required this.currentVnd, required this.changeVnd, required this.changed, this.total = false});

  final String label;
  final String previousVnd;
  final String currentVnd;
  final String changeVnd;
  final bool changed;
  /// The cumulative total: its label is a heading figure and its sentence has no cell name.
  final bool total;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final String change = _change(context, changeVnd);
    final String previous = moneyLabel(context, previousVnd);
    final String current = moneyLabel(context, currentVnd);
    final bool noChange = changeVnd == '0';
    final bool fall = changeVnd.startsWith('-');
    final String spoken = total
        ? context.t('mob.apv.detail.compare.total', <String, Object>{'previous': previous, 'current': current, 'change': change})
        : context.t('mob.apv.detail.compare.cell', <String, Object>{'cell': label, 'previous': previous, 'current': current, 'change': change});
    return Semantics(
      container: true,
      label: spoken,
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          SizedBox(height: 1, child: ColoredBox(color: v2.palette.line)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(flex: 3, child: Text(label, style: total ? text.bodyStrong : text.body)),
                const SizedBox(width: MachvonV2Space.s12),
                Expanded(
                  flex: 4,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      Text(current, textAlign: TextAlign.end, style: text.bodyStrong),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: <Widget>[
                          if (changed && !noChange) ...<Widget>[Icon(fall ? Icons.arrow_downward : Icons.arrow_upward, size: 14, color: v2.palette.ink2), const SizedBox(width: 2)],
                          Flexible(
                            child: Text(
                              context.t('mob.apv.detail.compare.cellNote', <String, Object>{'previous': previous, 'change': change}),
                              textAlign: TextAlign.end,
                              style: changed && !noChange ? text.captionStrong : text.caption,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Evidence extends StatelessWidget {
  const _Evidence({required this.report});

  final ReportFigures? report;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final MachvonV2 v2 = context.v2;
    final List<Evidence> files = report?.evidence ?? const <Evidence>[];
    if (files.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
        child: Text(context.t('mob.apv.detail.evidence.none'), style: text.body.copyWith(color: v2.palette.ink2)),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final Evidence file in files)
          Semantics(
            container: true,
            label: context.t('mob.apv.detail.evidence.file', <String, Object>{'name': file.fileName, 'type': file.contentType, 'size': (file.sizeBytes / 1024).ceil()}),
            excludeSemantics: true,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.attach_file, size: 20, color: v2.palette.ink2),
                  const SizedBox(width: MachvonV2Space.s8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(file.fileName, style: text.bodyStrong),
                        Text(context.t('mob.apv.detail.evidence.meta', <String, Object>{'type': file.contentType, 'size': (file.sizeBytes / 1024).ceil()}), style: text.caption),
                        if (file.sha256.isNotEmpty)
                          Text(context.t('mob.apv.detail.evidence.hash', <String, Object>{'hash': file.sha256.length > 16 ? '${file.sha256.substring(0, 16)}…' : file.sha256}), style: text.caption),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
