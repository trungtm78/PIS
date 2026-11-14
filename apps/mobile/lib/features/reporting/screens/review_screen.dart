import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/connectivity/reachability.dart';
import '../../../core/di/providers.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/drafts/local_draft.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/offline_codes.dart';
import '../../../core/offline/queue/queue_results.dart';
import '../../../core/offline/queue/queue_runner.dart';
import '../../../core/offline/queue/queued_command.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/info_row.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/section_tabs.dart';
import '../../../core/widgets/tap_target.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_widgets.dart';
import '../../read_support/navigate.dart';
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
import '../widgets/step_parts.dart';

/// MOB-20: the review of the whole report before it is sent (DIS-06): every error that would stop the sending and every warning that
/// would not, all at once and each with the step where it is put right; the change of each cell since the period before; the notes
/// and the files; and the one command that sends the report (ST-MOB-012). The report is sent once: a second tap, a lost answer and a
/// restart find the command that exists and look it up by its key.
///
/// It is the send screen of the field design: the findings are rows grouped under headings, the outcome of the sending is one panel with its
/// way out, and the sticky bar at the foot sends the report (offline it says "save, send when online").
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
      ownBar: true,
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
      final bool refused = command != null && status.stage == SubmitStage.rejected;
      // The refused submit carries only the id of the report: sent again it would hand in the copy the server holds. A draft edited since
      // the refusal (editing a blocked draft makes it editable again) is the person's newer copy, so it goes the way of a new submit:
      // validated, saved, then handed in.
      if (refused && widget.session.snapshot.draft.status != DraftStatus.blocked) {
        if (mounted) setState(() => _busy = false);
        await _submit();
        return;
      }
      final FlushResult result = refused ? await flow.resend(command.id) : await flow.check();
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
    // A command refused as unverifiable may have been carried out: a new submit would discard it, so only the queue decides.
    final bool unverifiable = session.status.stage == SubmitStage.rejected && session.status.code == kResultUnverifiable;
    final bool canSubmit = session.editable && errors.isEmpty && !_busy && !unverifiable;
    final String? why = errors.isNotEmpty
        ? context.t('mob.rep.review.blocked.body')
        : !session.editable
            ? (session.status.isPending ? context.t('mob.rep.pending.notice.body') : null)
            : null;
    final List<AttachmentUpload> uploads = <AttachmentUpload>[
      for (final AttachmentUpload upload in ref.watch(attachmentUploadsProvider).value ?? const <AttachmentUpload>[])
        if (upload.ownerKind == 'report' && upload.ownerRef == session.snapshot.id && upload.state != UploadState.cancelled) upload,
    ];
    final int clean = uploads.where((AttachmentUpload u) => u.state == UploadState.clean).length;
    final int failed = uploads.where((AttachmentUpload u) => u.state == UploadState.failed || u.state == UploadState.infected).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ReviewList(
            form: form,
            reportContext: reportContext,
            errors: errors,
            warnings: warnings,
            serverFindings: serverReview == null ? null : <Finding>[...serverReview.errors, ...serverReview.warnings],
            serverAsOf: _server?.context.fetchedAt,
            files: ReviewFiles(total: uploads.length, clean: clean, waiting: uploads.length - clean - failed, failed: failed),
            outcome: <Widget>[
              ?session.scrollingContext,
              DraftNotices(snapshot: session.snapshot, status: session.status, referenceProblem: session.referenceProblem, tellsSending: true),
              SendOutcomePanel(
                status: session.status,
                busy: _busy,
                onCheck: _check,
                onQueue: () => openScreen(context, 'MOB-41', stacked: true),
                onCompare: () => openScreen(context, 'MOB-42', pathSuffix: '/${session.status.command!.id}', stacked: true),
              ),
              if (_problem != null)
                NoticePanel(
                  tone: NoticeTone.problem,
                  title: problemMessage(context, _problem!),
                  actionLabel: _existingReportId == null ? null : context.t('mob.rep.start.existing.action'),
                  onAction: _existingReportId == null ? null : _openExisting,
                ),
              if (_needsConnection) NoticePanel(icon: Icons.cloud_off_outlined, title: context.t('mob.rep.review.needsConnection.body')),
              if (_result?.outcome == SubmitOutcome.savePending) NoticePanel(icon: Icons.sync, title: context.t('mob.rep.review.savePending.body')),
              if (_result?.outcome == SubmitOutcome.moved) NoticePanel(tone: NoticeTone.problem, icon: Icons.sync_problem, title: context.t('mob.rep.review.moved.body')),
              if (_result?.blocker == FlushBlocker.noDevice) NoticePanel(tone: NoticeTone.warning, icon: Icons.sync_problem, title: context.t('mob.rep.review.noDevice.body')),
            ],
            onFix: (String screen) => openStep(context, screen, session.snapshot.id),
            onManageFiles: () => openStep(context, 'MOB-19', session.snapshot.id, from: 'MOB-20'),
          ),
        ),
        FieldSendBar(
          label: context.t('mob.rep.review.submit.action'),
          onSend: canSubmit ? _submit : null,
          sending: _busy,
          offline: offline,
          why: why,
          secondary: ActionBarButton(label: context.t('mob.rep.step.back.action'), onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22')),
        ),
      ],
    );
  }
}

