import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/offline/attachments/attachment_policy.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/machvon_semantic.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/action_bar.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/notice_panel.dart';
import '../../../core/widgets/work_row.dart';
import '../../command_support/field_widgets.dart';
import '../../field_evidence/annotation.dart';
import '../../field_evidence/annotation_canvas.dart';
import '../../field_evidence/device_sources.dart';
import '../../field_evidence/evidence_photos_field.dart' show evidenceRefusalText;
import '../../field_evidence/photo_row.dart';
import '../../permissions/permission_providers.dart';
import '../../permissions/permission_service.dart';
import '../issue_draft.dart';
import '../issue_providers.dart';
import '../issue_service.dart';

/// The most photographs one report carries: a report is read on a phone, and every photograph is uploaded.
const int kMaxPhotos = 10;

/// MOB-29: the photographs of a report. A photograph is taken (after the person has read why the camera is needed) or chosen from
/// the gallery when the camera is refused or not wanted, marked with a finger if the person wants, and prepared on the device:
/// the type is checked, a large one is compressed, and the place and the time it says it was taken at are removed unless the
/// person agreed to keep them (BR-MOB-06). The reason a photograph is refused is shown before anything is sent, with a way to try
/// again. Opened with `start=camera` or `start=gallery` (the capture form does it) the camera or the gallery opens at once.
Widget buildPhotoScreen(BuildContext context, ScreenContext screen) => PhotoScreen(draftId: screen.pathParameters['draftId'] ?? '', start: screen.queryParameters['start']);

class PhotoScreen extends StatelessWidget {
  const PhotoScreen({required this.draftId, this.start, super.key});

  final String draftId;

  /// `camera` or `gallery`: where to go to at once; null shows the screen and waits for the person.
  final String? start;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: context.t('mob.fld.photo.title'),
      body: DraftBoundary(draftId: draftId, builder: (BuildContext context, StoredIssueDraft stored) => _Photos(stored: stored, start: start)),
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

enum _From { camera, gallery }

class _Photos extends ConsumerStatefulWidget {
  const _Photos({required this.stored, this.start});

  final StoredIssueDraft stored;
  final String? start;

  @override
  ConsumerState<_Photos> createState() => _PhotosState();
}

class _PhotosState extends ConsumerState<_Photos> {
  _Pending? _pending;
  String? _notice;
  String? _refusalCode;
  bool _working = false;
  _From _last = _From.camera;

  IssueDraft get _draft => widget.stored.draft;

  IssueService get _service => ref.read(issueServiceProvider);

  late final PhotoSource _source;

  @override
  void initState() {
    super.initState();
    _source = ref.read(photoSourceProvider);
    final String? start = widget.start;
    if (start == 'camera' || start == 'gallery') {
      WidgetsBinding.instance.addPostFrameCallback((Duration _) {
        if (!mounted) return;
        unawaited(start == 'camera' ? _take() : _choose());
      });
    }
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
    _last = _From.camera;
    _say();
    final PermissionOutcome outcome = await requestPermissions(context, ref, <AppPermission>[AppPermission.camera]);
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
    _last = _From.gallery;
    _say();
    final File? file = await ref.read(photoSourceProvider).pickPhoto();
    if (file != null) await _begin(file);
  }

  Future<void> _again() => _last == _From.camera ? _take() : _choose();

