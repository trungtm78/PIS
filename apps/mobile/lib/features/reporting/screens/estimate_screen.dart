import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../read_support/attempts.dart';
import '../../read_support/widgets.dart';
import '../data/report_providers.dart';
import '../labels.dart';
import '../model/estimate_entry.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../widgets/draft_host.dart';
import '../widgets/draft_text_field.dart';
import '../widgets/money_field.dart';
import '../widgets/notices.dart';

/// MOB-56: the estimate of the disbursement at the end of a month, with the assumption it rests on (CAP-13). It is not a part of the
/// report: it is a command of the capital plan, made while online (an estimate is a promise the server dates and versions), and what
/// is typed is kept on the phone until it is sent. Entering the month again makes a new version on the server.
Widget buildEstimateScreen(BuildContext context, ScreenContext screen) => EstimateScreen(draftId: screen.pathParameters['draftId'] ?? '');

class EstimateScreen extends StatelessWidget {
  const EstimateScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return DraftHost(
      draftId: draftId,
      screenId: 'MOB-56',
      title: context.t('mob.rep.estimate.title'),
      body: (BuildContext context, DraftSession session) => _Estimate(session: session),
    );
  }
}

class _Estimate extends ConsumerStatefulWidget {
  const _Estimate({required this.session});

  final DraftSession session;

  @override
  ConsumerState<_Estimate> createState() => _EstimateState();
}

class _EstimateState extends ConsumerState<_Estimate> {
  final AttemptRegistry _attempts = AttemptRegistry();
  late EstimateEntry _entry = ref.read(reportDraftsProvider).requireValue.readEstimate(widget.session.snapshot.id);
  bool _submitted = false;
  bool _busy = false;
  ReportProblem? _refusal;
  bool _lost = false;
  String? _sentMonth;

  void _change(EstimateEntry next) {
    ref.read(reportDraftsProvider).requireValue.writeEstimate(widget.session.snapshot.id, next);
    setState(() {
      _entry = next;
      _sentMonth = null;
    });
  }

  Future<void> _send() async {
    setState(() => _submitted = true);
    final ReportContext? reportContext = widget.session.snapshot.context;
    if (_busy || reviewEstimate(_entry).isNotEmpty || reportContext == null || ref.read(sessionProvider).isReadOnly) return;
    setState(() {
      _busy = true;
      _refusal = null;
      _lost = false;
    });
    final CapScheduleInput body = estimateBody(_entry, projectId: widget.session.form.projectId, planYear: reportContext.fiscalYear);
    final String month = _entry.month;
    try {
      await ref.read(apiClientProvider).registerDisbursementSchedule(body, attempt: _attempts.forPayload(body.toJson().toString()));
      _attempts.done();
      ref.read(reportDraftsProvider).requireValue.writeEstimate(widget.session.snapshot.id, const EstimateEntry());
      if (!mounted) return;
      setState(() {
        _entry = const EstimateEntry();
        _submitted = false;
        _sentMonth = month;
      });
    } on ApiError catch (error) {
      _attempts.ended(error);
      if (!mounted) return;
      setState(() {
        _lost = error.code == networkErrorCode;
        _refusal = _lost ? null : problemOf(error);
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool offline = ref.watch(reachabilityProvider) == Reachability.offline;
    final bool readOnly = ref.watch(sessionProvider).isReadOnly;
    final Map<String, EstimateProblem> problems = _submitted ? reviewEstimate(_entry) : const <String, EstimateProblem>{};
    final bool enabled = !readOnly && !_busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(context.t('mob.rep.estimate.note.body'), style: Theme.of(context).textTheme.bodyMedium),
        if (_sentMonth != null) NoticeLine(icon: Icons.check_circle_outline, text: context.t('mob.rep.estimate.sent.body', <String, Object>{'month': _sentMonth!})),
        if (_refusal != null) NoticeLine(icon: Icons.error_outline, error: true, text: problemMessage(context, _refusal!)),
        if (_lost) NoticeLine(icon: Icons.sync_problem, text: context.t('mob.rep.estimate.lost.body')),
        if (offline) NoticeLine(icon: Icons.cloud_off_outlined, text: context.t('mob.rep.estimate.offline.body')),
        if (widget.session.snapshot.context == null) NoticeLine(icon: Icons.info_outline, text: context.t('mob.rep.estimate.noContext.body')),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: _entry.month.isEmpty ? null : _entry.month,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: context.t('mob.rep.estimate.month.label'),
            errorText: problems['month'] == null ? null : context.t('mob.rep.estimate.month.required'),
          ),
          hint: Text(context.t('mob.rep.estimate.month.choose')),
          items: <DropdownMenuItem<String>>[
            for (int month = 1; month <= kAdjustmentMonth; month += 1)
              DropdownMenuItem<String>(
                value: month.toString(),
                child: Text(month == kAdjustmentMonth ? context.t('mob.rep.estimate.month.adjustment') : context.t('mob.rep.estimate.month.option', <String, Object>{'month': month})),
              ),
          ],
          onChanged: enabled ? (String? month) => _change(_entry.copyWith(month: month ?? '')) : null,
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: _entry.source,
          isExpanded: true,
          decoration: InputDecoration(labelText: context.t('mob.rep.estimate.source.label')),
          items: <DropdownMenuItem<String>>[for (final CellKey key in kCells) DropdownMenuItem<String>(value: key.id, child: Text(cellLabel(context, key)))],
          onChanged: enabled ? (String? source) => _change(_entry.copyWith(source: source)) : null,
        ),
        MoneyField(
          label: context.t('mob.rep.estimate.amount.label'),
          value: _entry.amount,
          enabled: enabled,
          error: switch (problems['amount']) {
            EstimateProblem.amountRequired => context.t('mob.rep.field.required.body'),
            EstimateProblem.amountInvalid => context.t('mob.rep.field.invalid.body'),
            _ => null,
          },
          onChanged: (String typed) => _change(_entry.copyWith(amount: typed)),
        ),
        DraftTextField(
          label: context.t('mob.rep.estimate.assumption.label'),
          value: _entry.assumption,
          enabled: enabled,
          maxLines: 4,
          helper: context.t('mob.rep.estimate.assumption.help'),
          error: switch (problems['assumption']) {
            EstimateProblem.assumptionRequired => context.t('mob.rep.estimate.assumption.required'),
            EstimateProblem.assumptionTooLong => context.t('mob.rep.field.tooLong.body'),
            EstimateProblem.assumptionInvalid => context.t('mob.rep.field.explanationInvalid.body'),
            _ => null,
          },
          onChanged: (String typed) => _change(_entry.copyWith(assumption: typed)),
        ),
        DraftTextField(
          label: context.t('mob.rep.estimate.reason.label'),
          value: _entry.reason,
          enabled: enabled,
          maxLines: 2,
          helper: context.t('mob.rep.estimate.reason.help'),
          error: problems['reason'] == null ? null : context.t('mob.rep.field.tooLong.body'),
          onChanged: (String typed) => _change(_entry.copyWith(reason: typed)),
        ),
        const SizedBox(height: 8),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
          // A phone flagged offline by the very attempt whose answer was lost must still be able to send it again: that request is the probe.
          onPressed: !enabled || (offline && !_lost) ? null : _send,
          child: Text(_busy ? context.t('mob.rep.estimate.send.pending') : context.t('mob.rep.estimate.send.action')),
        ),
        const SizedBox(height: 8),
        FactLine(label: context.t('mob.rep.estimate.year.label'), value: '${widget.session.snapshot.context?.fiscalYear ?? ''}'),
      ],
    );
  }
}
