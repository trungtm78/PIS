import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderException;
import 'package:go_router/go_router.dart';

import '../../../core/api/problem.dart';
import '../../../core/connectivity/reachability.dart';
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
import '../../offline/offline_format.dart';
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
    return Scaffold(
      appBar: AppBar(title: Text(context.t('mob.attach.title.label'))),
      bottomNavigationBar: draftId == null ? null : _ReportFooter(draftId: draftId, fromReview: widget.fromReview),
      floatingActionButton: picker == null || state == ScreenState.signedOut
          ? null
          : FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.attach_file), label: Text(context.t('mob.attach.add.action'))),
      body: SafeArea(
        child: Column(
          children: <Widget>[
            // Outside the boundary: a refusal of the first file leaves the list empty, and the boundary hides its content then.
            if (_refusal != null)
              Semantics(
                liveRegion: true,
                container: true,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                  child: Text(
                    '${context.t('mob.attach.refused.title')}. ${_reason(context, _refusal)} ${context.t('mob.attach.item.code.label', <String, Object>{'code': _refusal!})}',
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ),
              ),
            Expanded(
              child: StateBoundary(
                state: state,
                problem: problem,
                onRetry: () => ref.invalidate(attachmentUploaderProvider),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                  children: <Widget>[
                    Text(context.t('mob.attach.summary.label', <String, Object>{'count': shown.length}), style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 8),
                    for (final AttachmentUpload upload in shown)
                      _UploadTile(key: ValueKey<String>(upload.id), upload: upload, onResume: () => _resume(upload), onCancel: () => _cancel(upload)),
                  ],
                ),
              ),
            ),
          ],
        ),
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
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.t('mob.attach.optional.body'), style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                OutlinedButton(
                  onPressed: () => context.canPop() ? context.pop() : openScreen(context, 'MOB-22'),
                  child: Text(context.t('mob.attach.back.action')),
                ),
                FilledButton(
                  onPressed: () => fromReview && context.canPop() ? context.pop() : openScreen(context, 'MOB-20', pathSuffix: '/$draftId', stacked: true),
                  child: Text(fromReview ? context.t('mob.attach.review.action') : context.t('mob.attach.next.action')),
                ),
              ],
            ),
          ],
        ),
      ),
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
  const _UploadTile({required this.upload, required this.onResume, required this.onCancel, super.key});

  final AttachmentUpload upload;
  final VoidCallback onResume;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final String state = _state(context, upload.state);
    final String size = context.t('mob.attach.item.size.label', <String, Object>{'size': formatBytes(upload.sizeBytes)});
    final bool waiting = upload.state == UploadState.pending;
    final bool problem = upload.state == UploadState.failed || upload.state == UploadState.infected;
    final String? reason = problem ? _reason(context, upload.errorCode) : (waiting && upload.errorCode != null ? context.t('mob.attach.reason.waiting.body') : null);
    final String? code = (problem || waiting) && upload.errorCode != null ? context.t('mob.attach.item.code.label', <String, Object>{'code': upload.errorCode!}) : null;
    final double? progress = upload.progress;
    final String? chunks = upload.chunkCount == null ? null : context.t('mob.attach.item.progress.label', <String, Object>{'done': upload.sentChunks.length, 'total': upload.chunkCount!});
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Semantics(
              container: true,
              label: <String>[upload.fileName, state, size, ?chunks, ?reason, ?code].join('. '),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(upload.fileName, style: Theme.of(context).textTheme.titleMedium),
                  Text(state, style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text(size),
                  if (progress != null && upload.state != UploadState.clean) LinearProgressIndicator(value: progress),
                  if (chunks != null && upload.state != UploadState.clean) Text(chunks),
                  if (reason != null) Text(reason),
                  if (code != null) Text(code),
                ],
              ),
            ),
            Wrap(
              spacing: 8,
              children: <Widget>[
                if (waiting) _Action(label: context.t('mob.attach.item.resume.action'), onPressed: onResume),
                if (problem) _Action(label: context.t('mob.attach.item.retry.action'), onPressed: onResume),
                if (!upload.state.isFinal) _Action(label: context.t('mob.attach.item.cancel.action'), onPressed: onCancel),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => TextButton(onPressed: onPressed, child: Text(label));
}
