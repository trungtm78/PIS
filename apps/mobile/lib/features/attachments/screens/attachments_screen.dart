import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderException;
import 'package:go_router/go_router.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/offline/attachments/attachment_upload.dart';
import '../../../core/offline/attachments/attachment_uploader.dart';
import '../../../core/offline/attachments/upload_runner.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/offline/queue/offline_codes.dart';
import '../../../core/state/screen_state.dart';
import '../../../core/state/state_boundary.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../command_support/field_widgets.dart';
import '../../read_support/navigate.dart';

/// MOB-19: the files of a record on their way to the server, each with its size, its progress in chunks, its state
/// (waiting, uploading, scanning, clean, infected, failed) and the reason when it did not arrive (ST-MOB-009). The record is
/// named by the query parameters `owner` (the kind, `report`) and `ref` (its local or server id). For a report this screen is the
/// seventh step of the weekly report: the files are optional (the list may be empty and no picker may exist on the device), so the
/// screen always has its footer, a way back and the way on to the review (MOB-20), where the report is sent. When it was opened from
/// the review (`from=MOB-20`) the way on is "Xem lại", which returns there instead of opening a second review.
Widget buildAttachmentsScreen(BuildContext context, ScreenContext screen) => AttachmentsScreen(
      ownerKind: screen.queryParameters['owner'],
      ownerRef: screen.queryParameters['ref'],
      fromReview: screen.queryParameters['from'] == 'MOB-20',
    );

class AttachmentsScreen extends ConsumerStatefulWidget {
  const AttachmentsScreen({this.ownerKind, this.ownerRef, this.fromReview = false, super.key});

  final String? ownerKind;
  final String? ownerRef;

  /// Opened from the review of the report: the way on returns there.
  final bool fromReview;

  @override
  ConsumerState<AttachmentsScreen> createState() => _AttachmentsScreenState();
}

class _AttachmentsScreenState extends ConsumerState<AttachmentsScreen> {
  String? _refusal;

  Future<void> _add() async {
    final AttachmentPicker? picker = ref.read(attachmentPickerProvider);
    if (picker == null) return;
    final AttachmentUploader uploader = await ref.read(attachmentUploaderProvider.future);
    String? refusal;
    for (final File file in await picker()) {
      try {
        await uploader.add(file: file, ownerKind: widget.ownerKind ?? 'report', ownerRef: widget.ownerRef);
      } on AttachmentRefused catch (refused) {
        refusal = refused.code;
      }
    }
    if (mounted) setState(() => _refusal = refusal);
    final UploadRunner runner = await ref.read(uploadRunnerProvider.future);
    runner.trigger();
  }

  Future<void> _resume(AttachmentUpload upload) async {
    final AttachmentUploader uploader = await ref.read(attachmentUploaderProvider.future);
    if (upload.state == UploadState.failed || upload.state == UploadState.infected) {
      await uploader.retry(upload.id);
    } else {
      await uploader.run(upload.id);
    }
  }

  Future<void> _cancel(AttachmentUpload upload) async => (await ref.read(attachmentUploaderProvider.future)).cancel(upload.id);

