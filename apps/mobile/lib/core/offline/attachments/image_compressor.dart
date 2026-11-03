import 'dart:isolate';
import 'dart:typed_data';

import 'package:image/image.dart' as img;

import 'attachment_policy.dart';

/// Makes a photo lighter before it goes up (BR-MOB-03; 07, "Luồng hiện trường": photos are checked for size and type and
/// compressed). A port, so a test can use a fake and a later story can swap in a native encoder.
abstract interface class ImageCompressor {
  /// The bytes to upload for [bytes] of type [mime]. Returns [bytes] unchanged when there is nothing to gain.
  Future<Uint8List> compress(Uint8List bytes, String mime);
}

/// The compressor on the `image` package (pure Dart): a JPEG larger than [thresholdBytes] or wider than [maxEdge] is decoded,
/// scaled down so its long edge is [maxEdge] and written again at [quality]. A PNG or a PDF is kept as it is (lossless
/// formats are not recompressed behind the person's back), and a result that is not smaller than the original is dropped.
/// The work runs in another isolate, so the screen does not freeze on a large photo.
final class PackageImageCompressor implements ImageCompressor {
  const PackageImageCompressor({this.thresholdBytes = 1024 * 1024, this.maxEdge = 2048, this.quality = 80});

  final int thresholdBytes;
  final int maxEdge;
  final int quality;

  @override
  Future<Uint8List> compress(Uint8List bytes, String mime) async {
    if (mime != kMimeJpeg) return bytes;
    final int threshold = thresholdBytes;
    final int edge = maxEdge;
    final int level = quality;
    final Uint8List? smaller = await Isolate.run(() => _recompress(bytes, threshold, edge, level));
    return smaller ?? bytes;
  }
}

Uint8List? _recompress(Uint8List bytes, int thresholdBytes, int maxEdge, int quality) {
  final img.Image? decoded;
  try {
    decoded = img.decodeJpg(bytes);
  } on img.ImageException {
    // A photo this decoder cannot read (a progressive or multi-frame JPEG) is uploaded as it is.
    return null;
  }
  if (decoded == null) return null;
  final bool tooLarge = bytes.length > thresholdBytes;
  final bool tooWide = decoded.width > maxEdge || decoded.height > maxEdge;
  if (!tooLarge && !tooWide) return null;
  img.Image scaled = decoded;
  if (tooWide) {
    scaled = decoded.width >= decoded.height ? img.copyResize(decoded, width: maxEdge) : img.copyResize(decoded, height: maxEdge);
  }
  final Uint8List encoded = Uint8List.fromList(img.encodeJpg(scaled, quality: quality));
  return encoded.length < bytes.length ? encoded : null;
}
