import 'dart:typed_data';

/// What a JPEG says about where and when it was taken (BR-MOB-06). Read from the Exif block without decoding the picture.
final class JpegMetadata {
  const JpegMetadata({
    this.hasExif = false,
    this.hasGps = false,
    this.hasTime = false,
    this.orientation,
  });

  static const JpegMetadata none = JpegMetadata();

  /// The file carries an Exif block at all.
  final bool hasExif;

  /// The block holds a position (latitude and longitude).
  final bool hasGps;

  /// The block holds the moment the picture was taken (or digitised).
  final bool hasTime;

  /// The Exif orientation (1 to 8), or null when the file names none.
  final int? orientation;

  /// The file says where or when: the two things a person has to consent to keep.
  bool get carriesPlaceOrTime => hasGps || hasTime;
}

const int _soi = 0xD8;
const int _eoi = 0xD9;
const int _sos = 0xDA;
const int _app0 = 0xE0;
const int _app1 = 0xE1;
const int _app2 = 0xE2;
const int _app14 = 0xEE;

const List<int> _exifHeader = <int>[0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

class _Segment {
  const _Segment(this.marker, this.start, this.end);

  final int marker;

  /// The first byte of the marker (the 0xFF) and the byte after the last byte of the segment.
  final int start;
  final int end;

  int get payloadStart => start + 4;
}

/// The segments of the file in order, or null when the bytes are not a JPEG that parses. A scan (its header and the entropy
/// coded data that follows) is one segment, so the walk goes on through every scan of a progressive or multi-scan file and
/// sees the blocks that sit between the scans. The segment of the end marker is the last one: what follows it is not part of
/// the picture.
List<_Segment>? _walk(Uint8List bytes) {
  if (bytes.length < 4 || bytes[0] != 0xFF || bytes[1] != _soi) return null;
  final List<_Segment> segments = <_Segment>[];
  int at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] != 0xFF) return null;
    int start = at;
    int marker = bytes[start + 1];
    // Fill bytes: any number of 0xFF may come before a marker.
    while (marker == 0xFF && start + 2 < bytes.length) {
      start += 1;
      marker = bytes[start + 1];
    }
    if (marker == _eoi) {
      segments.add(_Segment(marker, start, start + 2));
      return segments;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      at = start + 2;
      continue;
    }
    if (start + 4 > bytes.length) return null;
    final int length = (bytes[start + 2] << 8) | bytes[start + 3];
    int end = start + 2 + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker == _sos) {
      end = _endOfScan(bytes, end);
      segments.add(_Segment(marker, start, end));
      // A file cut inside its last scan has no marker after it: the scan runs to the end.
      if (end >= bytes.length) return segments;
    } else {
      segments.add(_Segment(marker, start, end));
    }
    at = end;
  }
  return null;
}

/// The offset of the first marker after the entropy coded data that starts at [from]: a stuffed zero (0xFF 0x00), a restart
/// marker and a fill byte belong to the data.
int _endOfScan(Uint8List bytes, int from) {
  int at = from;
  while (at + 1 < bytes.length) {
    if (bytes[at] == 0xFF) {
      final int next = bytes[at + 1];
      if (next != 0x00 && next != 0xFF && !(next >= 0xD0 && next <= 0xD7)) {
        return at;
      }
    }
    at += 1;
  }
  return bytes.length;
}

bool _isExif(Uint8List bytes, _Segment segment) {
  if (segment.marker != _app1 ||
      segment.end - segment.payloadStart < _exifHeader.length)
    return false;
  for (int i = 0; i < _exifHeader.length; i += 1) {
    if (bytes[segment.payloadStart + i] != _exifHeader[i]) return false;
  }
  return true;
}

typedef _Entry = ({int tag, int count, int valueAt});

/// A reader of one Exif block (the TIFF structure inside the APP1 segment). Every read is bounds checked: a block that is cut
/// or lies about its offsets reads as "nothing found", never as an exception.
class _Tiff {
  _Tiff(this.data, this.base, this.end, this.little);

  final Uint8List data;
  final int base;
  final int end;
  final bool little;

