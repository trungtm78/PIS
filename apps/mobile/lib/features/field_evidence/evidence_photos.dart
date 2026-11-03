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

/// Takes the place and the time out of a prepared file, in place. The type is read from the bytes of the file itself (a prepared
/// file and the original kept beside it need not be of the same type: a PNG over the policy size is uploaded as a JPEG), and
/// everything that can say where or when goes, not only the Exif block (XMP, IPTC, text chunks). A file that is gone, or that is
/// already clean, is left alone.
Future<void> stripPreparedFile(String path) async {
  final File file = File(path);
  if (!file.existsSync()) return;
  final Uint8List bytes = await file.readAsBytes();
  final Uint8List clean =
      bytes.length > 1 && bytes[0] == 0xFF && bytes[1] == 0xD8
      ? stripJpegMetadata(bytes)
      : stripPngMetadata(bytes);
  if (_same(bytes, clean)) return;
  await file.writeAsBytes(clean, flush: true);
}

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (int i = 0; i < a.length; i += 1) {
    if (a[i] != b[i]) return false;
  }
  return true;
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
    await stripPreparedFile(photo.path);
    final String? original = photo.originalPath;
    if (original != null) await stripPreparedFile(original);
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

/// Whether the upload made earlier for a photograph may stand for it now. A photograph is handed over once, and a send that is cut and
/// made again must not hand it over twice; but the file of the photograph may have changed since (the consent to keep where and when
/// was taken back and the file was rewritten), and the copy the uploader holds is the old one. A copy that is not the photograph's
/// own any more (the uploader does not know it, or it still says where or when and the photograph must not) is cancelled when it has
/// not finished, and the photograph is handed over again from its current file.
Future<bool> reuseUpload(AttachmentUploader uploader, String? uploadId, {required bool keepsPlaceOrTime}) async {
  if (uploadId == null) return false;
  final AttachmentUpload? upload = uploader.upload(uploadId);
  // A cancelled upload never goes up, whatever its source says now (cancelling deleted it): a send cut after the cancel and before the new id was saved comes back here.
  if (upload == null || upload.state == UploadState.cancelled) return false;
  if (keepsPlaceOrTime || !await _carriesMetadata(upload.sourcePath)) return true;
  if (!upload.state.isFinal) uploader.cancel(uploadId);
  return false;
}

/// Whether a file would be changed by taking the place, the time and the blocks that can say them out of it.
Future<bool> _carriesMetadata(String path) async {
  final File file = File(path);
  if (!file.existsSync()) return false;
  final Uint8List bytes = await file.readAsBytes();
  final Uint8List clean =
      bytes.length > 1 && bytes[0] == 0xFF && bytes[1] == 0xD8
      ? stripJpegMetadata(bytes)
      : stripPngMetadata(bytes);
  return !_same(bytes, clean);
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
    if (await reuseUpload(uploader, photo.uploadId, keepsPlaceOrTime: photo.keepsPlaceOrTime)) {
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
