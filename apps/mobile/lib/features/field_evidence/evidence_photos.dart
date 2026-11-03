import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/offline/attachments/attachment_upload.dart';
import '../../core/offline/attachments/attachment_uploader.dart';
import '../../core/offline/offline_providers.dart';
import '../../core/offline/store/local_store.dart';
import 'jpeg_metadata.dart';
import 'photo_pipeline.dart';
import 'png_metadata.dart';

/// A photograph kept for a record (a site diary, a measurement, an inspection): the file that is uploaded, what was done to it,
/// and the upload once it was handed to the uploader. The photographs of an issue carry their marks as well ([IssuePhoto]).
final class EvidencePhoto {
  const EvidencePhoto({
    required this.id,
    required this.path,
    required this.mime,
    required this.bytes,
    this.originalPath,
    this.sourceHadPlaceOrTime = false,
    this.keepsPlaceOrTime = false,
    this.keptGps = false,
    this.keptTime = false,
    this.uploadId,
  });

  final String id;

  /// The prepared file (metadata handled, compressed) that is uploaded.
  final String path;
  final String mime;
  final int bytes;

  /// The photograph as it was taken, kept on the device when the retention policy asks.
  final String? originalPath;
  final bool sourceHadPlaceOrTime;

  /// The file that is uploaded still says where or when: only ever true with the consent of the person.
  final bool keepsPlaceOrTime;

  /// What the file that is uploaded still says: the position of the photograph, and the moment it was taken. Both are false for a
  /// photograph prepared without the consent.
  final bool keptGps;
  final bool keptTime;
  final String? uploadId;

  EvidencePhoto copyWith({
    int? bytes,
    bool? keepsPlaceOrTime,
    bool? keptGps,
    bool? keptTime,
    String? uploadId,
  }) => EvidencePhoto(
    id: id,
    path: path,
    mime: mime,
    bytes: bytes ?? this.bytes,
    originalPath: originalPath,
    sourceHadPlaceOrTime: sourceHadPlaceOrTime,
    keepsPlaceOrTime: keepsPlaceOrTime ?? this.keepsPlaceOrTime,
    keptGps: keptGps ?? this.keptGps,
    keptTime: keptTime ?? this.keptTime,
    uploadId: uploadId ?? this.uploadId,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'path': path,
    'mime': mime,
    'bytes': bytes,
    if (originalPath != null) 'original_path': originalPath,
    'source_had_place_or_time': sourceHadPlaceOrTime,
    'keeps_place_or_time': keepsPlaceOrTime,
    'kept_gps': keptGps,
    'kept_time': keptTime,
    if (uploadId != null) 'upload_id': uploadId,
  };

  static EvidencePhoto? fromJson(Object? json) {
    if (json is! Map) return null;
    final Object? id = json['id'];
    final Object? path = json['path'];
    final Object? mime = json['mime'];
    final Object? bytes = json['bytes'];
    if (id is! String || path is! String || mime is! String || bytes is! int)
      return null;
    return EvidencePhoto(
      id: id,
      path: path,
      mime: mime,
      bytes: bytes,
      originalPath: json['original_path'] as String?,
      sourceHadPlaceOrTime: json['source_had_place_or_time'] == true,
      keepsPlaceOrTime: json['keeps_place_or_time'] == true,
      keptGps: json['kept_gps'] == true,
      keptTime: json['kept_time'] == true,
      uploadId: json['upload_id'] as String?,
    );
  }

  static List<EvidencePhoto> listFromJson(Object? json) => <EvidencePhoto>[
    if (json is List)
      for (final Object? item in json)
        if (EvidencePhoto.fromJson(item) case final EvidencePhoto photo) photo,
  ];
}

/// The private folder of the person where prepared photographs are kept (inside the folder of the local store, so it goes with the
/// store when the person signs out or switches tenant).
final FutureProvider<Directory> evidenceDirectoryProvider =
    FutureProvider<Directory>((Ref ref) async {
      final LocalStore store = await ref.watch(localStoreProvider.future);
      return store.evidenceDirectory;
    });

