import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queue_runner.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../read_support/amounts.dart';
import '../../read_support/navigate.dart';
import '../../read_support/widgets.dart';
import '../../release/telemetry.dart';
import '../data/report_drafts.dart';
import '../data/report_providers.dart';
import '../data/submit_flow.dart';
import '../data/submit_funnel.dart';
import '../labels.dart';
import '../model/report_cells.dart';
import '../model/report_context.dart';
import '../model/report_form.dart';
import '../model/report_review.dart';
import '../model/report_view.dart';
import '../widgets/draft_host.dart';
import '../widgets/notices.dart';

/// MOB-20: the review of the whole report before it is sent (DIS-06): every error that would stop the sending and every warning that
/// would not, all at once and each with the step where it is put right; the change of each cell since the period before; the notes
/// and the files; and the one command that sends the report (ST-MOB-012). The report is sent once: a second tap, a lost answer and a
/// restart find the command that exists and look it up by its key.
Widget buildReviewScreen(BuildContext context, ScreenContext screen) => ReviewScreen(draftId: screen.pathParameters['draftId'] ?? '');

class ReviewScreen extends ConsumerStatefulWidget {
  const ReviewScreen({required this.draftId, super.key});

  final String draftId;

  @override
  ConsumerState<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends ConsumerState<ReviewScreen> {
  /// The report the draft stands for, kept while the draft exists: the server releases the draft when it accepts the report, and the
  /// result screen needs to know which report that was.
  String? _reportId;
  bool _accepted = false;
  bool _shown = false;
  late final SubmitFunnel _funnel = SubmitFunnel(ref.read(telemetryProvider));

  @override
  void initState() {
    super.initState();
    // The queue is kept moving while the person watches the result: a lost answer is looked up, a waiting command is sent.
    ref.read(queueRunnerProvider.future).then((QueueRunner runner) => runner.trigger(), onError: (Object _) {});
  }

  void _remember(String? reportId) {
    if (reportId != null) _reportId = reportId;
  }

  /// Opens the result once the server accepted the report and the report is known: either may come first. The move is made after the
  /// frame, because it may be asked for while the screen is being built.
  void _showResult() {
    if (!_accepted || _shown || _reportId == null) return;
    _shown = true;
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (mounted) context.go('${ref.read(routeTableProvider).locationOf('MOB-21')}/$_reportId');
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AsyncValue<List<QueuedCommand>>>(queuedCommandsProvider, (AsyncValue<List<QueuedCommand>>? previous, AsyncValue<List<QueuedCommand>> next) {
      final SubmitStatus status = submitStatusOf(next.value ?? const <QueuedCommand>[], widget.draftId);
      _funnel.observe(status);
      if (status.stage != SubmitStage.submitted) return;
      _accepted = true;
      _remember(status.reportId);
      _showResult();
    });
    return DraftHost(
      draftId: widget.draftId,
      screenId: 'MOB-20',
      step: 8,
      tellsSending: true,
      title: context.t('mob.rep.review.title'),
      body: (BuildContext context, DraftSession session) {
        _remember(session.snapshot.reportId);
        return _Review(
          session: session,
          funnel: _funnel,
          onReport: (String? reportId) {
            _remember(reportId);
            _showResult();
          },
        );
      },
    );
  }
}

class _Review extends ConsumerStatefulWidget {
  const _Review({required this.session, required this.funnel, required this.onReport});

  final DraftSession session;
  final SubmitFunnel funnel;

  /// Told which report the draft stands for as soon as the submit has made it known.
  final ValueChanged<String?> onReport;

  @override
  ConsumerState<_Review> createState() => _ReviewState();
}

class _ReviewState extends ConsumerState<_Review> {
  bool _busy = false;
  ReportProblem? _problem;
  SubmitResult? _result;
  String? _existingReportId;
  bool _needsConnection = false;
  ReportView? _server;

  @override
  void initState() {
    super.initState();
    _readServer();
  }

  /// What the server's review says of the copy it holds, when the report exists there and the phone is not known to be offline.
  Future<void> _readServer() async {
    final String? reportId = widget.session.snapshot.reportId;
    if (reportId == null || ref.read(reachabilityProvider) == Reachability.offline) return;
    try {
      final ReportView view = await (await ref.read(reportDraftsProvider.future)).fetch(reportId);
      if (mounted) setState(() => _server = view);
    } on ApiError {
      return;
    } on ContractMismatch {
      return;
    }
  }

