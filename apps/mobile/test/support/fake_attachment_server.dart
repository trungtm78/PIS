import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_policy.dart';
import 'package:machvon_mobile/core/offline/attachments/chunk_transport.dart';

/// The attachment endpoints of the server as the phone sees them (docs/mob-sync.md): `POST /sync/attachments` starts an
/// upload and signs a link for each chunk, `GET /sync/attachments/{id}` says which chunks the server holds and signs fresh
/// links for the others, a chunk is PUT to its link, and `POST .../complete` puts the file together, compares the size and the
/// SHA-256, judges the type by the bytes, scans, and answers CLEAN or INFECTED. The real rules are proven on PostgreSQL by
/// apps/api/test/sync/sync-attachments.test.ts; this fake lets the phone's side be tested against the same behaviour, and
/// counts what was sent.
class FakeAttachmentServer implements HttpTransport, ChunkTransport {
  FakeAttachmentServer({this.chunkBytes = 4, this.tenantId = 'tenant-a'});

  final int chunkBytes;
  final String tenantId;
  final Map<String, _Upload> _uploads = <String, _Upload>{};
  final Map<String, String> _startedBy = <String, String>{};
  final Map<String, Map<String, Object?>> _completed = <String, Map<String, Object?>>{};
  final List<HttpCall> calls = <HttpCall>[];

  /// Every chunk sent, in order: `(upload, index)`.
  final List<({String upload, int index})> chunkLog = <({String upload, int index})>[];

  int _links = 0;
  int _validFrom = 0;
  int _nextId = 1;

  /// The connection is cut when this chunk of the next upload is sent (once).
  int? cutAtChunk;

  /// The API (not the storage) is unreachable.
  bool offline = false;

  /// The next request to the API is answered with this status and code instead of being handled.
  ({int status, String code})? failNext;

  /// The next start is carried out and its answer is lost.
  bool dropNextStartAnswer = false;

  /// The next completion is refused with this status and code (a rule of the server the phone cannot know).
  ({int status, String code})? refuseNextCompletion;

  /// The storage lost this chunk after acknowledging it: the next completion finds it missing (once).
  int? forgetChunkOnce;

  /// Links issued before this call stop working, as after their five minutes.
  void expireIssuedLinks() => _validFrom = _links + 1;

  /// Pretends the storage lost the chunks: the next completion finds the checksum wrong.
  bool corruptNextChunk = false;

  int chunkSends(String upload, int index) => chunkLog.where((e) => e.upload == upload && e.index == index).length;

  List<String> get uploadIds => _uploads.keys.toList();

  String statusOf(String id) => _uploads[id]!.status;

  Uint8List? storedBytes(String id) => _uploads[id]!.stored;

  int get started => _uploads.length;

  // ------------------------------------------------------------------------------------------ the API

  @override
  Future<HttpResult> send(HttpCall call) async {
    calls.add(call);
    if (offline) throw const SocketException('network is down');
    final ({int status, String code})? failure = failNext;
    if (failure != null) {
      failNext = null;
      return _problem(failure.status, failure.code);
    }
    final List<String> parts = call.url.pathSegments.where((String s) => s != 'v1').toList();
    if (call.method == 'POST' && parts.length == 2 && parts[1] == 'attachments') return _start(call);
    if (call.method == 'GET' && parts.length == 3) return _status(parts[2]);
    if (call.method == 'POST' && parts.length == 4 && parts[3] == 'complete') return _complete(call, parts[2]);
    return _problem(404, 'RESOURCE_NOT_FOUND');
  }

  HttpResult _start(HttpCall call) {
    final String key = call.headers['idempotency-key']!;
    final Map<String, Object?> body = jsonDecode(call.body!) as Map<String, Object?>;
    final String id = _startedBy[key] ?? _newId();
    if (!_startedBy.containsKey(key)) {
      _startedBy[key] = id;
      _uploads[id] = _Upload(id, body['sha256']! as String, body['size_bytes']! as int, body['mime']! as String);
    }
    final _Upload upload = _uploads[id]!;
    if (dropNextStartAnswer) {
      dropNextStartAnswer = false;
      throw const SocketException('connection reset after the server did the work');
    }
    return _json(200, <String, Object?>{
      'operation_id': 'post_sync_attachments',
      'status': 'UPLOADING',
      'resource_version': 1,
      'resource_id': id,
      'chunk_bytes': chunkBytes,
      'chunk_count': upload.chunkCount(chunkBytes),
      'expires_at': '2026-11-03T08:05:00.000Z',
      'chunks': _linksFor(upload),
    });
  }

  HttpResult _status(String id) {
    final _Upload? upload = _uploads[id];
    if (upload == null) return _problem(404, 'RESOURCE_NOT_FOUND');
    return _json(200, <String, Object?>{
      'id': id,
      'status': upload.status,
      'size_bytes': upload.size,
      'chunk_bytes': chunkBytes,
      'chunk_count': upload.chunkCount(chunkBytes),
      'received': (upload.chunks.keys.toList()..sort()),
      'reason': upload.reason,
      'expires_at': upload.status == 'UPLOADING' ? '2026-11-03T08:05:00.000Z' : null,
      'chunks': upload.status == 'UPLOADING' ? _linksFor(upload) : <Object?>[],
    });
  }