  @override
  Widget build(BuildContext context) {
    final AsyncValue<List<AttachmentUpload>> uploads = ref.watch(attachmentUploadsProvider);
    final Reachability reachability = ref.watch(reachabilityProvider);
    final AttachmentPicker? picker = ref.watch(attachmentPickerProvider);
    final List<AttachmentUpload> shown = <AttachmentUpload>[
      for (final AttachmentUpload u in uploads.value ?? const <AttachmentUpload>[])
        if (u.state != UploadState.cancelled && (widget.ownerKind == null || u.ownerKind == widget.ownerKind) && (widget.ownerRef == null || u.ownerRef == widget.ownerRef)) u,
    ];
    ScreenState state = ScreenState.defaultState;
    ProblemView? problem;
    if (uploads.hasError) {
      Object cause = uploads.error!;
      while (cause is ProviderException) {
        cause = cause.exception;
      }
      problem = cause is OfflineUnavailable ? const ProblemView(state: ScreenState.signedOut, code: 'SESSION_EXPIRED') : ProblemView.from(cause, reachability: reachability);
      state = problem.state;
    } else if (!uploads.hasValue) {
      state = ScreenState.loading;
    } else if (shown.isEmpty) {
      state = ScreenState.empty;
    }
    final String? draftId = widget.ownerKind == 'report' ? widget.ownerRef : null;
    return AppScaffold(
      title: context.t('mob.attach.title.label'),
      bottomBar: draftId == null ? null : _ReportFooter(draftId: draftId, fromReview: widget.fromReview),
      floatingAction: picker == null || state == ScreenState.signedOut ? null : FloatingPill(onPressed: _add, icon: Icons.attach_file, label: context.t('mob.attach.add.action')),
      body: Column(
        children: <Widget>[
          // Outside the boundary: a refusal of the first file leaves the list empty, and the boundary hides its content then.
          if (_refusal != null)
            NoticePanel(
              tone: NoticeTone.problem,
              title: context.t('mob.attach.refused.title'),
              lines: <String>[_reason(context, _refusal)],
              code: context.t('mob.attach.item.code.label', <String, Object>{'code': _refusal!}),
            ),
          Expanded(
            child: StateBoundary(
              state: state,
              problem: problem,
              onRetry: () => ref.invalidate(attachmentUploaderProvider),
              child: ListView(
                padding: const EdgeInsets.only(bottom: MachvonV2Size.fab + MachvonV2Space.s32),
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.all(MachvonV2Space.s16),
                    child: Semantics(header: true, child: Text(context.t('mob.attach.summary.label', <String, Object>{'count': shown.length}), style: context.v2text.heading)),
                  ),
                  for (int i = 0; i < shown.length; i += 1) _UploadTile(key: ValueKey<String>(shown[i].id), upload: shown[i], first: i == 0, onResume: () => _resume(shown[i]), onCancel: () => _cancel(shown[i])),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The footer of the step of a report: the files are optional, so it is there whatever the list holds (nothing, files on their way,
/// a refused file); it never waits for an upload.
class _ReportFooter extends StatelessWidget {
  const _ReportFooter({required this.draftId, required this.fromReview});

  final String draftId;
  final bool fromReview;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(MachvonV2Space.s16, MachvonV2Space.s8, MachvonV2Space.s16, MachvonV2Space.s8),
          child: Text(context.t('mob.attach.optional.body'), style: context.v2text.caption.copyWith(color: context.v2.palette.ink2)),
        ),
        ActionBar(
          primary: ActionBarButton(
            label: fromReview ? context.t('mob.attach.review.action') : context.t('mob.attach.next.action'),
            onPressed: () => fromReview && context.canPop() ? context.pop() : openScreen(context, 'MOB-20', pathSuffix: '/$draftId', stacked: true),
          ),
          secondary: ActionBarButton(label: context.t('mob.attach.back.action'), onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22')),
        ),
      ],
    );
  }
}

String _state(BuildContext context, UploadState state) {
  switch (state) {
    case UploadState.pending:
      return context.t('mob.attach.state.pending.label');
    case UploadState.uploading:
      return context.t('mob.attach.state.uploading.label');
    case UploadState.scanning:
      return context.t('mob.attach.state.scanning.label');
    case UploadState.clean:
      return context.t('mob.attach.state.clean.label');
    case UploadState.infected:
      return context.t('mob.attach.state.infected.label');
    case UploadState.failed:
      return context.t('mob.attach.state.failed.label');
    case UploadState.cancelled:
      return context.t('mob.attach.state.cancelled.label');
  }
}

String _reason(BuildContext context, String? code) {
  switch (code) {
    case kFileInfected:
      return context.t('mob.attach.reason.infected.body');
    case kFileTypeNotAllowed:
      return context.t('mob.attach.reason.type.body');
    case kFileTooLarge:
      return context.t('mob.attach.reason.size.body');
    case kChecksumMismatch:
      return context.t('mob.attach.reason.checksum.body');
    case kFileChanged:
      return context.t('mob.attach.reason.changed.body');
    case kFileNotFound:
      return context.t('mob.attach.reason.missing.body');
    default:
      return context.t('mob.attach.reason.other.body');
  }
}

class _UploadTile extends StatelessWidget {
  const _UploadTile({required this.upload, required this.first, required this.onResume, required this.onCancel, super.key});

  final AttachmentUpload upload;
  final bool first;
  final VoidCallback onResume;
  final VoidCallback onCancel;

  MachvonTone get _tone {
    switch (upload.state) {
      case UploadState.clean:
        return MachvonTone.success;
      case UploadState.failed:
      case UploadState.infected:
        return MachvonTone.danger;
      case UploadState.uploading:
      case UploadState.scanning:
        return MachvonTone.info;
      case UploadState.pending:
      case UploadState.cancelled:
        return MachvonTone.neutral;
    }
  }

  @override
  Widget build(BuildContext context) {
    final String size = context.t('mob.attach.item.size.label', <String, Object>{'size': formatBytes(upload.sizeBytes, language: AppStrings.of(context).language)});
    final bool waiting = upload.state == UploadState.pending;
    final bool problem = upload.state == UploadState.failed || upload.state == UploadState.infected;
    final String? reason = problem ? _reason(context, upload.errorCode) : (waiting && upload.errorCode != null ? context.t('mob.attach.reason.waiting.body') : null);
    final String? code = (problem || waiting) && upload.errorCode != null ? context.t('mob.attach.item.code.label', <String, Object>{'code': upload.errorCode!}) : null;
    final bool showProgress = upload.state != UploadState.clean;
    return UploadRow(
      title: upload.fileName,
      stateLabel: _state(context, upload.state),
      tone: _tone,
      size: size,
      progress: showProgress ? upload.progress : null,
      progressText: showProgress && upload.chunkCount != null ? context.t('mob.attach.item.progress.label', <String, Object>{'done': upload.sentChunks.length, 'total': upload.chunkCount!}) : null,
      reason: reason,
      code: code,
      dividerAbove: !first,
      actions: <RowAction>[
        if (waiting) RowAction(label: context.t('mob.attach.item.resume.action'), onPressed: onResume),
        if (problem) RowAction(label: context.t('mob.attach.item.retry.action'), onPressed: onResume),
        if (!upload.state.isFinal) RowAction(label: context.t('mob.attach.item.cancel.action'), onPressed: onCancel),
      ],
    );
  }
}
