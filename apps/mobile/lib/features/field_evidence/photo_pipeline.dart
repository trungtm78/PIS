import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:image/image.dart' as img;
import 'package:path/path.dart' as p;

import '../../core/offline/attachments/attachment_policy.dart';
import '../../core/offline/attachments/image_compressor.dart';
import '../../core/offline/queue/offline_codes.dart';
import 'annotation.dart';
import 'jpeg_metadata.dart';
import 'png_metadata.dart';

/// The picture cannot be read, although its first bytes say it is a JPEG or a PNG (a damaged file).
const String kImageUnreadable = 'IMAGE_UNREADABLE';

/// What the application asks of a photograph before it is uploaded (07, "Luồng hiện trường").
final class EvidenceLimits {
  const EvidenceLimits({
    this.maxUploadBytes = 10 * 1024 * 1024,
    this.retainOriginals = true,
  });

  /// The most a photograph may weigh when it is sent as it is (a PNG, which is never recompressed behind the person's back). A
  /// larger one is turned into a JPEG that fits. A JPEG is always brought under the transport size of the uploader.
  final int maxUploadBytes;

  /// The retention policy asks for the photograph as it was taken to be kept, beside the marked and compressed one that is sent.
  final bool retainOriginals;
}

/// The photograph ready to be sent, and what was done to it.
final class PreparedPhoto {
  const PreparedPhoto({
    required this.path,
    required this.mime,
    required this.bytes,
    required this.recompressed,
    required this.annotated,
    required this.sourceHadPlaceOrTime,
    required this.keepsPlaceOrTime,
    this.originalPath,
  });

  /// The file that is uploaded.
  final String path;
  final String mime;
  final int bytes;

  /// The picture was scaled or compressed to fit.
  final bool recompressed;

  /// The marks of the person are drawn into the picture.
  final bool annotated;

  /// The photograph, as it was taken, said where or when.
  final bool sourceHadPlaceOrTime;

  /// The file that is uploaded still says where or when: true only when the person consented to keep it.
  final bool keepsPlaceOrTime;

  /// The photograph as it was taken, kept on the device when the retention policy asks (with the same metadata rule: without the
  /// consent it does not say where or when either), or null.
  final String? originalPath;
}

class _Outcome {
  const _Outcome({
    required this.bytes,
    required this.mime,
    required this.recompressed,
    required this.annotated,
    required this.sourceHadPlaceOrTime,
    required this.keepsPlaceOrTime,
    required this.original,
  });

  final Uint8List bytes;
  final String mime;
  final bool recompressed;
  final bool annotated;
  final bool sourceHadPlaceOrTime;
  final bool keepsPlaceOrTime;
  final Uint8List? original;
}

/// Brings one photograph to the state it is uploaded in:
///
///  * the type is judged by the bytes, never by the name: only a JPEG or a PNG is a photograph (a script renamed to `.jpg`, a
///    PDF and anything else is refused with `FILE_TYPE_NOT_ALLOWED`, before anything is written);
///  * a file larger than the server takes is refused (`FILE_TOO_LARGE`); a picture that cannot be read is `IMAGE_UNREADABLE`;
///  * the place and the time the photograph says it was taken at are removed unless [keepPlaceAndTime], the person's consent
///    (BR-MOB-06). A photograph that needs no new compression is not recompressed: only the blocks that carry metadata go;
///  * the marks of the person are drawn into the picture; the photograph as it was taken is kept beside it when the retention
///    policy asks;
///  * a JPEG larger than the transport size of the uploader, or wider than it takes, is scaled down and compressed until it fits.
///
/// The work runs in another isolate so the screen does not freeze on a large photograph. Files are written to [directory].
Future<PreparedPhoto> preparePhoto({
  required File source,
  required Directory directory,
  required bool keepPlaceAndTime,
  AnnotationSet annotations = AnnotationSet.empty,
  EvidenceLimits limits = const EvidenceLimits(),
  required String Function() newId,
}) async {
  final String mime = await checkAttachment(source);
  if (mime == kMimePdf) throw const AttachmentRefused(kFileTypeNotAllowed);
  final Uint8List bytes = await source.readAsBytes();
  final int maxUpload = limits.maxUploadBytes;
  final bool retain = limits.retainOriginals;
  final _Outcome outcome = await Isolate.run(
    () =>
        _prepare(bytes, mime, keepPlaceAndTime, annotations, maxUpload, retain),
  );
  directory.createSync(recursive: true);
  final String id = newId();
  final String extension = outcome.mime == kMimePng ? 'png' : 'jpg';
  final File prepared = File(p.join(directory.path, '$id.$extension'));
  await prepared.writeAsBytes(outcome.bytes, flush: true);
  String? originalPath;
  final Uint8List? original = outcome.original;
  if (original != null) {
    final File kept = File(
      p.join(
        directory.path,
        '$id-original.${mime == kMimePng ? 'png' : 'jpg'}',
      ),
    );
    await kept.writeAsBytes(original, flush: true);
    originalPath = kept.path;
  }
  return PreparedPhoto(
    path: prepared.path,
    mime: outcome.mime,
    bytes: outcome.bytes.length,
    recompressed: outcome.recompressed,
    annotated: outcome.annotated,
    sourceHadPlaceOrTime: outcome.sourceHadPlaceOrTime,
    keepsPlaceOrTime: outcome.keepsPlaceOrTime,
    originalPath: originalPath,
  );
}

