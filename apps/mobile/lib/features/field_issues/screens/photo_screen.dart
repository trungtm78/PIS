import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../field_evidence/annotation.dart';
import '../../field_evidence/annotation_canvas.dart';
import '../../field_evidence/device_sources.dart';
import '../../field_evidence/evidence_photos_field.dart' show evidenceRefusalText;
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../../read_support/widgets.dart';
import '../issue_draft.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// The most photographs one report carries: a report is read on a phone, and every photograph is uploaded.
const int kMaxPhotos = 10;

/// MOB-29: the photographs of a report. A photograph is taken (after the person has read why the camera is needed) or chosen from
/// the gallery when the camera is refused or not wanted, marked with a finger if the person wants, and prepared on the device:
/// the type is checked, a large one is compressed, and the place and the time it says it was taken at are removed unless the
/// person agreed to keep them (BR-MOB-06). The reason a photograph is refused is shown before anything is sent.
Widget buildPhotoScreen(BuildContext context, ScreenContext screen) =>
    PhotoScreen(draftId: screen.pathParameters['draftId'] ?? '');

class PhotoScreen extends StatelessWidget {
  const PhotoScreen({required this.draftId, super.key});

  final String draftId;

  @override
  Widget build(BuildContext context) {
    return ScreenFrame(
      title: context.t('mob.fld.photo.title'),
      body: DraftBoundary(
        draftId: draftId,
        builder: (BuildContext context, StoredIssueDraft stored) =>
            _Photos(stored: stored),
      ),
    );
  }
}

class _Pending {
  const _Pending(this.file, this.bytes, this.marks);

  final File file;
  final Uint8List bytes;
  final AnnotationSet marks;

  _Pending withMarks(AnnotationSet next) => _Pending(file, bytes, next);
}

class _Photos extends ConsumerStatefulWidget {
  const _Photos({required this.stored});

  final StoredIssueDraft stored;

  @override
  ConsumerState<_Photos> createState() => _PhotosState();
}

class _PhotosState extends ConsumerState<_Photos> {
  _Pending? _pending;
  String? _notice;
  String? _refusalCode;
  bool _working = false;

  IssueDraft get _draft => widget.stored.draft;

  IssueService get _service => ref.read(issueServiceProvider);

  late final PhotoSource _source;

  @override
  void initState() {
    super.initState();
    _source = ref.read(photoSourceProvider);
  }

  @override
  void dispose() {
    final _Pending? pending = _pending;
    if (pending != null) unawaited(_source.discard(pending.file));
    super.dispose();
  }

  /// Marking is over (the photograph was used or the person gave it up): the picker's copy is deleted.
  Future<void> _finish() async {
    final _Pending? pending = _pending;
    if (pending == null) return;
    _pending = null;
    await _source.discard(pending.file);
  }

  Future<void> _save(IssueDraft next) async {
    await _service.save(next, draftId: widget.stored.id);
    ref.invalidate(issueDraftProvider(widget.stored.id));
  }

  void _say({String? notice, String? refusal}) => setState(() {
    _notice = notice;
    _refusalCode = refusal;
  });

  Future<void> _take() async {
    _say();
    final PermissionOutcome outcome = await requestPermissions(
      context,
      ref,
      <AppPermission>[AppPermission.camera],
    );
    if (!mounted) return;
    if (outcome.alternative == PermissionAlternative.attachFile) {
      await _choose();
      return;
    }
    if (!outcome.isGranted(AppPermission.camera)) {
      _say(notice: 'cameraDenied');
      return;
    }
    final File? file = await ref.read(photoSourceProvider).takePhoto();
    if (file != null) await _begin(file);
  }

  Future<void> _choose() async {
    _say();
    final File? file = await ref.read(photoSourceProvider).pickPhoto();
    if (file != null) await _begin(file);
  }

  /// Checks the file before the person spends time marking it: a file that cannot be used is refused here, with its reason.
  Future<void> _begin(File file) async {
    try {
      final String mime = await checkAttachment(file);
      if (mime == kMimePdf)
        throw const AttachmentRefused('FILE_TYPE_NOT_ALLOWED');
      final Uint8List bytes = await file.readAsBytes();
      if (mounted)
        setState(() => _pending = _Pending(file, bytes, AnnotationSet.empty));
    } on AttachmentRefused catch (refusal) {
      await _source.discard(file);
      if (mounted) _say(refusal: refusal.code);
    }
  }

