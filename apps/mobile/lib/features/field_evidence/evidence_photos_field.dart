import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show newUuidV4;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/format/format.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/offline/attachments/attachment_policy.dart';
import '../../core/theme/colors.dart';
import '../../core/theme/machvon_semantic.dart';
import '../../core/theme/typography.dart';
import '../../core/widgets/notice_panel.dart';
import '../command_support/field_widgets.dart' show RowAction;
import '../permissions/permission_providers.dart';
import '../permissions/permission_service.dart';
import 'device_sources.dart';
import 'evidence_photos.dart';
import 'field_place.dart';
import 'photo_checks.dart';
import 'photo_row.dart';

/// The most photographs one record carries: a record is read on a phone, and every photograph is uploaded.
const int kMaxEvidencePhotos = 10;

/// Why a photograph was refused, in words; the code is shown beside it.
String evidenceRefusalText(BuildContext context, String code) {
  switch (code) {
    case 'FILE_TYPE_NOT_ALLOWED':
      return context.t('mob.evd.refused.type');
    case 'FILE_TOO_LARGE':
      return context.t('mob.evd.refused.size');
    case 'FILE_NOT_FOUND':
      return context.t('mob.evd.refused.missing');
    case 'IMAGE_UNREADABLE':
      return context.t('mob.evd.refused.unreadable');
    default:
      return context.t('mob.evd.refused.general');
  }
}

/// The photographs of a record (a site diary, a measurement, an inspection item): take one (after the rationale of MOB-06) or choose
/// one when the camera is refused or not wanted, see what happens to its place and time, remove it. A photograph is prepared on the
/// device as soon as it is chosen: the type is checked, a large one is compressed, and the place and the time it says it was taken
/// at are removed unless the person agreed to keep them ([keepPlaceAndTime], BR-MOB-06). The reason a photograph is refused is shown
/// before anything is sent, with a way to try again. The widget holds nothing: it reports the next list through [onChanged].
///
/// Every photograph is a row with its thumbnail, its state (preparing, ready), its size and its remove action; a photograph being
/// prepared is a row of its own with a moving bar, so the person sees the work and the count against the limit.
class EvidencePhotosField extends ConsumerStatefulWidget {
  const EvidencePhotosField({
    required this.photos,
    required this.keepPlaceAndTime,
    required this.onChanged,
    this.enabled = true,
    this.place,
    super.key,
  });

  final List<EvidencePhoto> photos;
  final bool keepPlaceAndTime;
  final ValueChanged<List<EvidencePhoto>> onChanged;
  final bool enabled;

  /// When given, each photograph shows the flags it will be registered with (`gps_source`, `geo_consent`) before it is sent.
  final FieldPlace? place;

  @override
  ConsumerState<EvidencePhotosField> createState() => _EvidencePhotosFieldState();
}

enum _Source { camera, gallery }

class _EvidencePhotosFieldState extends ConsumerState<EvidencePhotosField> {
  String? _refusal;
  bool _cameraDenied = false;
  bool _working = false;

  /// Where the last photograph came from: "try again" opens the same one.
  _Source _last = _Source.camera;

  Future<void> _take() async {
    _last = _Source.camera;
    setState(() {
      _refusal = null;
      _cameraDenied = false;
    });
    final PermissionOutcome outcome = await requestPermissions(context, ref, <AppPermission>[AppPermission.camera]);
    if (!mounted) return;
    if (outcome.alternative == PermissionAlternative.attachFile) {
      await _choose();
      return;
    }
    if (!outcome.isGranted(AppPermission.camera)) {
      setState(() => _cameraDenied = true);
      return;
    }
    // The source is taken before the camera opens: the screen may be gone when it returns, and a gone widget may not read its ref.
    final PhotoSource source = ref.read(photoSourceProvider);
    await _useReturned(source, await source.takePhoto());
  }

  Future<void> _choose() async {
    _last = _Source.gallery;
    setState(() {
      _refusal = null;
      _cameraDenied = false;
    });
    final PhotoSource source = ref.read(photoSourceProvider);
    await _useReturned(source, await source.pickPhoto());
  }

  Future<void> _again() => _last == _Source.camera ? _take() : _choose();

  /// What the camera or the gallery returned. The screen may have been left while the picker was open (a session that ended, a
  /// navigation): nobody wants the picture then, and the copy the plug-in left in the cache, with the place and the time it says,
  /// is deleted all the same.
  Future<void> _useReturned(PhotoSource source, File? file) async {
    if (file == null) return;
    if (!mounted) {
      await source.discard(file);
      return;
    }
    await _use(source, file);
  }