  Future<void> _submit() async {
    if (_busy) return;
    widget.funnel.started();
    setState(() {
      _busy = true;
      _problem = null;
      _result = null;
      _existingReportId = null;
      _needsConnection = false;
    });
    try {
      final SubmitFlow flow = await ref.read(submitFlowProvider.future);
      final SubmitResult result = await flow.submit(widget.session.snapshot.id);
      widget.onReport(result.reportId);
      if (mounted) setState(() => _result = result);
    } on DraftExists catch (exists) {
      if (mounted) {
        setState(() {
          _problem = ReportProblem.draftExists;
          _existingReportId = exists.reportId;
        });
      }
    } on ApiError catch (error) {
      // The report is made on the server once, with a network; the draft is kept on the phone until there is one.
      if (mounted) {
        setState(() {
          _needsConnection = error.code == networkErrorCode;
          _problem = _needsConnection ? null : problemOf(error);
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final SubmitFlow flow = await ref.read(submitFlowProvider.future);
      final SubmitStatus status = flow.statusOf(widget.session.snapshot.id);
      final QueuedCommand? command = status.command;
      final FlushResult result = command != null && status.stage == SubmitStage.rejected ? await flow.resend(command.id) : await flow.check();
      if (mounted) setState(() => _result = SubmitResult(SubmitOutcome.alreadyPending, blocker: result.blocker));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openExisting() async {
    final String? reportId = _existingReportId;
    if (reportId == null) return;
    final DraftSnapshot snapshot = await (await ref.read(reportDraftsProvider.future)).adoptServerDraft(reportId);
    if (mounted) openStep(context, 'MOB-14', snapshot.id);
  }

  @override
  Widget build(BuildContext context) {
    final DraftSession session = widget.session;
    final ReportForm form = session.form;
    final ReportContext? reportContext = session.snapshot.context;
    final List<Finding> findings = reviewForm(form, reportContext);
    final List<Finding> errors = <Finding>[for (final Finding f in findings) if (f.isError) f];
    final List<Finding> warnings = <Finding>[for (final Finding f in findings) if (!f.isError) f];
    final bool offline = ref.watch(reachabilityProvider) == Reachability.offline;
    final ServerReview? serverReview = _server?.review;
    final bool canSubmit = session.editable && errors.isEmpty && !_busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _SendStatus(session: session, busy: _busy, onCheck: _check),
        if (_problem != null)
          NoticeLine(
            icon: Icons.error_outline,
            error: true,
            text: problemMessage(context, _problem!),
            action: _existingReportId == null
                ? null
                : TextButton(
                    style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                    onPressed: _openExisting,
                    child: Text(context.t('mob.rep.start.existing.action')),
                  ),
          ),
        if (_needsConnection) NoticeLine(icon: Icons.cloud_off_outlined, text: context.t('mob.rep.review.needsConnection.body')),
        if (_result?.outcome == SubmitOutcome.savePending) NoticeLine(icon: Icons.sync, text: context.t('mob.rep.review.savePending.body')),
        if (_result?.outcome == SubmitOutcome.moved) NoticeLine(icon: Icons.sync_problem, error: true, text: context.t('mob.rep.review.moved.body')),
        if (_result?.blocker == FlushBlocker.noDevice) NoticeLine(icon: Icons.sync_problem, text: context.t('mob.rep.review.noDevice.body')),
        const SizedBox(height: 8),
        SectionCard(
          title: context.t('mob.rep.review.errors.title'),
          children: <Widget>[
            if (errors.isEmpty) Text(context.t('mob.rep.review.none.body')) else for (final Finding finding in errors) _FindingRow(finding: finding, draftId: session.snapshot.id),
          ],
        ),
        SectionCard(
          title: context.t('mob.rep.review.warnings.title'),
          children: <Widget>[
            if (warnings.isEmpty) Text(context.t('mob.rep.review.none.body')) else for (final Finding finding in warnings) _FindingRow(finding: finding, draftId: session.snapshot.id),
          ],
        ),
        if (serverReview != null)
          SectionCard(
            title: context.t('mob.rep.review.server.title'),
            children: <Widget>[
              Text(context.t('mob.rep.review.serverNote.body', <String, Object>{'time': asOfLabel(_server!.context.fetchedAt!)}), style: Theme.of(context).textTheme.bodySmall),
              if (serverReview.errors.isEmpty && serverReview.warnings.isEmpty) Text(context.t('mob.rep.review.none.body')),
              for (final Finding finding in <Finding>[...serverReview.errors, ...serverReview.warnings]) _FindingRow(finding: finding, draftId: session.snapshot.id),
            ],
          ),
        _Differences(form: form, reportContext: reportContext),
        _Totals(form: form),
        _Notes(form: form),
        _Files(draftId: session.snapshot.id),
        const SizedBox(height: 16),
        if (errors.isNotEmpty) Text(context.t('mob.rep.review.blocked.body'), style: Theme.of(context).textTheme.bodyMedium),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: canSubmit ? _submit : null,
          child: Text(_busy ? context.t('mob.rep.review.submit.pending') : context.t('mob.rep.review.submit.action')),
        ),
        if (offline) Padding(padding: const EdgeInsets.only(top: 4), child: Text(context.t('mob.rep.review.offline.body'), style: Theme.of(context).textTheme.bodySmall)),
      ],
    );
  }
}

/// Where the sending of the report stands, in the words of MOB.md 4: waiting, on its way, "result unknown" (the answer was lost and the
/// server is asked for it by the key of the command, never sent a second time), refused with the draft kept, or moved on.
class _SendStatus extends StatelessWidget {
  const _SendStatus({required this.session, required this.busy, required this.onCheck});

  final DraftSession session;
  final bool busy;
  final VoidCallback onCheck;

  @override
  Widget build(BuildContext context) {
    final SubmitStatus status = session.status;
    final String? code = status.code;
    final String codeLine = code == null ? '' : ' ${context.t('mob.rep.problem.code.label', <String, Object>{'code': code})}';
    switch (status.stage) {
      case SubmitStage.idle:
      case SubmitStage.submitted:
        return const SizedBox.shrink();
      case SubmitStage.queued:
        return NoticeLine(icon: Icons.schedule, text: context.t('mob.rep.send.queued.body'), action: _actions(context, context.t('mob.rep.send.now.action')));
      case SubmitStage.sending:
        return NoticeLine(icon: Icons.sync, text: context.t('mob.rep.send.sending.body'), action: _actions(context, null));
      case SubmitStage.unknown:
        return NoticeLine(icon: Icons.help_outline, text: context.t('mob.rep.send.unknown.body'), action: _actions(context, context.t('mob.rep.send.check.action')));
      case SubmitStage.rejected:
        return NoticeLine(
          icon: Icons.error_outline,
          error: true,
          text: '${problemMessage(context, problemOfCode(code))}$codeLine ${context.t('mob.rep.send.rejectedKept.body')}',
          action: status.isSubmit ? _actions(context, context.t('mob.rep.send.again.action'), queue: false) : null,
        );
      case SubmitStage.conflict:
        return NoticeLine(
          icon: Icons.sync_problem,
          error: true,
          text: '${context.t('mob.rep.send.conflict.body')}$codeLine',
          action: TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => openScreen(context, 'MOB-42', pathSuffix: '/${status.command!.id}', stacked: true),
            child: Text(context.t('mob.rep.send.compare.action')),
          ),
        );
    }
  }

  /// The button that moves the command on ([primary], when there is one) and the way to the queue, where every command is listed.
  Widget _actions(BuildContext context, String? primary, {bool queue = true}) => Wrap(
        spacing: MachvonSpace.space8,
        children: <Widget>[
          if (primary != null) TextButton(style: TextButton.styleFrom(minimumSize: const Size(48, 48)), onPressed: busy ? null : onCheck, child: Text(primary)),
          if (queue) TextButton(style: TextButton.styleFrom(minimumSize: const Size(48, 48)), onPressed: () => openScreen(context, 'MOB-41', stacked: true), child: Text(context.t('mob.rep.pending.queue.action'))),
        ],
      );
}

class _FindingRow extends StatelessWidget {
  const _FindingRow({required this.finding, required this.draftId});