/// How many files of the report are uploaded and scanned clean, how many wait, how many did not arrive.
final class ReviewFiles {
  const ReviewFiles({required this.total, required this.clean, required this.waiting, required this.failed});

  final int total;
  final int clean;
  final int waiting;
  final int failed;
}

/// The body of the review: the outcome of the sending on top, then the errors and the warnings as rows (each with the step where it is put right),
/// what the server says of its copy, the change since the period before, the totals, the notes and the files. It is pure: what it shows is what it is
/// given, so the screen can be held in a test or a golden with no database behind it.
class ReviewList extends StatelessWidget {
  const ReviewList({
    required this.form,
    required this.reportContext,
    required this.errors,
    required this.warnings,
    required this.files,
    required this.onFix,
    required this.onManageFiles,
    this.outcome = const <Widget>[],
    this.serverFindings,
    this.serverAsOf,
    super.key,
  });

  final ReportForm form;
  final ReportContext? reportContext;
  final List<Finding> errors;
  final List<Finding> warnings;
  final ReviewFiles files;

  /// Panels at the top: where the sending stands and what the last attempt answered.
  final List<Widget> outcome;

  /// What the server's review says of the copy it holds; null when it was not read.
  final List<Finding>? serverFindings;
  final String? serverAsOf;
  final ValueChanged<String> onFix;
  final VoidCallback onManageFiles;