  Future<void> _use(PhotoSource source, File file) async {
    if (_working) {
      // A second picture while one is being prepared is not taken: its copy is not kept either.
      await source.discard(file);
      return;
    }
    final bool keptWhenChosen = widget.keepPlaceAndTime;
    // Asked before the first wait: the screen may be gone by the time the preparation needs the folder.
    final Future<Directory> evidenceDirectory = ref.read(evidenceDirectoryProvider.future);
    setState(() => _working = true);
    try {
      if (await checkAttachment(file) == kMimePdf) throw const AttachmentRefused('FILE_TYPE_NOT_ALLOWED');
      EvidencePhoto photo = await prepareEvidence(file, directory: await evidenceDirectory, keepPlaceAndTime: keptWhenChosen, newId: newUuidV4);
      if (!mounted) {
        // Nobody holds the photograph any more: nothing may keep its files, with or without the place and time.
        await removePreparedFiles(photo);
        return;
      }
      // The preparation took time. A withdrawal of the consent meanwhile could not reach a photograph that was not in the list
      // yet, so it is read again here: the prepared file and the original kept beside it lose the place and the time.
      if (keptWhenChosen && !widget.keepPlaceAndTime) {
        photo = (await enforcePhotoConsent(<EvidencePhoto>[photo], consent: false)).single;
        if (!mounted) {
          await removePreparedFiles(photo);
          return;
        }
      }
      widget.onChanged(<EvidencePhoto>[...widget.photos, photo]);
    } on AttachmentRefused catch (refusal) {
      if (mounted) setState(() => _refusal = refusal.code);
    } finally {
      // Prepared, refused or failed: the copy the picker left in the cache has no further use.
      await source.discard(file);
      if (mounted) setState(() => _working = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text text = context.v2text;
    final bool full = widget.photos.length >= kMaxEvidencePhotos;
    final bool canAdd = widget.enabled && !full && !_working;
    final String language = AppStrings.of(context).language;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          full ? context.t('mob.evd.photos.limit', <String, Object>{'max': kMaxEvidencePhotos}) : context.t('mob.evd.photos.hint'),
          style: text.body.copyWith(color: v2.palette.ink2),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        if (_refusal != null)
          NoticePanel(
            tone: NoticeTone.problem,
            title: evidenceRefusalText(context, _refusal!),
            code: _refusal,
            actionLabel: widget.enabled ? context.t('mob.evd.photos.retry') : null,
            onAction: widget.enabled ? _again : null,
            margin: EdgeInsets.zero,
          ),
        if (_cameraDenied) NoticePanel(title: context.t('mob.evd.photos.cameraDenied'), margin: EdgeInsets.zero),
        if (_refusal != null || _cameraDenied) const SizedBox(height: MachvonV2Space.s8),
        Wrap(
          spacing: MachvonV2Space.s8,
          runSpacing: MachvonV2Space.s8,
          children: <Widget>[
            FilledButton(onPressed: canAdd ? _take : null, child: Text(_working ? context.t('mob.evd.photos.preparing') : context.t('mob.evd.photos.take'))),
            OutlinedButton(onPressed: canAdd ? _choose : null, child: Text(context.t('mob.evd.photos.choose'))),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: MachvonV2Space.s8),
          child: Text(
            widget.photos.isEmpty && !_working
                ? context.t('mob.evd.photos.none')
                : context.t('mob.evd.photos.count', <String, Object>{'count': widget.photos.length, 'max': kMaxEvidencePhotos}),
            style: text.caption.copyWith(color: v2.palette.ink2),
          ),
        ),
        const SizedBox(height: MachvonV2Space.s8),
        for (int index = 0; index < widget.photos.length; index += 1)
          _Row(
            photo: widget.photos[index],
            number: index + 1,
            language: language,
            checks: widget.place == null ? null : checksOf(widget.photos[index], widget.place!),
            onRemove: widget.enabled
                ? () => widget.onChanged(<EvidencePhoto>[
                    for (final EvidencePhoto other in widget.photos)
                      if (other.id != widget.photos[index].id) other,
                  ])
                : null,
          ),
        if (_working)
          PhotoRow(
            title: context.t('mob.evd.photos.row.title', <String, Object>{'number': widget.photos.length + 1}),
            stateLabel: context.t('mob.evd.photos.preparing'),
            tone: MachvonTone.info,
            busy: true,
            facts: <String>[context.t('mob.evd.photos.preparing.detail')],
            dividerAbove: widget.photos.isNotEmpty,
          ),
      ],
    );
  }
}

/// The flags of a photograph, in words: where its place comes from and what is missing. A missing place or time is a warning only.
List<String> _checkLines(BuildContext context, PhotoChecks checks) => <String>[
  context.t('mob.evd.check.source', <String, Object>{
    'source': checks.gpsSource.code,
    'consent': checks.geoConsent ? context.t('mob.evd.check.consent.yes') : context.t('mob.evd.check.consent.no'),
  }),
  if (checks.placeMissing) context.t('mob.evd.check.placeMissing'),
  if (checks.timeMissing) context.t('mob.evd.check.timeMissing'),
];

class _Row extends StatelessWidget {
  const _Row({required this.photo, required this.number, required this.language, required this.onRemove, this.checks});

  final PhotoChecks? checks;
  final EvidencePhoto photo;
  final int number;
  final String language;

  /// Null shows the remove action locked (the record is being sent).
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final String metadata = photo.keepsPlaceOrTime
        ? context.t('mob.evd.photos.row.kept')
        : (photo.sourceHadPlaceOrTime ? context.t('mob.evd.photos.row.removed') : context.t('mob.evd.photos.row.none'));
    return PhotoRow(
      path: photo.path,
      title: context.t('mob.evd.photos.row.title', <String, Object>{'number': number}),
      stateLabel: context.t('mob.evd.photos.row.ready'),
      tone: MachvonTone.success,
      size: context.t('mob.evd.photos.row.size', <String, Object>{'size': formatBytes(photo.bytes, language: language)}),
      facts: <String>[metadata, if (checks != null) ..._checkLines(context, checks!)],
      actions: <RowAction>[RowAction(label: context.t('mob.evd.photos.remove'), onPressed: onRemove)],
    );
  }
}