/// Takes the place and the time out of a prepared file, in place. A file that is gone, or that says neither, is left alone.
Future<void> stripPreparedFile(String path, String mime) async {
  final File file = File(path);
  if (!file.existsSync()) return;
  final Uint8List bytes = await file.readAsBytes();
  final bool png = mime == 'image/png';
  if (!(png
      ? pngCarriesMetadata(bytes)
      : readJpegMetadata(bytes).carriesPlaceOrTime))
    return;
  await file.writeAsBytes(
    png ? stripPngMetadata(bytes) : stripJpegMetadata(bytes),
    flush: true,
  );
}

/// Deletes the files of a photograph that is dropped with its draft.
Future<void> removePreparedFiles(EvidencePhoto photo) async {
  for (final String? path in <String?>[photo.path, photo.originalPath]) {
    if (path == null) continue;
    final File file = File(path);
    if (file.existsSync()) await file.delete();
  }
}

/// Prepares a photograph for a record: what it says of where and when is kept only when [keepPlaceAndTime] (the consent of the
/// person), a large one is compressed, and the original is kept per the retention policy. Throws `AttachmentRefused` with the reason
/// before anything is written.
Future<EvidencePhoto> prepareEvidence(
  File source, {
  required Directory directory,
  required bool keepPlaceAndTime,
  required String Function() newId,
  EvidenceLimits limits = const EvidenceLimits(),
}) async {
  final PreparedPhoto prepared = await preparePhoto(
    source: source,
    directory: directory,
    keepPlaceAndTime: keepPlaceAndTime,
    limits: limits,
    newId: newId,
  );
  final JpegMetadata kept = prepared.mime == 'image/jpeg'
      ? readJpegMetadata(await File(prepared.path).readAsBytes())
      : JpegMetadata.none;
  return EvidencePhoto(
    id: newId(),
    path: prepared.path,
    mime: prepared.mime,
    bytes: prepared.bytes,
    originalPath: prepared.originalPath,
    sourceHadPlaceOrTime: prepared.sourceHadPlaceOrTime,
    keepsPlaceOrTime: prepared.keepsPlaceOrTime,
    keptGps: kept.hasGps,
    keptTime: kept.hasTime,
  );
}

/// Withdrawing the consent takes the place and the time out of what was prepared while it held (BR-MOB-06): the prepared files and
/// the originals kept beside them are rewritten without them. Nothing is done while the consent holds.
Future<List<EvidencePhoto>> enforcePhotoConsent(
  List<EvidencePhoto> photos, {
  required bool consent,
}) async {
  if (consent) return photos;
  final List<EvidencePhoto> out = <EvidencePhoto>[];
  for (final EvidencePhoto photo in photos) {
    if (!photo.keepsPlaceOrTime && photo.originalPath == null) {
      out.add(photo);
      continue;
    }
    await stripPreparedFile(photo.path, photo.mime);
    final String? original = photo.originalPath;
    if (original != null) await stripPreparedFile(original, photo.mime);
    out.add(
      photo.copyWith(
        bytes: File(photo.path).existsSync()
            ? File(photo.path).lengthSync()
            : photo.bytes,
        keepsPlaceOrTime: false,
        keptGps: false,
        keptTime: false,
      ),
    );
  }
  return out;
}

/// Hands each photograph that was not handed over yet to the uploader, once. [saved] is called after each, with the photographs as
/// they stand, so a send cut between two photographs is resumed and never repeats the one that is up.
Future<List<EvidencePhoto>> handOverPhotos(
  AttachmentUploader uploader,
  List<EvidencePhoto> photos, {
  required String ownerKind,
  required String ownerRef,
  Future<void> Function(List<EvidencePhoto> photos)? saved,
}) async {
  final List<EvidencePhoto> out = <EvidencePhoto>[];
  for (final EvidencePhoto photo in photos) {
    if (photo.uploadId != null) {
      out.add(photo);
      continue;
    }
    final AttachmentUpload upload = await uploader.add(
      file: File(photo.path),
      ownerKind: ownerKind,
      ownerRef: ownerRef,
    );
    out.add(photo.copyWith(uploadId: upload.id));
    await saved?.call(<EvidencePhoto>[...out, ...photos.skip(out.length)]);
  }
  return out;
}