  @override
  Widget build(BuildContext context) {
    return ListView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
      children: <Widget>[
        ...outcome,
        // One purpose a tab (the review was seven groups on one page): what has to be put right before sending, the figures against the period before,
        // and the words and files that go with them. The first tab counts what is found, so a clean report says so without being opened.
        SectionTabs(
          tabs: <SectionTab>[
            SectionTab(
              label: context.t('mob.rep8.tab.checks'),
              count: errors.length + warnings.length + (serverFindings?.length ?? 0),
              children: <Widget>[
                GroupHeader(title: context.t('mob.rep.review.errors.title'), count: errors.length),
                ..._findingRows(context, errors, error: true),
                GroupHeader(title: context.t('mob.rep.review.warnings.title'), count: warnings.length),
                ..._findingRows(context, warnings, error: false),
                if (serverFindings != null) ...<Widget>[
                  GroupHeader(title: context.t('mob.rep.review.server.title')),
                  if (serverAsOf != null) StepNote(context.t('mob.rep.review.serverNote.body', <String, Object>{'time': asOfLabel(serverAsOf!)}), small: true),
                  ..._findingRows(context, serverFindings!, error: serverFindings!.any((Finding f) => f.isError)),
                ],
              ],
            ),
            SectionTab(
              label: context.t('mob.rep8.tab.figures'),
              children: <Widget>[
                GroupHeader(title: context.t('mob.rep.review.diff.title')),
                ..._differences(context),
                GroupHeader(title: context.t('mob.rep.totals.title')),
                ..._totals(context),
              ],
            ),
            SectionTab(
              label: context.t('mob.rep8.tab.notes'),
              children: <Widget>[
                GroupHeader(title: context.t('mob.rep.review.notes.title')),
                ..._notes(context),
                GroupHeader(title: context.t('mob.rep.files.title')),
                ..._files(context),
              ],
            ),
          ],
        ),
      ],
    );
  }

  /// The rows of a list of findings; none at all is one row saying so, in the tone of a good result.
  List<Widget> _findingRows(BuildContext context, List<Finding> findings, {required bool error}) {
    final MachvonV2 v2 = context.v2;
    if (findings.isEmpty) {
      return <Widget>[
        WorkRow(
          title: context.t('mob.rep.review.none.body'),
          leading: _Glyph(icon: Icons.check_circle_outline, color: v2.palette.okFg),
        ),
      ];
    }
    return <Widget>[
      for (int index = 0; index < findings.length; index += 1)
        _FindingRow(
          finding: findings[index],
          dividerAbove: index > 0,
          onFix: onFix,
        ),
    ];
  }

  /// What each cell added since the period before; a fall is marked in words as well as in colour.
  List<Widget> _differences(BuildContext context) {
    final bool compared = reportContext != null && kCells.any((CellKey key) => reportContext!.reference(key)?.previous != null);
    if (!compared) return <Widget>[StepNote(context.t('mob.rep.review.diffNone.body'))];
    return <Widget>[
      for (int index = 0; index < kCells.length; index += 1)
        Builder(
          builder: (BuildContext context) {
            final CellKey key = kCells[index];
            final String? delta = deltaOf(reportContext!.reference(key), form.cell(key).cumulative);
            final bool fall = delta?.startsWith('-') ?? false;
            return InfoRow(
              label: cellLabel(context, key),
              value: delta == null ? context.t('mob.rep.review.diffUnknown.body') : '${signedMoneyLabel(context, delta)}${fall ? ' · ${context.t('mob.rep.review.diffFall.body')}' : ''}',
              divider: index > 0,
            );
          },
        ),
    ];
  }

  List<Widget> _totals(BuildContext context) => <Widget>[
        InfoRow(label: context.t('mob.rep.totals.six.label'), value: moneyLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).cumulative])), divider: false),
        InfoRow(label: context.t('mob.rep.totals.ctmtqg.label'), value: moneyLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).ctmtqg]))),
        InfoRow(label: context.t('mob.rep.registration.total.label'), value: moneyLabel(context, sumTyped(<String>[for (final CellKey key in kCells) form.cell(key).nextMonth]))),
        InfoRow(
          label: context.t('mob.rep.volumes.construction.label'),
          value: form.construction.trim().isEmpty ? context.t('mob.rep.review.diffUnknown.body') : moneyLabel(context, digitsOf(form.construction)),
        ),
        InfoRow(label: context.t('mob.rep.basis.title'), value: basisLabel(context, form.basis)),
        StepNote(context.t('mob.rep.ctmtqg.note.body'), small: true),
      ];

  List<Widget> _notes(BuildContext context) {
    final List<(String, String)> notes = <(String, String)>[
      (context.t('mob.rep.narrative.results.label'), form.results),
      (context.t('mob.rep.narrative.causes.label'), form.causes),
      (context.t('mob.rep.narrative.solutions.label'), form.solutions),
      (context.t('mob.rep.narrative.proposals.label'), form.proposals),
    ].where(((String, String) note) => note.$2.trim().isNotEmpty).toList();
    if (notes.isEmpty) return <Widget>[StepNote(context.t('mob.rep.review.notesNone.body'))];
    return <Widget>[for (int index = 0; index < notes.length; index += 1) _NoteRow(label: notes[index].$1, text: notes[index].$2.trim(), divider: index > 0)];
  }

  /// The files being uploaded for this report (MOB-19). A file is uploaded and scanned on its own; it is not part of the content that is sent.
  List<Widget> _files(BuildContext context) => <Widget>[
        StepNote(files.total == 0 ? context.t('mob.rep.files.none.body') : context.t('mob.rep.files.summary.body', <String, Object>{'clean': files.clean, 'waiting': files.waiting, 'failed': files.failed})),
        StepNote(context.t('mob.rep.files.notLinked.body'), small: true),
        WorkRow(
          title: context.t('mob.rep.files.manage.action'),
          semanticLabel: context.t('mob.rep.files.manage.action'),
          dividerAbove: true,
          trailing: Align(alignment: Alignment.centerRight, child: Icon(Icons.chevron_right, color: context.v2.palette.ink2)),
          onTap: onManageFiles,
        ),
      ];
}

/// The glyph at the start of a row: an icon in a box of the size of the deadline glyph, so rows with and without one line up.
class _Glyph extends StatelessWidget {
  const _Glyph({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: MachvonV2Size.glyph,
        height: MachvonV2Size.glyph,
        child: ExcludeSemantics(child: Icon(icon, size: 24, color: color)),
      );
}

/// One thing the review found, as a row: its glyph (an error and a warning have different shapes), its words and, when there is a step where it is
/// put right, that way in as the whole row.
class _FindingRow extends StatelessWidget {
  const _FindingRow({required this.finding, required this.dividerAbove, required this.onFix});