  final Finding finding;
  final String draftId;

  @override
  Widget build(BuildContext context) {
    final String? screen = screenOfFinding(finding);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonSpace.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(findingMessage(context, finding)),
          if (screen != null)
            TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: () => openStep(context, screen, draftId),
              child: Text(context.t('mob.rep.review.fix.action')),
            ),
        ],
      ),
    );
  }
}

/// What each cell added since the period before; a fall is marked in words and in colour.
class _Differences extends StatelessWidget {
  const _Differences({required this.form, required this.reportContext});

  final ReportForm form;
  final ReportContext? reportContext;

  @override
  Widget build(BuildContext context) {
    final bool compared = reportContext != null && kCells.any((CellKey key) => reportContext!.reference(key)?.previous != null);
    return SectionCard(
      title: context.t('mob.rep.review.diff.title'),
      children: <Widget>[
        if (!compared)
          Text(context.t('mob.rep.review.diffNone.body'))
        else
          for (final CellKey key in kCells)
            Builder(
              builder: (BuildContext context) {
                final String? delta = deltaOf(reportContext!.reference(key), form.cell(key).cumulative);
                final bool fall = delta?.startsWith('-') ?? false;
                return FactLine(
                  label: cellLabel(context, key),
                  value: delta == null ? context.t('mob.rep.review.diffUnknown.body') : '${signedMillionsLabel(context, delta)}${fall ? ' · ${context.t('mob.rep.review.diffFall.body')}' : ''}',
                );
              },
            ),
      ],
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.form});

