import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The most a document file may weigh on the phone: the same ceiling as an upload (50 MiB).
const int maxDocumentBytes = 50 * 1024 * 1024;
const Duration _fetchTimeout = Duration(seconds: 60);

/// Why a file could not be fetched or trusted.
enum FetchFailure { refusedAddress, unreachable, expired, tooLarge, notPdf, checksumMismatch }

class DocumentFetchException implements Exception {
  const DocumentFetchException(this.failure);

  final FetchFailure failure;

  @override
  String toString() => 'DocumentFetchException(${failure.name})';
}

/// Fetches the bytes behind a short-lived signed address of the server (`getDocumentVersionDownload`, at most 300 seconds). The
/// address itself is the authority, so the request carries no bearer token. The bytes are held in memory by the screen that asked
/// and are never written to the phone: a document is not kept on the device.
abstract interface class DocumentFetcher {
  Future<Uint8List> fetch(Uri url, {int maxBytes = maxDocumentBytes});
}

/// The address a download answer names, made into a request address, or null when it is not acceptable: an absolute address must be
/// https (http only to a loopback host of a debug build) and a relative one is read against the API root. Nothing else (`mock://`,
/// `file:`, a protocol-relative address) is ever requested.
Uri? downloadAddress(Uri apiBase, String link, {bool allowInsecureLoopback = false}) {
  final Uri parsed;
  try {
    parsed = Uri.parse(link);
  } on FormatException {
    return null;
  }
  if (parsed.hasScheme) {
    if (parsed.host.isEmpty) return null;
    if (parsed.scheme == 'https') return parsed;
    final bool loopback = parsed.host == 'localhost' || parsed.host == '127.0.0.1' || parsed.host == '10.0.2.2';
    return allowInsecureLoopback && parsed.scheme == 'http' && loopback ? parsed : null;
  }
  if (parsed.hasAuthority || !link.startsWith('/')) return null;
  final String basePath = apiBase.path.replaceAll(RegExp(r'/+$'), '');
  return apiBase.replace(path: '$basePath${parsed.path}', query: parsed.hasQuery ? parsed.query : null);
}

/// A PDF begins with `%PDF-`: judged by the bytes, never by the name or the type the server said.
bool looksLikePdf(Uint8List bytes) => bytes.length > 5 && bytes[0] == 0x25 && bytes[1] == 0x50 && bytes[2] == 0x44 && bytes[3] == 0x46 && bytes[4] == 0x2d;

/// The SHA-256 of [bytes] in lower-case hex.
String sha256Hex(Uint8List bytes) => sha256.convert(bytes).toString();

/// Checks the bytes against what the server said about the file: a PDF, and the SHA-256 it declared. A file that does not match is
/// not shown.
Uint8List verifyDocument(Uint8List bytes, {required String expectedSha256}) {
  if (!looksLikePdf(bytes)) throw const DocumentFetchException(FetchFailure.notPdf);
  if (sha256Hex(bytes) != expectedSha256.toLowerCase()) throw const DocumentFetchException(FetchFailure.checksumMismatch);
  return bytes;
}

/// The fetcher on `dart:io`: no redirect is followed, no header but the accept type is sent, the answer is cut at [maxBytes].
final class DartIoDocumentFetcher implements DocumentFetcher {
  DartIoDocumentFetcher({HttpClient Function()? clientFactory}) : _clientFactory = clientFactory ?? HttpClient.new;

  final HttpClient Function() _clientFactory;

  @override
  Future<Uint8List> fetch(Uri url, {int maxBytes = maxDocumentBytes}) async {
    final HttpClient client = _clientFactory()..connectionTimeout = _fetchTimeout;
    try {
      final HttpClientRequest request = await client.getUrl(url).timeout(_fetchTimeout);
      request.followRedirects = false;
      request.headers.set(HttpHeaders.acceptHeader, 'application/pdf');
      final HttpClientResponse response = await request.close().timeout(_fetchTimeout);
      if (response.statusCode == HttpStatus.unauthorized || response.statusCode == HttpStatus.forbidden || response.statusCode == HttpStatus.gone) {
        throw const DocumentFetchException(FetchFailure.expired);
      }
      if (response.statusCode != HttpStatus.ok) throw const DocumentFetchException(FetchFailure.unreachable);
      if (response.contentLength > maxBytes) throw const DocumentFetchException(FetchFailure.tooLarge);
      final BytesBuilder body = BytesBuilder(copy: false);
      await for (final List<int> chunk in response.timeout(_fetchTimeout)) {
        body.add(chunk);
        if (body.length > maxBytes) throw const DocumentFetchException(FetchFailure.tooLarge);
      }
      return body.takeBytes();
    } on DocumentFetchException {
      rethrow;
    } on Object {
      throw const DocumentFetchException(FetchFailure.unreachable);
    } finally {
      client.close(force: true);
    }
  }
}

final Provider<DocumentFetcher> documentFetcherProvider = Provider<DocumentFetcher>((Ref ref) => DartIoDocumentFetcher());