  Future<void> _use() async {
    final _Pending? pending = _pending;
    if (pending == null || _working) return;
    setState(() => _working = true);
    try {
      final IssuePhoto photo = await _service.prepare(
        pending.file,
        keepPlaceAndTime: _draft.place.consent,
        marks: pending.marks,
      );
      await _save(
        _draft.copyWith(photos: <IssuePhoto>[..._draft.photos, photo]),
      );
      await _finish();
      if (mounted) {
        setState(() {});
        _say();
      }
    } on AttachmentRefused catch (refusal) {
      if (mounted) _say(refusal: refusal.code);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _remove(IssuePhoto photo) => _save(
    _draft.copyWith(
      photos: <IssuePhoto>[
        for (final IssuePhoto other in _draft.photos)
          if (other.id != photo.id) other,
      ],
    ),
  );

  Future<void> _caption(IssuePhoto photo, String words) => _save(
    _draft.copyWith(
      photos: <IssuePhoto>[
        for (final IssuePhoto other in _draft.photos)
          other.id == photo.id
              ? other.withAnnotations(other.annotations.withCaption(words))
              : other,
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final _Pending? pending = _pending;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonSpace.space24),
      children: <Widget>[
        if (_refusalCode != null)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Semantics(
              liveRegion: true,
              container: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(evidenceRefusalText(context, _refusalCode!)),
                  Text(
                    _refusalCode!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        if (_notice == 'cameraDenied')
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Semantics(
              liveRegion: true,
              child: Text(context.t('mob.fld.photo.cameraDenied.notice')),
            ),
          ),
        if (pending != null)
          SectionCard(
            title: context.t('mob.fld.photo.mark.title'),
            children: <Widget>[
              Text(context.t('mob.fld.photo.mark.hint')),
              const SizedBox(height: MachvonSpace.space8),
              AnnotationCanvas(
                image: pending.bytes,
                marks: pending.marks,
                onChanged: (AnnotationSet next) =>
                    setState(() => _pending = pending.withMarks(next)),
              ),
              const SizedBox(height: MachvonSpace.space12),
              TextField(
                maxLength: AnnotationSet.captionMax,
                decoration: InputDecoration(
                  labelText: context.t('mob.fld.photo.caption.label'),
                ),
                onChanged: (String words) => setState(
                  () => _pending = pending.withMarks(
                    pending.marks.withCaption(words),
                  ),
                ),
              ),
              const SizedBox(height: MachvonSpace.space8),
              Text(
                _draft.place.consent
                    ? context.t('mob.fld.photo.metadata.kept')
                    : context.t('mob.fld.photo.metadata.removed'),
              ),
              const SizedBox(height: MachvonSpace.space12),
              FilledButton(
                onPressed: _working ? null : _use,
                child: Text(
                  _working
                      ? context.t('mob.fld.photo.use.pending')
                      : context.t('mob.fld.photo.use.action'),
                ),
              ),
              TextButton(
                onPressed: _working
                    ? null
                    : () async {
                        await _finish();
                        if (mounted) setState(() {});
                      },
                child: Text(context.t('mob.fld.photo.cancel.action')),
              ),
            ],
          )
        else
          SectionCard(
            title: context.t('mob.fld.photo.add.title'),
            children: <Widget>[
              Text(
                _draft.photos.length >= kMaxPhotos
                    ? context.t('mob.fld.photo.limit.notice', <String, Object>{
                        'max': kMaxPhotos,
                      })
                    : context.t('mob.fld.photo.add.hint'),
              ),
              const SizedBox(height: MachvonSpace.space8),
              FilledButton(
                onPressed: _draft.photos.length >= kMaxPhotos ? null : _take,
                child: Text(context.t('mob.fld.photo.take.action')),
              ),
              OutlinedButton(
                onPressed: _draft.photos.length >= kMaxPhotos ? null : _choose,
                child: Text(context.t('mob.fld.photo.choose.action')),
              ),
            ],
          ),
        for (final IssuePhoto photo in _draft.photos)
          _PhotoRow(
            photo: photo,
            onRemove: () => _remove(photo),
            onCaption: (String words) => _caption(photo, words),
          ),
        if (_draft.photos.isEmpty && pending == null)
          Padding(
            padding: const EdgeInsets.all(MachvonSpace.space16),
            child: Text(context.t('mob.fld.photo.none.notice')),
          ),
      ],
    );
  }
}

class _PhotoRow extends StatelessWidget {
  const _PhotoRow({
    required this.photo,
    required this.onRemove,
    required this.onCaption,
  });

  final IssuePhoto photo;
  final VoidCallback onRemove;
  final ValueChanged<String> onCaption;

  @override
  Widget build(BuildContext context) {
    final String metadata = photo.keepsPlaceOrTime
        ? context.t('mob.fld.photo.row.kept')
        : (photo.sourceHadPlaceOrTime
              ? context.t('mob.fld.photo.row.removed')
              : context.t('mob.fld.photo.row.none'));
    return SectionCard(
      title: photo.annotations.caption.isEmpty
          ? context.t('mob.fld.photo.row.untitled')
          : photo.annotations.caption,
      semanticLabel: context.t('mob.fld.photo.row.aria', <String, Object>{
        'size': (photo.bytes / 1024).round(),
        'metadata': metadata,
      }),
      children: <Widget>[
        ClipRect(
          child: SizedBox(
            height: 160,
            child: Image.file(
              File(photo.path),
              fit: BoxFit.cover,
              excludeFromSemantics: true,
              errorBuilder: (BuildContext _, Object _, StackTrace? _) =>
                  const Icon(Icons.broken_image),
            ),
          ),
        ),
        const SizedBox(height: MachvonSpace.space8),
        Text(
          context.t('mob.fld.photo.row.size', <String, Object>{
            'size': (photo.bytes / 1024).round(),
          }),
        ),
        Text(metadata),
        if (photo.annotations.strokes.isNotEmpty)
          Text(
            context.t('mob.fld.photo.row.marks', <String, Object>{
              'count': photo.annotations.strokes.length,
            }),
          ),
        TextFormField(
          key: ValueKey<String>(photo.id),
          initialValue: photo.annotations.caption,
          maxLength: AnnotationSet.captionMax,
          decoration: InputDecoration(
            labelText: context.t('mob.fld.photo.caption.label'),
          ),
          onChanged: onCaption,
        ),
        TextButton(
          onPressed: onRemove,
          child: Text(context.t('mob.fld.photo.remove.action')),
        ),
      ],
    );
  }
}