  static _Tiff? open(Uint8List data, int base, int end) {
    if (end - base < 8) return null;
    final bool little = data[base] == 0x49 && data[base + 1] == 0x49;
    final bool big = data[base] == 0x4D && data[base + 1] == 0x4D;
    if (!little && !big) return null;
    final _Tiff tiff = _Tiff(data, base, end, little);
    return tiff.u16(2) == 42 ? tiff : null;
  }

  int? u16(int offset) {
    final int at = base + offset;
    if (offset < 0 || at + 2 > end) return null;
    return little
        ? data[at] | (data[at + 1] << 8)
        : (data[at] << 8) | data[at + 1];
  }

  int? u32(int offset) {
    final int at = base + offset;
    if (offset < 0 || at + 4 > end) return null;
    return little
        ? data[at] |
              (data[at + 1] << 8) |
              (data[at + 2] << 16) |
              (data[at + 3] << 24)
        : (data[at] << 24) |
              (data[at + 1] << 16) |
              (data[at + 2] << 8) |
              data[at + 3];
  }

  /// The entries of the directory at [offset]; the offset of the 4-byte value field is relative to the block.
  List<_Entry> entries(int offset) {
    final int? count = u16(offset);
    if (count == null || count > 512) return const <_Entry>[];
    final List<_Entry> out = <_Entry>[];
    for (int i = 0; i < count; i += 1) {
      final int entry = offset + 2 + i * 12;
      final int? tag = u16(entry);
      final int? n = u32(entry + 4);
      if (tag == null || n == null || base + entry + 12 > end) break;
      out.add((tag: tag, count: n, valueAt: entry + 8));
    }
    return out;
  }
}

const int _tagOrientation = 0x0112;
const int _tagDateTime = 0x0132;
const int _tagExifIfd = 0x8769;
const int _tagGpsIfd = 0x8825;
const int _tagDateTimeOriginal = 0x9003;
const int _tagDateTimeDigitized = 0x9004;
const int _tagGpsLatitude = 0x0002;
const int _tagGpsLongitude = 0x0004;

JpegMetadata _readTiff(_Tiff tiff) {
  final int? first = tiff.u32(4);
  if (first == null) return const JpegMetadata(hasExif: true);
  bool hasGps = false;
  bool hasTime = false;
  int? orientation;
  for (final _Entry entry in tiff.entries(first)) {
    switch (entry.tag) {
      case _tagOrientation:
        final int? value = tiff.u16(entry.valueAt);
        if (value != null && value >= 1 && value <= 8) orientation = value;
      case _tagDateTime:
        hasTime = true;
      case _tagExifIfd:
        final int? pointer = tiff.u32(entry.valueAt);
        if (pointer != null) {
          hasTime =
              hasTime ||
              tiff
                  .entries(pointer)
                  .any(
                    (_Entry inner) =>
                        inner.tag == _tagDateTimeOriginal ||
                        inner.tag == _tagDateTimeDigitized,
                  );
        }
      case _tagGpsIfd:
        final int? pointer = tiff.u32(entry.valueAt);
        if (pointer != null) {
          final Set<int> tags = <int>{
            for (final _Entry inner in tiff.entries(pointer)) inner.tag,
          };
          hasGps =
              tags.contains(_tagGpsLatitude) && tags.contains(_tagGpsLongitude);
        }
    }
  }
  return JpegMetadata(
    hasExif: true,
    hasGps: hasGps,
    hasTime: hasTime,
    orientation: orientation,
  );
}

/// Reads what the Exif blocks of a JPEG say: whether they hold a position, whether they hold a time, and the orientation. Every
/// block counts wherever it sits, also between the scans of the picture. A file that is not a JPEG, or whose block cannot be
/// read, has no metadata.
JpegMetadata readJpegMetadata(Uint8List bytes) {
  final List<_Segment>? walked = _walk(bytes);
  if (walked == null) return JpegMetadata.none;
  JpegMetadata found = JpegMetadata.none;
  for (final _Segment segment in walked) {
    if (!_isExif(bytes, segment)) continue;
    final _Tiff? tiff = _Tiff.open(
      bytes,
      segment.payloadStart + _exifHeader.length,
      segment.end,
    );
    final JpegMetadata block = tiff == null
        ? const JpegMetadata(hasExif: true)
        : _readTiff(tiff);
    found = JpegMetadata(
      hasExif: true,
      hasGps: found.hasGps || block.hasGps,
      hasTime: found.hasTime || block.hasTime,
      orientation: found.orientation ?? block.orientation,
    );
  }
  return found;
}