const PackageImageCompressor _transport = PackageImageCompressor();

_Outcome _prepare(
  Uint8List bytes,
  String mime,
  bool keep,
  AnnotationSet marks,
  int maxUpload,
  bool retain,
) {
  if (bytes.length > kMaxAttachmentBytes)
    throw const AttachmentRefused(kFileTooLarge);
  final bool jpeg = mime == kMimeJpeg;
  // The metadata helpers hand back what they cannot parse as it came, and a decoder may hand back part of a file that was cut
  // short: a picture is whole and decodes, or it is not an upload, whether or not it is drawn again. The encoded bytes of a
  // picture that reads are kept as they are.
  final bool whole = jpeg ? jpegIsComplete(bytes) : pngIsComplete(bytes);
  final img.Image? decoded = whole ? _decode(bytes) : null;
  if (decoded == null) throw const AttachmentRefused(kImageUnreadable);
  final JpegMetadata meta = jpeg ? readJpegMetadata(bytes) : JpegMetadata.none;
  final bool sourceHadPlaceOrTime = jpeg
      ? meta.carriesPlaceOrTime
      : pngCarriesMetadata(bytes);
  final bool annotated = !marks.isEmpty;
  final ({int width, int height})? size = jpeg ? jpegSize(bytes) : null;
  final bool tooWide =
      size != null &&
      (size.width > _transport.maxEdge || size.height > _transport.maxEdge);
  final bool needsPicture =
      annotated ||
      (jpeg
          ? bytes.length > _transport.thresholdBytes || tooWide
          : bytes.length > maxUpload);
  Uint8List result;
  String resultMime = mime;
  if (!needsPicture) {
    result = keep
        ? bytes
        : (jpeg ? stripJpegMetadata(bytes) : stripPngMetadata(bytes));
  } else {
    result = _redraw(decoded, marks, keep);
    resultMime = kMimeJpeg;
  }
  final Uint8List? original = retain && (annotated || needsPicture)
      ? (keep
            ? bytes
            : (jpeg ? stripJpegMetadata(bytes) : stripPngMetadata(bytes)))
      : null;
  final bool keepsPlaceOrTime = resultMime == kMimeJpeg
      ? readJpegMetadata(result).carriesPlaceOrTime
      : pngCarriesMetadata(result);
  return _Outcome(
    bytes: result,
    mime: resultMime,
    recompressed: needsPicture,
    annotated: annotated,
    sourceHadPlaceOrTime: sourceHadPlaceOrTime,
    keepsPlaceOrTime: keepsPlaceOrTime,
    original: original,
  );
}

/// The picture the bytes hold, or null when the decoder cannot read it. A file can be whole (its blocks run to the end) and still
/// be damaged inside (a chunk whose checksum is wrong, compressed data that does not inflate): the decoder then throws, and what it
/// throws on bytes that came from outside is not an error of the application but a picture that cannot be read.
img.Image? _decode(Uint8List bytes) {
  try {
    return img.decodeImage(bytes);
  } on Exception {
    return null;
  } on RangeError {
    return null;
  } on StateError {
    return null;
  } on ArgumentError {
    return null;
  }
}

/// The picture decoded, upright, marked, scaled to the transport width and compressed until it is under the transport size.
Uint8List _redraw(img.Image decoded, AnnotationSet marks, bool keep) {
  // The orientation is applied to the pixels, so the file no longer needs to say it; the rest of what the file said stays only
  // with the consent of the person.
  img.Image working = img.bakeOrientation(decoded);
  if (working.numChannels == 4) working = _onWhite(working);
  if (!keep) working.exif = img.ExifData();
  drawAnnotations(working, marks);
  int edge = _transport.maxEdge;
  while (true) {
    final img.Image scaled = math.max(working.width, working.height) > edge
        ? (working.width >= working.height
              ? img.copyResize(working, width: edge)
              : img.copyResize(working, height: edge))
        : working;
    for (final int quality in const <int>[85, 75, 65, 55, 45]) {
      final Uint8List encoded = Uint8List.fromList(
        img.encodeJpg(scaled, quality: quality),
      );
      if (encoded.length <= _transport.thresholdBytes) return encoded;
    }
    if (edge <= 640) throw const AttachmentRefused(kFileTooLarge);
    edge = (edge * 3) ~/ 4;
  }
}

img.Image _onWhite(img.Image image) {
  final img.Image flat = img.Image(
    width: image.width,
    height: image.height,
    numChannels: 3,
  );
  img.fill(flat, color: img.ColorRgb8(255, 255, 255));
  return img.compositeImage(flat, image);
}
