import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// A small JPEG made by the encoder the application uses, without any metadata.
Uint8List plainJpeg({int width = 16, int height = 12, int quality = 90}) {
  final img.Image image = img.Image(width: width, height: height);
  for (int y = 0; y < height; y += 1) {
    for (int x = 0; x < width; x += 1) {
      image.setPixelRgb(x, y, (x * 255) ~/ width, (y * 255) ~/ height, 128);
    }
  }
  return Uint8List.fromList(img.encodeJpg(image, quality: quality));
}

/// A noisy JPEG: it does not compress well, so it can be made large enough to need compressing.
Uint8List noisyJpeg({required int width, required int height, int quality = 95}) {
  final img.Image image = img.Image(width: width, height: height);
  int seed = 7;
  for (int y = 0; y < height; y += 1) {
    for (int x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      image.setPixelRgb(x, y, seed & 0xFF, (seed >> 8) & 0xFF, (seed >> 16) & 0xFF);
    }
  }
  return Uint8List.fromList(img.encodeJpg(image, quality: quality));
}

class _Writer {
  _Writer(this.little);

  final bool little;
  final List<int> bytes = <int>[];

  void u16(int value) => bytes.addAll(little ? <int>[value & 0xFF, (value >> 8) & 0xFF] : <int>[(value >> 8) & 0xFF, value & 0xFF]);

  void u32(int value) => bytes.addAll(
        little
            ? <int>[value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF]
            : <int>[(value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF],
      );

  void entry(int tag, int type, int count, int value) {
    u16(tag);
    u16(type);
    u32(count);
    if (type == 3 && count == 1) {
      // A SHORT sits at the start of the value field.
      u16(value);
      u16(0);
    } else {
      u32(value);
    }
  }
}

/// The Exif segment (marker and length included) of a photograph that says [orientation], when it was taken ([takenAt],
/// `2026:11:03 08:15:00`) and where ([gps]), in the byte order of [little].
Uint8List exifSegment({int? orientation, String? takenAt, bool gps = false, bool little = false}) {
  // Layout: header (8), directory 0, the Exif directory, the GPS directory, then the data areas.
  final int ifd0Entries = (orientation == null ? 0 : 1) + (takenAt == null ? 0 : 1) + (gps ? 1 : 0);
  final int ifd0Size = 2 + ifd0Entries * 12 + 4;
  final int exifAt = 8 + ifd0Size;
  final int exifSize = takenAt == null ? 0 : 2 + 12 + 4;
  final int gpsAt = exifAt + exifSize;
  final int gpsSize = gps ? 2 + 4 * 12 + 4 : 0;
  final int dataAt = gpsAt + gpsSize;
  final _Writer w = _Writer(little);
  w.bytes.addAll(little ? <int>[0x49, 0x49] : <int>[0x4D, 0x4D]);
  w.u16(42);
  w.u32(8);
  w.u16(ifd0Entries);
  if (orientation != null) w.entry(0x0112, 3, 1, orientation);
  if (takenAt != null) w.entry(0x8769, 4, 1, exifAt);
  if (gps) w.entry(0x8825, 4, 1, gpsAt);
  w.u32(0);
  if (takenAt != null) {
    w.u16(1);
    w.entry(0x9003, 2, takenAt.length + 1, dataAt);
    w.u32(0);
  }
  if (gps) {
    final int latAt = dataAt + (takenAt == null ? 0 : takenAt.length + 1);
    w.u16(4);
    w.bytes.addAll(<int>[0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x4E, 0x00, 0x00, 0x00]); // latitude ref "N"
    w.entry(0x0002, 5, 3, latAt);
    w.bytes.addAll(<int>[0x00, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x45, 0x00, 0x00, 0x00]); // longitude ref "E"
    w.entry(0x0004, 5, 3, latAt + 24);
    w.u32(0);
  }
  if (takenAt != null) {
    w.bytes.addAll(takenAt.codeUnits);
    w.bytes.add(0);
  }
  if (gps) {
    for (int i = 0; i < 6; i += 1) {
      w.u32(i.isEven ? 10 + i : 1);
      w.u32(1);
    }
  }
  final List<int> body = <int>[0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...w.bytes];
  final int length = body.length + 2;
  return Uint8List.fromList(<int>[0xFF, 0xE1, (length >> 8) & 0xFF, length & 0xFF, ...body]);
}

/// A segment that is not Exif: a vendor block, an XMP packet, a comment.
Uint8List segment(int marker, List<int> payload) {
  final int length = payload.length + 2;
  return Uint8List.fromList(<int>[0xFF, marker, (length >> 8) & 0xFF, length & 0xFF, ...payload]);
}

/// [jpeg] with [blocks] written right after the start of the image (and after the JFIF header, which the encoder writes first).
Uint8List withBlocks(Uint8List jpeg, List<Uint8List> blocks) {
  int at = 2;
  if (jpeg[2] == 0xFF && jpeg[3] == 0xE0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  return Uint8List.fromList(<int>[...jpeg.sublist(0, at), for (final Uint8List block in blocks) ...block, ...jpeg.sublist(at)]);
}

/// A photograph with the place and time in its Exif block.
Uint8List geotaggedJpeg({int orientation = 1, bool little = false}) => withBlocks(
      plainJpeg(),
      <Uint8List>[exifSegment(orientation: orientation, takenAt: '2026:11:03 08:15:00', gps: true, little: little)],
    );

int _crc32(List<int> data) {
  int crc = 0xFFFFFFFF;
  for (final int byte in data) {
    crc ^= byte;
    for (int bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1;
    }
  }
  return crc ^ 0xFFFFFFFF;
}

List<int> _chunk(String type, List<int> data) {
  final List<int> body = <int>[...type.codeUnits, ...data];
  final int crc = _crc32(body);
  return <int>[
    (data.length >> 24) & 0xFF, (data.length >> 16) & 0xFF, (data.length >> 8) & 0xFF, data.length & 0xFF, //
    ...body,
    (crc >> 24) & 0xFF, (crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF,
  ];
}

/// A small PNG with a text chunk (which is where XMP and comments live) and a modification time.
Uint8List pngWithText({int width = 16, int height = 12}) {
  final img.Image image = img.Image(width: width, height: height, numChannels: 3);
  img.fill(image, color: img.ColorRgb8(10, 120, 200));
  final Uint8List plain = Uint8List.fromList(img.encodePng(image));
  final int iend = plain.length - 12;
  return Uint8List.fromList(<int>[
    ...plain.sublist(0, iend),
    ..._chunk('tEXt', 'Comment\u0000taken at the south gate'.codeUnits),
    ..._chunk('tIME', <int>[0x07, 0xEA, 11, 3, 8, 15, 0]),
    ...plain.sublist(iend),
  ]);
}
