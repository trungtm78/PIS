import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/amounts.dart';
import '../../read_support/data_view.dart';
import '../../read_support/loaded.dart';
import '../../read_support/moment.dart';
import '../../read_support/money.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../approval_models.dart';
import '../approval_support.dart';

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

/// MOB-24: one approval. What the record is, the comparison with the revision before it, and the evidence attached; then the
/// two decisions, as buttons that lead to a confirmation (MOB-25) or to the return form (MOB-26). Offline, or on a copy, the
/// buttons are disabled and the screen says why: the approval is never queued.
Widget buildApprovalDetailScreen(BuildContext context, ScreenContext screen) => ApprovalDetailScreen(taskId: screen.pathParameters['taskId'] ?? '');

class ApprovalDetailScreen extends ConsumerWidget {
  const ApprovalDetailScreen({required this.taskId, super.key});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool offline = isOffline(ref);
    final SessionSnapshot session = ref.watch(sessionProvider);
    return ScreenFrame(
      title: context.t('mob.apv.detail.title'),
      body: DataView<ApprovalDetail>(
        cacheKey: 'approvals.detail.$taskId',
        reloadKey: ref.watch(approvalsChangedProvider),
        read: (MachvonApiClient client) => readApprovalDetail(client, taskId),
        parse: parseApprovalDetail,
        builder: (BuildContext context, Loaded<ApprovalDetail> loaded) => _DetailBody(
          detail: loaded.value,
          gate: gateOf(task: loaded.value.task, offline: offline, fromCopy: loaded.fromCache, session: session),
        ),
      ),
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.detail, required this.gate});

  final ApprovalDetail detail;
  final DecisionGate gate;

  @override
  Widget build(BuildContext context) {
    final ApprovalTask task = detail.task;
    final bool open = gate == DecisionGate.open;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.apv.detail.content.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.apv.detail.content.type'), value: businessTypeLabel(context, task.businessType)),
            if (task.stepName.isNotEmpty) FactLine(label: context.t('mob.apv.detail.content.step'), value: task.stepName),
            if (task.amountVnd != null) FactLine(label: context.t('mob.apv.detail.content.amount'), value: millionsLabel(context, task.amountVnd)),
            if (detail.unitName != null) FactLine(label: context.t('mob.apv.detail.content.unit'), value: detail.unitName!),
            FactLine(label: context.t('mob.apv.detail.content.due'), value: formatMoment(task.dueAt)),
            FactLine(label: context.t('mob.apv.detail.content.status'), value: taskStatusLabel(context, task.status)),
            if (detail.report != null) FactLine(label: context.t('mob.apv.detail.content.record'), value: '${detail.report!.projectCode} · ${detail.report!.projectName} · ${detail.report!.periodCode}'),
          ],
        ),
        _ComparisonCard(detail: detail),
        _EvidenceCard(report: detail.report),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: MachvonSpace.space16, vertical: MachvonSpace.space8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              if (!open)
                Semantics(
                  liveRegion: true,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: MachvonSpace.space8),
                    child: Text(gateText(context, gate), style: Theme.of(context).textTheme.bodyMedium),
                  ),
                ),
              FilledButton(
                onPressed: open ? () => openScreen(context, 'MOB-25', pathSuffix: '/${Uri.encodeComponent(task.id)}', stacked: true) : null,
                child: Text(context.t('mob.apv.detail.approve.action')),
              ),
              const SizedBox(height: MachvonSpace.space8),
              OutlinedButton(
                onPressed: open ? () => openScreen(context, 'MOB-26', pathSuffix: '/${Uri.encodeComponent(task.id)}', stacked: true) : null,
                child: Text(context.t('mob.apv.detail.return.action')),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ComparisonCard extends StatelessWidget {
  const _ComparisonCard({required this.detail});

  final ApprovalDetail detail;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ReportFigures? report = detail.report;
    final ReportFigures? previous = detail.previous;
    final List<CellChange>? changes = detail.changes;
    final String language = AppStrings.of(context).language;
    return SectionCard(
      title: context.t('mob.apv.detail.compare.title'),
      children: <Widget>[
        if (report == null)
          Text(context.t('mob.apv.detail.compare.unavailable'), style: theme.textTheme.bodyMedium)
        else if (previous == null || changes == null)
          Text(context.t('mob.apv.detail.compare.first'), style: theme.textTheme.bodyMedium)
        else ...<Widget>[
          Text(context.t('mob.apv.detail.compare.revision', <String, Object>{'current': report.revision, 'previous': previous.revision}), style: theme.textTheme.bodyMedium),
          if (report.amendmentReason != null) Text(context.t('mob.apv.detail.compare.amendment', <String, Object>{'reason': report.amendmentReason!}), style: theme.textTheme.bodySmall),
          for (final CellChange change in changes) _CellLine(change: change, language: language),
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(
              context.t('mob.apv.detail.compare.total', <String, Object>{
                'previous': millionsLabel(context, previous.totalVnd),
                'current': millionsLabel(context, report.totalVnd),
                'change': _change(context, differenceDong(report.totalVnd, previous.totalVnd), language),
              }),
              style: theme.textTheme.bodyLarge,
            ),
          ),
          Text(context.t('mob.apv.detail.compare.ctmtqg', <String, Object>{'value': millionsLabel(context, report.ctmtqgVnd)}), style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}

/// The change of an amount as a person reads it: a rise has a plus, a fall a minus, no change says so.
String _change(BuildContext context, String changeVnd, String language) =>
    changeVnd == '0' ? context.t('mob.apv.detail.compare.unchanged') : context.t('mob.read.money.millions', <String, Object>{'value': formatSignedMillions(changeVnd, language)});

class _CellLine extends StatelessWidget {
  const _CellLine({required this.change, required this.language});

  final CellChange change;
  final String language;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: MergeSemantics(
        child: Text(
          context.t('mob.apv.detail.compare.cell', <String, Object>{
            'cell': cellLabel(context, change.bucket, change.level),
            'previous': millionsLabel(context, change.previousVnd),
            'current': millionsLabel(context, change.currentVnd),
            'change': _change(context, change.changeVnd, language),
          }),
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: change.changed ? FontWeight.w700 : FontWeight.w400),
        ),
      ),
    );
  }
}

class _EvidenceCard extends StatelessWidget {
  const _EvidenceCard({required this.report});

  final ReportFigures? report;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final List<Evidence> files = report?.evidence ?? const <Evidence>[];
    return SectionCard(
      title: context.t('mob.apv.detail.evidence.title'),
      children: <Widget>[
        if (files.isEmpty) Text(context.t('mob.apv.detail.evidence.none'), style: theme.textTheme.bodyMedium),
        for (final Evidence file in files)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
            child: MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(context.t('mob.apv.detail.evidence.file', <String, Object>{'name': file.fileName, 'type': file.contentType, 'size': (file.sizeBytes / 1024).ceil()}), style: theme.textTheme.bodyMedium),
                  if (file.sha256.isNotEmpty) Text(context.t('mob.apv.detail.evidence.hash', <String, Object>{'hash': file.sha256.length > 16 ? '${file.sha256.substring(0, 16)}…' : file.sha256}), style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