  HttpResult _complete(HttpCall call, String id) {
    final String key = call.headers['idempotency-key']!;
    final Map<String, Object?>? replay = _completed[key];
    if (replay != null) return _json(200, replay);
    final _Upload? upload = _uploads[id];
    if (upload == null) return _problem(404, 'RESOURCE_NOT_FOUND');
    if (upload.status != 'UPLOADING') return _problem(409, 'ATTACHMENT_STATE_INVALID');
    final ({int status, String code})? refusal = refuseNextCompletion;
    if (refusal != null) {
      refuseNextCompletion = null;
      return _problem(refusal.status, refusal.code);
    }
    final int? forgotten = forgetChunkOnce;
    if (forgotten != null) {
      forgetChunkOnce = null;
      upload.chunks.remove(forgotten);
    }
    final List<int> missing = <int>[for (int i = 0; i < upload.chunkCount(chunkBytes); i += 1) if (!upload.chunks.containsKey(i)) i];
    if (missing.isNotEmpty) return _problem(409, 'ATTACHMENT_CHUNKS_MISSING');
    final BytesBuilder assembled = BytesBuilder();
    for (int i = 0; i < upload.chunkCount(chunkBytes); i += 1) {
      assembled.add(upload.chunks[i]!);
    }
    final Uint8List bytes = assembled.toBytes();
    final String sent = (jsonDecode(call.body!) as Map<String, Object?>)['sha256']! as String;
    if (sent != upload.sha256 || sha256.convert(bytes).toString() != upload.sha256 || bytes.length != upload.size) {
      upload.chunks.clear();
      upload.epoch += 1;
      return _problem(422, 'CHECKSUM_MISMATCH');
    }
    if (sniffMime(bytes) != upload.mime) {
      upload.chunks.clear();
      upload.epoch += 1;
      return _problem(422, 'FILE_TYPE_NOT_ALLOWED');
    }
    upload.stored = bytes;
    upload.status = utf8.decode(bytes, allowMalformed: true).contains('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'INFECTED' : 'CLEAN';
    if (upload.status == 'INFECTED') upload.reason = 'FILE_INFECTED';
    upload.chunks.clear();
    final Map<String, Object?> result = <String, Object?>{'operation_id': 'post_sync_attachments_id_complete', 'status': upload.status, 'resource_version': 1, 'resource_id': id};
    _completed[key] = result;
    return _json(200, result);
  }

  // ----------------------------------------------------------------------------------------- the storage

  @override
  Future<ChunkAnswer> put(Uri url, Uint8List bytes) async {
    final List<String> parts = url.pathSegments.where((String s) => s != 'v1').toList();
    final String id = parts[2];
    final int index = int.parse(parts[4]);
    chunkLog.add((upload: id, index: index));
    if (cutAtChunk == index) {
      cutAtChunk = null;
      throw const SocketException('connection cut in the middle of the chunk');
    }
    final _Upload? upload = _uploads[id];
    final Map<String, String> query = url.queryParameters;
    final int number = int.parse(query['expires']!);
    if (upload == null || query['tenant'] != tenantId || number < _validFrom) return const ChunkAnswer(401, 'SIGNATURE_INVALID');
    if (upload.status != 'UPLOADING' || int.parse(query['epoch']!) != upload.epoch) return const ChunkAnswer(409, 'ATTACHMENT_STATE_INVALID');
    final int expected = upload.chunkSizeAt(index, chunkBytes);
    if (bytes.length != expected) return const ChunkAnswer(422, 'VALIDATION_FAILED');
    final Uint8List kept = Uint8List.fromList(bytes);
    if (corruptNextChunk) {
      corruptNextChunk = false;
      kept[0] ^= 0xFF;
    }
    upload.chunks[index] = kept;
    return const ChunkAnswer(200);
  }

  // ------------------------------------------------------------------------------------------ helpers

  String _newId() => '00000000-0000-4000-8000-${(_nextId++).toString().padLeft(12, '0')}';

  List<Map<String, Object?>> _linksFor(_Upload upload) {
    final int number = ++_links;
    return <Map<String, Object?>>[
      for (int i = 0; i < upload.chunkCount(chunkBytes); i += 1)
        if (!upload.chunks.containsKey(i))
          <String, Object?>{'index': i, 'url': '/sync/attachments/${upload.id}/chunks/$i?tenant=$tenantId&epoch=${upload.epoch}&expires=$number&signature=${'a' * 64}'},
    ];
  }

  HttpResult _json(int status, Object body) => HttpResult(status: status, headers: const <String, String>{'content-type': 'application/json'}, body: jsonEncode(body));

  HttpResult _problem(int status, String code) => HttpResult(
        status: status,
        headers: const <String, String>{'content-type': 'application/problem+json'},
        body: jsonEncode(<String, Object?>{'type': 'about:blank', 'title': code, 'status': status, 'code': code}),
      );
}

class _Upload {
  _Upload(this.id, this.sha256, this.size, this.mime);

  final String id;
  final String sha256;
  final int size;
  final String mime;
  final Map<int, Uint8List> chunks = <int, Uint8List>{};
  String status = 'UPLOADING';
  String? reason;
  int epoch = 1;
  Uint8List? stored;

  int chunkCount(int chunkBytes) => (size + chunkBytes - 1) ~/ chunkBytes;

  int chunkSizeAt(int index, int chunkBytes) => index == chunkCount(chunkBytes) - 1 ? size - index * chunkBytes : chunkBytes;
}