  final Finding finding;
  final bool dividerAbove;
  final ValueChanged<String> onFix;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final String? screen = screenOfFinding(finding);
    final String message = findingMessage(context, finding);
    final String fix = context.t('mob.rep.review.fix.action');
    return WorkRow(
      title: message,
      semanticLabel: screen == null ? null : '$message. $fix',
      leading: finding.isError ? _Glyph(icon: Icons.error_outline, color: v2.palette.lateFg) : _Glyph(icon: Icons.warning_amber_rounded, color: v2.palette.soonFg),
      trailing: screen == null ? null : Text(fix, textAlign: TextAlign.end, style: context.v2text.label.copyWith(color: v2.palette.primaryStrong)),
      dividerAbove: dividerAbove,
      onTap: screen == null ? null : () => onFix(screen),
    );
  }
}

/// A note of the report with its label above it, whole (a note is read, so it is not cut to a line).
class _NoteRow extends StatelessWidget {
  const _NoteRow({required this.label, required this.text, required this.divider});

  final String label;
  final String text;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text type = context.v2text;
    return Semantics(
      container: true,
      label: '$label: $text',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (divider) Divider(height: 1, thickness: 1, color: v2.palette.line),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label, style: type.caption.copyWith(color: v2.palette.ink2)),
                const SizedBox(height: MachvonV2Space.s4),
                Text(text, style: type.body),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Where the sending of the report stands, in the words of MOB.md 4: waiting, on its way, "result unknown" (the answer was lost and the
/// server is asked for it by the key of the command, never sent a second time), refused with the draft kept, or moved on. It is one panel with
/// the one way out (send now, check the result, send again, compare) and, while the command is in the queue, the way to the queue.
class SendOutcomePanel extends StatelessWidget {
  const SendOutcomePanel({required this.status, required this.busy, required this.onCheck, required this.onQueue, required this.onCompare, super.key});

  final SubmitStatus status;
  final bool busy;

  /// Moves the command on: sends the waiting one, asks for the answer that was lost, sends again the one that was refused. The key stays.
  final VoidCallback onCheck;
  final VoidCallback onQueue;
  final VoidCallback onCompare;

  @override
  Widget build(BuildContext context) {
    final String? code = status.code;
    final String? codeLine = code == null ? null : context.t('mob.rep.problem.code.label', <String, Object>{'code': code});
    switch (status.stage) {
      case SubmitStage.idle:
      case SubmitStage.submitted:
        return const SizedBox.shrink();
      case SubmitStage.queued:
        return _withQueue(
          context,
          NoticePanel(icon: Icons.schedule, title: context.t('mob.rep.send.queued.body'), actionLabel: context.t('mob.rep.send.now.action'), onAction: busy ? null : onCheck),
        );
      case SubmitStage.sending:
        return _withQueue(context, NoticePanel(icon: Icons.sync, title: context.t('mob.rep.send.sending.body')));
      case SubmitStage.unknown:
        return _withQueue(
          context,
          NoticePanel(
            tone: NoticeTone.warning,
            icon: Icons.help_outline,
            title: context.t('mob.rep.send.unknown.body'),
            actionLabel: context.t('mob.rep.send.check.action'),
            onAction: busy ? null : onCheck,
          ),
        );
      case SubmitStage.rejected:
        // A submit refused as unverifiable may have been made already: a new key would make the report twice, so it is not offered again;
        // the queue is where the person drops it, after looking at the report on the web.
        if (code == kResultUnverifiable) {
          return _withQueue(
            context,
            NoticePanel(tone: NoticeTone.problem, title: context.t('mob.queue.reason.unverifiable.body'), lines: <String>[context.t('mob.rep.send.rejectedKept.body')], code: codeLine),
          );
        }
        return NoticePanel(
          tone: NoticeTone.problem,
          title: problemMessage(context, problemOfCode(code)),
          lines: <String>[context.t('mob.rep.send.rejectedKept.body')],
          code: codeLine,
          actionLabel: status.isSubmit ? context.t('mob.rep.send.again.action') : null,
          onAction: status.isSubmit && !busy ? onCheck : null,
        );
      case SubmitStage.conflict:
        return NoticePanel(
          tone: NoticeTone.problem,
          icon: Icons.sync_problem,
          title: context.t('mob.rep.send.conflict.body'),
          code: codeLine,
          actionLabel: context.t('mob.rep.send.compare.action'),
          onAction: onCompare,
        );
    }
  }

  Widget _withQueue(BuildContext context, Widget panel) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          panel,
          TapTarget(
            onTap: onQueue,
            semanticLabel: context.t('mob.rep.pending.queue.action'),
            minHeight: MachvonV2Size.actionButton,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16),
              child: Text(context.t('mob.rep.pending.queue.action'), style: context.v2text.label.copyWith(color: context.v2.palette.primaryStrong)),
            ),
          ),
        ],
      );
}