  /// Checks the file before the person spends time marking it: a file that cannot be used is refused here, with its reason.
  Future<void> _begin(File file) async {
    try {
      final String mime = await checkAttachment(file);
      if (mime == kMimePdf) throw const AttachmentRefused('FILE_TYPE_NOT_ALLOWED');
      final Uint8List bytes = await file.readAsBytes();
      if (mounted) setState(() => _pending = _Pending(file, bytes, AnnotationSet.empty));
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
      final IssuePhoto photo = await _service.prepare(pending.file, keepPlaceAndTime: _draft.place.consent, marks: pending.marks);
      await _save(_draft.copyWith(photos: <IssuePhoto>[..._draft.photos, photo]));
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

  Future<void> _drop() async {
    await _finish();
    if (mounted) setState(() {});
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
      photos: <IssuePhoto>[for (final IssuePhoto other in _draft.photos) other.id == photo.id ? other.withAnnotations(other.annotations.withCaption(words)) : other],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final String language = AppStrings.of(context).language;
    final _Pending? pending = _pending;
    final bool full = _draft.photos.length >= kMaxPhotos;
    final String metadataNotice = _draft.place.consent ? context.t('mob.fld.photo.metadata.kept') : context.t('mob.fld.photo.metadata.removed');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: MachvonV2Space.s16),
            children: <Widget>[
              if (_refusalCode != null)
                NoticePanel(tone: NoticeTone.problem, title: evidenceRefusalText(context, _refusalCode!), code: _refusalCode, actionLabel: context.t('mob.fld.photo.retry.action'), onAction: _again),
              if (_notice == 'cameraDenied') NoticePanel(title: context.t('mob.fld.photo.cameraDenied.notice')),
              if (pending != null)
                FormSection(
                  title: context.t('mob.fld.photo.mark.title'),
                  caption: context.t('mob.fld.photo.mark.hint'),
                  first: true,
                  children: <Widget>[
                    AnnotationCanvas(image: pending.bytes, marks: pending.marks, onChanged: (AnnotationSet next) => setState(() => _pending = pending.withMarks(next))),
                    const SizedBox(height: MachvonV2Space.s12),
                    TextField(
                      maxLength: AnnotationSet.captionMax,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(labelText: context.t('mob.fld.photo.caption.label')),
                      onChanged: (String words) => setState(() => _pending = pending.withMarks(pending.marks.withCaption(words))),
                    ),
                    NoticePanel(title: metadataNotice, live: false, margin: const EdgeInsets.only(top: MachvonV2Space.s8)),
                  ],
                )
              else
                FormSection(
                  title: context.t('mob.fld.photo.add.title'),
                  caption: full ? context.t('mob.fld.photo.limit.notice', <String, Object>{'max': kMaxPhotos}) : context.t('mob.fld.photo.add.hint'),
                  first: true,
                  children: <Widget>[
                    Text(
                      _draft.photos.isEmpty ? context.t('mob.fld.photo.none.notice') : context.t('mob.fld.photo.count', <String, Object>{'count': _draft.photos.length, 'max': kMaxPhotos}),
                      style: text.body.copyWith(color: v2.palette.ink2),
                    ),
                  ],
                ),
              if (_working && pending != null)
                PhotoRow(
                  title: context.t('mob.fld.photo.row.untitled'),
                  stateLabel: context.t('mob.fld.photo.use.pending'),
                  tone: MachvonTone.info,
                  busy: true,
                  facts: <String>[context.t('mob.fld.photo.preparing.detail')],
                  dividerAbove: false,
                ),
              if (_draft.photos.isNotEmpty) GroupHeader(title: context.t('mob.fld.capture.photos.title'), count: _draft.photos.length),
              for (int index = 0; index < _draft.photos.length; index += 1)
                _PhotoRow(
                  photo: _draft.photos[index],
                  language: language,
                  dividerAbove: index > 0,
                  onRemove: () => _remove(_draft.photos[index]),
                  onCaption: (String words) => _caption(_draft.photos[index], words),
                ),
            ],
          ),
        ),
        if (pending != null)
          ActionBar(
            primary: ActionBarButton(label: _working ? context.t('mob.fld.photo.use.pending') : context.t('mob.fld.photo.use.action'), icon: _working ? Icons.sync : null, onPressed: _working ? null : _use),
            secondary: ActionBarButton(label: context.t('mob.fld.photo.cancel.action'), onPressed: _working ? null : _drop),
          )
        else
          ActionBar(
            primary: ActionBarButton(label: context.t('mob.fld.photo.take.action'), icon: Icons.photo_camera_outlined, onPressed: full ? null : _take),
            secondary: ActionBarButton(label: context.t('mob.fld.photo.choose.action'), onPressed: full ? null : _choose),
            why: full ? context.t('mob.fld.photo.limit.notice', <String, Object>{'max': kMaxPhotos}) : null,
          ),
      ],
    );
  }
}

/// A photograph of the report as a row: thumbnail, name (its note, or "Site photograph"), state, size, what happened to its place and
/// time, the strokes drawn on it, a field for its note and the 48 high action that removes it.
class _PhotoRow extends StatelessWidget {
  const _PhotoRow({required this.photo, required this.language, required this.dividerAbove, required this.onRemove, required this.onCaption});

  final IssuePhoto photo;
  final String language;
  final bool dividerAbove;
  final VoidCallback onRemove;
  final ValueChanged<String> onCaption;

  @override
  Widget build(BuildContext context) {
    final String metadata = photo.keepsPlaceOrTime
        ? context.t('mob.fld.photo.row.kept')
        : (photo.sourceHadPlaceOrTime ? context.t('mob.fld.photo.row.removed') : context.t('mob.fld.photo.row.none'));
    return PhotoRow(
      path: photo.path,
      title: photo.annotations.caption.isEmpty ? context.t('mob.fld.photo.row.untitled') : photo.annotations.caption,
      stateLabel: context.t('mob.fld.photo.row.ready'),
      tone: MachvonTone.success,
      size: context.t('mob.fld.photo.row.size', <String, Object>{'size': formatBytes(photo.bytes, language: language)}),
      facts: <String>[metadata, if (photo.annotations.strokes.isNotEmpty) context.t('mob.fld.photo.row.marks', <String, Object>{'count': photo.annotations.strokes.length})],
      dividerAbove: dividerAbove,
      actions: <RowAction>[RowAction(label: context.t('mob.fld.photo.remove.action'), onPressed: onRemove)],
      footer: Padding(
        padding: const EdgeInsets.only(top: MachvonV2Space.s8),
        child: TextFormField(
          key: ValueKey<String>(photo.id),
          initialValue: photo.annotations.caption,
          maxLength: AnnotationSet.captionMax,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(labelText: context.t('mob.fld.photo.caption.label')),
          onChanged: onCaption,
        ),
      ),
    );
  }
}
