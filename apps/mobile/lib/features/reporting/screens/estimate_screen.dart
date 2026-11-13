import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/session/session.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../read_support/attempts.dart';
import '../../read_support/navigate.dart';
import '../data/report_providers.dart';
import '../labels.dart';
import '../model/estimate_entry.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../widgets/draft_host.dart';
import '../widgets/draft_text_field.dart';
import '../widgets/money_field.dart';
import '../widgets/notices.dart';
import '../widgets/step_parts.dart';

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
      ownBar: true,
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
    final DraftSession session = widget.session;
    final Map<String, EstimateProblem> problems = _submitted ? reviewEstimate(_entry) : const <String, EstimateProblem>{};
    final bool enabled = !readOnly && !_busy;
    final bool noContext = session.snapshot.context == null;
    // A phone flagged offline by the very attempt whose answer was lost must still be able to send it again: that request is the probe.
    final bool waitsForNetwork = offline && !_lost;
    final String? why = noContext ? context.t('mob.rep.estimate.noContext.body') : (waitsForNetwork ? context.t('mob.rep.estimate.offline.body') : null);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              ?session.scrollingContext,
              DraftNotices(snapshot: session.snapshot, status: session.status, referenceProblem: session.referenceProblem),
              StepNote(context.t('mob.rep.estimate.note.body')),
              if (_sentMonth != null) NoticePanel(tone: NoticeTone.ok, title: context.t('mob.rep.estimate.sent.body', <String, Object>{'month': _sentMonth!})),
              if (_refusal != null) NoticePanel(tone: NoticeTone.problem, title: problemMessage(context, _refusal!)),
              if (_lost) NoticePanel(tone: NoticeTone.warning, icon: Icons.sync_problem, title: context.t('mob.rep.estimate.lost.body')),
              StepFields(
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
                    child: DropdownButtonFormField<String>(
                      initialValue: _entry.month.isEmpty ? null : _entry.month,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: context.t('mob.rep.estimate.month.label'),
                        errorText: problems['month'] == null ? null : context.t('mob.rep.estimate.month.required'),
                        constraints: const BoxConstraints(minHeight: MachvonV2Size.actionButton),
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
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
                    child: DropdownButtonFormField<String>(
                      initialValue: _entry.source,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: context.t('mob.rep.estimate.source.label'), constraints: const BoxConstraints(minHeight: MachvonV2Size.actionButton)),
                      items: <DropdownMenuItem<String>>[for (final CellKey key in kCells) DropdownMenuItem<String>(value: key.id, child: Text(cellLabel(context, key)))],
                      onChanged: enabled ? (String? source) => _change(_entry.copyWith(source: source)) : null,
                    ),
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
                ],
              ),
              InfoRow(label: context.t('mob.rep.estimate.year.label'), value: noContext ? null : '${session.snapshot.context!.fiscalYear}'),
            ],
          ),
        ),
        ActionBar(
          primary: ActionBarButton(
            label: _busy ? context.t('mob.rep.estimate.send.pending') : context.t('mob.rep.estimate.send.action'),
            onPressed: !enabled || noContext || waitsForNetwork ? null : _send,
          ),
          secondary: ActionBarButton(label: context.t('mob.rep.step.back.action'), onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22')),
          why: why,
        ),
      ],
    );
  }
}