/// An Exif block that holds nothing but the orientation, so a picture stored sideways still shows upright and the file says
/// nothing of where or when.
Uint8List _orientationOnly(int orientation) {
  return Uint8List.fromList(<int>[
    0xFF, _app1, 0x00, 0x22, // marker and length (34)
    ..._exifHeader,
    0x4D,
    0x4D,
    0x00,
    0x2A,
    0x00,
    0x00,
    0x00,
    0x08, // big endian, first directory at 8
    0x00, 0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // Orientation, SHORT, 1 value
    0x00, 0x00, 0x00, 0x00, // no next directory
  ]);
}

/// The application segments a stripped file keeps: the JFIF header (0), the colour profile (2) and the Adobe colour transform
/// (14), which the decoder needs. Every other application segment (Exif, XMP, Photoshop, maker notes, vendor blocks) and every
/// comment is dropped.
bool _keeps(int marker) {
  if (marker == _app0 || marker == _app2 || marker == _app14) return true;
  final bool application = marker >= 0xE1 && marker <= 0xEF;
  final bool comment = marker == 0xFE;
  return !application && !comment;
}

/// The file without the place and the time it says it was taken at (BR-MOB-06): every block that can hold them is removed, in
/// front of the picture and between its scans alike, and the picture itself is not touched (no new compression). With
/// [keepOrientation] a block that holds only the orientation is put back. Whatever follows the end marker is dropped. Bytes
/// that are not a JPEG that parses are returned as they came, so the caller decides what to do with them.
Uint8List stripJpegMetadata(Uint8List bytes, {bool keepOrientation = true}) {
  final List<_Segment>? walked = _walk(bytes);
  if (walked == null) return bytes;
  final int? orientation = keepOrientation
      ? readJpegMetadata(bytes).orientation
      : null;
  final BytesBuilder out = BytesBuilder()..add(const <int>[0xFF, _soi]);
  // The orientation block follows the JFIF header, as the format asks, and is the first block when there is none.
  bool pending = orientation != null && orientation != 1;
  for (final _Segment segment in walked) {
    if (!_keeps(segment.marker)) continue;
    if (pending && segment.marker != _app0) {
      out.add(_orientationOnly(orientation!));
      pending = false;
    }
    out.add(Uint8List.sublistView(bytes, segment.start, segment.end));
  }
  return out.toBytes();
}

/// Whether the bytes are a JPEG that runs to its end marker. A file cut short in its picture data still starts like a JPEG, and
/// a decoder may hand back part of the picture for it: this says the file is whole.
bool jpegIsComplete(Uint8List bytes) {
  final List<_Segment>? walked = _walk(bytes);
  return walked != null && walked.last.marker == _eoi;
}

/// The width and height a JPEG declares in its frame header, read without decoding the picture, or null when the file does not
/// say. The orientation is not applied.
({int width, int height})? jpegSize(Uint8List bytes) {
  final List<_Segment>? walked = _walk(bytes);
  if (walked == null) return null;
  for (final _Segment segment in walked) {
    final int marker = segment.marker;
    final bool frame =
        marker >= 0xC0 &&
        marker <= 0xCF &&
        marker != 0xC4 &&
        marker != 0xC8 &&
        marker != 0xCC;
    if (!frame || segment.end - segment.payloadStart < 5) continue;
    final int at = segment.payloadStart;
    return (
      width: (bytes[at + 3] << 8) | bytes[at + 4],
      height: (bytes[at + 1] << 8) | bytes[at + 2],
    );
  }
  return null;
}