  final ReportForm form;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: context.t('mob.rep.totals.title'),
      children: <Widget>[
        FactLine(label: context.t('mob.rep.totals.six.label'), value: millionsLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative]))),
        FactLine(label: context.t('mob.rep.totals.ctmtqg.label'), value: millionsLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).ctmtqg]))),
        FactLine(label: context.t('mob.rep.registration.total.label'), value: millionsLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).nextMonth]))),
        FactLine(label: context.t('mob.rep.volumes.construction.label'), value: form.construction.trim().isEmpty ? context.t('mob.rep.review.diffUnknown.body') : millionsLabel(context, digitsOf(form.construction))),
        FactLine(label: context.t('mob.rep.basis.title'), value: basisLabel(context, form.basis)),
        Text(context.t('mob.rep.ctmtqg.note.body'), style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _Notes extends StatelessWidget {
  const _Notes({required this.form});

  final ReportForm form;

  @override
  Widget build(BuildContext context) {
    final List<(String, String)> notes = <(String, String)>[
      (context.t('mob.rep.narrative.results.label'), form.results),
      (context.t('mob.rep.narrative.causes.label'), form.causes),
      (context.t('mob.rep.narrative.solutions.label'), form.solutions),
      (context.t('mob.rep.narrative.proposals.label'), form.proposals),
    ].where(((String, String) note) => note.$2.trim().isNotEmpty).toList();
    return SectionCard(
      title: context.t('mob.rep.review.notes.title'),
      children: <Widget>[
        if (notes.isEmpty) Text(context.t('mob.rep.review.notesNone.body')),
        for (final (String, String) note in notes) FactLine(label: note.$1, value: note.$2.trim()),
      ],
    );
  }
}

/// The files being uploaded for this report (MOB-19): how many are scanned and clean, how many wait, how many did not arrive. A file
/// is uploaded and scanned on its own; it is not part of the content that is sent.
class _Files extends ConsumerWidget {
  const _Files({required this.draftId});

  final String draftId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final List<AttachmentUpload> uploads = <AttachmentUpload>[
      for (final AttachmentUpload upload in ref.watch(attachmentUploadsProvider).value ?? const <AttachmentUpload>[])
        if (upload.ownerKind == 'report' && upload.ownerRef == draftId && upload.state != UploadState.cancelled) upload,
    ];
    final int clean = uploads.where((AttachmentUpload u) => u.state == UploadState.clean).length;
    final int failed = uploads.where((AttachmentUpload u) => u.state == UploadState.failed || u.state == UploadState.infected).length;
    final int waiting = uploads.length - clean - failed;
    return SectionCard(
      title: context.t('mob.rep.files.title'),
      children: <Widget>[
        Text(uploads.isEmpty ? context.t('mob.rep.files.none.body') : context.t('mob.rep.files.summary.body', <String, Object>{'clean': clean, 'waiting': waiting, 'failed': failed})),
        Text(context.t('mob.rep.files.notLinked.body'), style: Theme.of(context).textTheme.bodySmall),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            onPressed: () => openStep(context, 'MOB-19', draftId),
            child: Text(context.t('mob.rep.files.manage.action')),
          ),
        ),
      ],
    );
  }
}
