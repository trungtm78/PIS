import 'dart:typed_data';

const List<int> _signature = <int>[
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
];

/// The chunks that can say where or when a picture was made or by whom: the Exif block, the text blocks (which carry XMP) and the
/// modification time.
const Set<String> _dropped = <String>{'eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'};

/// Whether the PNG holds a chunk that can carry a place or a time.
bool pngCarriesMetadata(Uint8List bytes) =>
    _chunks(bytes)?.any(
      (({String type, int start, int end}) chunk) =>
          _dropped.contains(chunk.type),
    ) ??
    false;

List<({String type, int start, int end})>? _chunks(Uint8List bytes) {
  if (bytes.length < _signature.length + 12) return null;
  for (int i = 0; i < _signature.length; i += 1) {
    if (bytes[i] != _signature[i]) return null;
  }
  final List<({String type, int start, int end})> chunks =
      <({String type, int start, int end})>[];
  int at = _signature.length;
  while (at + 12 <= bytes.length) {
    final int length =
        (bytes[at] << 24) |
        (bytes[at + 1] << 16) |
        (bytes[at + 2] << 8) |
        bytes[at + 3];
    final int end = at + 12 + length;
    if (length < 0 || end > bytes.length) return null;
    chunks.add((
      type: String.fromCharCodes(bytes.sublist(at + 4, at + 8)),
      start: at,
      end: end,
    ));
    at = end;
  }
  return chunks;
}

/// Whether the bytes are a PNG whose chunks run to the end chunk: a file cut short is not whole.
bool pngIsComplete(Uint8List bytes) {
  final List<({String type, int start, int end})>? chunks = _chunks(bytes);
  return chunks != null && chunks.isNotEmpty && chunks.last.type == 'IEND';
}

/// The PNG without the chunks that can say where or when it was made; the picture is copied byte for byte. Bytes that are not a
/// PNG that parses are returned as they came.
Uint8List stripPngMetadata(Uint8List bytes) {
  final List<({String type, int start, int end})>? chunks = _chunks(bytes);
  if (chunks == null) return bytes;
  final BytesBuilder out = BytesBuilder()..add(_signature);
  for (final ({String type, int start, int end}) chunk in chunks) {
    if (!_dropped.contains(chunk.type))
      out.add(Uint8List.sublistView(bytes, chunk.start, chunk.end));
  }
  return out.toBytes();
}
