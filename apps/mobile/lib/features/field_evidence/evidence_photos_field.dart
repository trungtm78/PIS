import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart' show newUuidV4;
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../core/l10n/app_strings.dart';
import '../../core/offline/attachments/attachment_policy.dart';
import '../permissions/permission_providers.dart';
import '../permissions/permission_service.dart';
import 'device_sources.dart';
import 'evidence_photos.dart';
import 'field_place.dart';
import 'photo_checks.dart';

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
/// before anything is sent. The widget holds nothing: it reports the next list through [onChanged].
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
  ConsumerState<EvidencePhotosField> createState() =>
      _EvidencePhotosFieldState();
}

class _EvidencePhotosFieldState extends ConsumerState<EvidencePhotosField> {
  String? _refusal;
  bool _cameraDenied = false;
  bool _working = false;

  Future<void> _take() async {
    setState(() {
      _refusal = null;
      _cameraDenied = false;
    });
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
      setState(() => _cameraDenied = true);
      return;
    }
    // The source is taken before the camera opens: the screen may be gone when it returns, and a gone widget may not read its ref.
    final PhotoSource source = ref.read(photoSourceProvider);
    await _useReturned(source, await source.takePhoto());
  }

  Future<void> _choose() async {
    setState(() {
      _refusal = null;
      _cameraDenied = false;
    });
    final PhotoSource source = ref.read(photoSourceProvider);
    await _useReturned(source, await source.pickPhoto());
  }

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
      if (await checkAttachment(file) == kMimePdf)
        throw const AttachmentRefused('FILE_TYPE_NOT_ALLOWED');
      EvidencePhoto photo = await prepareEvidence(
        file,
        directory: await evidenceDirectory,
        keepPlaceAndTime: keptWhenChosen,
        newId: newUuidV4,
      );
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
    final bool full = widget.photos.length >= kMaxEvidencePhotos;
    final bool canAdd = widget.enabled && !full && !_working;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          full
              ? context.t('mob.evd.photos.limit', <String, Object>{
                  'max': kMaxEvidencePhotos,
                })
              : context.t('mob.evd.photos.hint'),
        ),
        const SizedBox(height: MachvonSpace.space8),
        if (_refusal != null)
          Semantics(
            liveRegion: true,
            container: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(evidenceRefusalText(context, _refusal!)),
                Text(_refusal!, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        if (_cameraDenied)
          Semantics(
            liveRegion: true,
            child: Text(context.t('mob.evd.photos.cameraDenied')),
          ),
        Wrap(
          spacing: MachvonSpace.space8,
          children: <Widget>[
            FilledButton(
              onPressed: canAdd ? _take : null,
              child: Text(
                _working
                    ? context.t('mob.evd.photos.preparing')
                    : context.t('mob.evd.photos.take'),
              ),
            ),
            OutlinedButton(
              onPressed: canAdd ? _choose : null,
              child: Text(context.t('mob.evd.photos.choose')),
            ),
          ],
        ),
        if (widget.photos.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: MachvonSpace.space8),
            child: Text(context.t('mob.evd.photos.none')),
          ),
        for (final EvidencePhoto photo in widget.photos)
          _Row(
            photo: photo,
            enabled: widget.enabled,
            checks: widget.place == null
                ? null
                : checksOf(photo, widget.place!),
            onRemove: () => widget.onChanged(<EvidencePhoto>[
              for (final EvidencePhoto other in widget.photos)
                if (other.id != photo.id) other,
            ]),
          ),
      ],
    );
  }
}

/// The flags of a photograph, in words: where its place comes from and what is missing. A missing place or time is a warning only.
List<Widget> _checkLines(BuildContext context, PhotoChecks checks) {
  final TextStyle? style = Theme.of(context).textTheme.bodySmall;
  return <Widget>[
    Text(
      context.t('mob.evd.check.source', <String, Object>{
        'source': checks.gpsSource.code,
        'consent': checks.geoConsent
            ? context.t('mob.evd.check.consent.yes')
            : context.t('mob.evd.check.consent.no'),
      }),
      style: style,
    ),
    if (checks.placeMissing)
      Text(context.t('mob.evd.check.placeMissing'), style: style),
    if (checks.timeMissing)
      Text(context.t('mob.evd.check.timeMissing'), style: style),
  ];
}

class _Row extends StatelessWidget {
  const _Row({
    required this.photo,
    required this.enabled,
    required this.onRemove,
    this.checks,
  });

  final PhotoChecks? checks;
  final EvidencePhoto photo;
  final bool enabled;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final String metadata = photo.keepsPlaceOrTime
        ? context.t('mob.evd.photos.row.kept')
        : (photo.sourceHadPlaceOrTime
              ? context.t('mob.evd.photos.row.removed')
              : context.t('mob.evd.photos.row.none'));
    final int size = (photo.bytes / 1024).round();
    return Padding(
      padding: const EdgeInsets.only(top: MachvonSpace.space8),
      child: MergeSemantics(
        child: Row(
          children: <Widget>[
            ClipRect(
              child: SizedBox(
                width: 64,
                height: 64,
                child: Image.file(
                  File(photo.path),
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                  errorBuilder: (BuildContext _, Object _, StackTrace? _) =>
                      const Icon(Icons.broken_image),
                ),
              ),
            ),
            const SizedBox(width: MachvonSpace.space12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    context.t('mob.evd.photos.row.size', <String, Object>{
                      'size': size,
                    }),
                  ),
                  Text(metadata, style: Theme.of(context).textTheme.bodySmall),
                  if (checks != null) ..._checkLines(context, checks!),
                ],
              ),
            ),
            TextButton(
              onPressed: enabled ? onRemove : null,
              child: Text(context.t('mob.evd.photos.remove')),
            ),
          ],
        ),
      ),
    );
  }
}
