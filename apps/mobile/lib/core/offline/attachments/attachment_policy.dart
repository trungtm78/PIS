import 'dart:io';

import '../queue/offline_codes.dart';

/// The most a file may weigh: the limit of the server (`sync_attachment.size_bytes`, 1 byte to 50 MiB).
const int kMaxAttachmentBytes = 50 * 1024 * 1024;

/// The types the server accepts, by what the bytes say they are.
const String kMimeJpeg = 'image/jpeg';
const String kMimePng = 'image/png';
const String kMimePdf = 'application/pdf';

/// The code of a file that is not there when the person picked it.
const String kFileNotFound = 'FILE_NOT_FOUND';

/// The file cannot be attached; [code] is the code the server would answer (`FILE_TYPE_NOT_ALLOWED`) or the device's own
/// (`FILE_TOO_LARGE`), so the person sees the same reason before and after the network.
final class AttachmentRefused implements Exception {
  const AttachmentRefused(this.code);

  final String code;

  @override
  String toString() => 'AttachmentRefused($code)';
}

/// The type of a file judged by its first bytes, never by its name or the type a gallery claims (a script renamed to
/// `.jpg` is not a photo). Null for anything that is not a JPEG, a PNG or a PDF.
String? sniffMime(List<int> head) {
  bool starts(List<int> signature) {
    if (head.length < signature.length) return false;
    for (int i = 0; i < signature.length; i += 1) {
      if (head[i] != signature[i]) return false;
    }
    return true;
  }

  if (starts(const <int>[0xFF, 0xD8, 0xFF])) return kMimeJpeg;
  if (starts(const <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return kMimePng;
  if (starts(const <int>[0x25, 0x50, 0x44, 0x46, 0x2D])) return kMimePdf;
  return null;
}

/// Checks a file before anything is copied or sent: it exists, it is not empty, it is not larger than the server accepts, and
/// its bytes are a JPEG, a PNG or a PDF. Returns the type.
Future<String> checkAttachment(File file) async {
  if (!file.existsSync()) throw const AttachmentRefused(kFileNotFound);
  final int length = await file.length();
  if (length == 0) throw const AttachmentRefused(kFileTypeNotAllowed);
  if (length > kMaxAttachmentBytes) throw const AttachmentRefused(kFileTooLarge);
  final RandomAccessFile reader = await file.open();
  try {
    final String? mime = sniffMime(await reader.read(8));
    if (mime == null) throw const AttachmentRefused(kFileTypeNotAllowed);
    return mime;
  } finally {
    await reader.close();
  }
}
