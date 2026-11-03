import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../../api/dart_io_transport.dart';

const Duration _connectionTimeout = Duration(seconds: 15);
const Duration _chunkTimeout = Duration(seconds: 60);

/// What the storage side answered to one chunk. [code] is the stable code of a problem answer (`SIGNATURE_INVALID`,
/// `ATTACHMENT_STATE_INVALID`), empty for a success or an answer without one.
final class ChunkAnswer {
  const ChunkAnswer(this.status, [this.code = '']);

  final int status;
  final String code;

  bool get ok => status >= 200 && status < 300;
}

/// Sends the bytes of one chunk to its signed link. The link is public and authenticated by its signature, so no bearer
/// token goes with it. It throws when no answer arrives (a cut network, a time-out); any answer, whatever its status, is a
/// [ChunkAnswer].
abstract interface class ChunkTransport {
  Future<ChunkAnswer> put(Uri url, Uint8List bytes);
}

/// The [ChunkTransport] on `dart:io`: PUT with the exact length, https only (plain http for a loopback debug build), no
/// redirect (the bytes of an attachment must not follow one), and a time-out.
final class DartIoChunkTransport implements ChunkTransport {
  DartIoChunkTransport({this.allowInsecureLoopback = false, HttpClient? client}) : _client = (client ?? HttpClient())..connectionTimeout = _connectionTimeout;

  final bool allowInsecureLoopback;
  final HttpClient _client;

  @override
  Future<ChunkAnswer> put(Uri url, Uint8List bytes) async {
    if (url.scheme != 'https' && !(allowInsecureLoopback && url.scheme == 'http')) throw StateError('refusing to send a chunk over ${url.scheme}');
    final HttpClientRequest request = await _client.putUrl(url).timeout(_chunkTimeout);
    request.followRedirects = false;
    request.headers.contentType = ContentType.binary;
    request.contentLength = bytes.length;
    request.add(bytes);
    final HttpClientResponse response = await request.close().timeout(_chunkTimeout);
    final List<int> body = <int>[];
    await for (final List<int> part in response.timeout(_chunkTimeout)) {
      body.addAll(part);
      if (body.length > maxResponseBytes) throw const HttpException('the response is larger than the limit');
    }
    return ChunkAnswer(response.statusCode, response.statusCode >= 400 ? _codeOf(body) : '');
  }

  /// The `code` member of a problem answer, or nothing: text from the server never goes further than its code.
  static String _codeOf(List<int> body) {
    try {
      final Object? decoded = jsonDecode(utf8.decode(body, allowMalformed: true));
      final Object? code = decoded is Map<String, Object?> ? decoded['code'] : null;
      return code is String && RegExp(r'^[A-Z][A-Z0-9_]{0,59}$').hasMatch(code) ? code : '';
    } on FormatException {
      return '';
    }
  }
}

/// A chunk link the application refuses to use: it does not point at the chunk endpoints of this server or it names another
/// tenant. The links come from the server, but a link is a place to send a person's file to, so it is checked.
final class ChunkLinkRefused implements Exception {
  const ChunkLinkRefused();

  @override
  String toString() => 'ChunkLinkRefused';
}

final RegExp _chunkPath = RegExp(r'^/sync/attachments/[0-9a-fA-F-]{36}/chunks/\d{1,4}$');

/// The address of a chunk: the link the server gave, relative to the API root, joined to the base URL of the application.
/// Only a root-relative link on the chunk path of an attachment whose `tenant` is [tenantId] is accepted: never another
/// host, never another path, never another tenant (the `tenants/{tenant_id}/` prefix of AC-ST-MOB-009-3).
Uri resolveChunkUrl(Uri baseUrl, String link, String tenantId) {
  final Uri parsed = Uri.parse(link);
  if (parsed.hasScheme || parsed.hasAuthority || !_chunkPath.hasMatch(parsed.path)) throw const ChunkLinkRefused();
  if (parsed.queryParameters['tenant'] != tenantId) throw const ChunkLinkRefused();
  final String basePath = baseUrl.path.replaceAll(RegExp(r'/+$'), '');
  return baseUrl.replace(path: '$basePath${parsed.path}', query: parsed.query);
}
