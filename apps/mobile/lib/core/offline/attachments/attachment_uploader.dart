import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:path/path.dart' as p;

import '../../api/answer.dart';
import '../../api/problem.dart' show contractMismatchCode;
import '../../session/session.dart';
import '../queue/offline_codes.dart';
import '../store/local_store.dart';
import 'attachment_policy.dart';
import 'attachment_upload.dart';
import 'chunk_transport.dart';
import 'image_compressor.dart';

/// The file is not the file that was prepared (it was changed or removed while it waited).
const String kFileChanged = 'FILE_CHANGED';

/// The server answered the chunk with something that is neither a success nor a stale link.
const String kChunkRefused = 'CHUNK_REFUSED';

/// The device is not registered, so the server cannot be told whose upload this is.
const String kNoDevice = 'NO_DEVICE';

/// The attachment is not scanned clean, so it cannot be linked to a record.
final class AttachmentNotClean implements Exception {
  const AttachmentNotClean(this.state);

  final UploadState state;

  @override
  String toString() => 'AttachmentNotClean(${state.name})';
}

class _Failed implements Exception {
  const _Failed(this.code);

  final String code;
}

/// The attachments of one user in one tenant, uploaded in chunks (ST-MOB-009, MOB.md 5 BR-MOB-03).
///
/// A file is checked (size and type by its bytes), made lighter when it is a photo, copied into the private folder of the
/// application and hashed (SHA-256 of the whole); then it goes up in chunks to links the server signs for a few minutes. What
/// the server holds is the truth: after a cut network, a restart or an expired link the uploader asks which chunks arrived
/// and sends only the others. The server compares the checksum, judges the type by the bytes and has the file scanned; the
/// attachment can be linked to a record only when it is [UploadState.clean].
///
/// Use: `add` a file, `run` it (or let the runner do it), `watch` the list, and `linkableId` when a command needs the id of a
/// clean attachment.
class AttachmentUploader {
  AttachmentUploader({
    required LocalStore store,
    required MachvonApiClient client,
    required Uri baseUrl,
    required ChunkTransport chunks,
    required SessionSnapshot Function() session,
    required Future<String?> Function() deviceId,
    ImageCompressor? compressor,
    DateTime Function()? clock,
    String Function()? newKey,
    this.maxRestarts = 2,
    this.maxLinkRefreshes = 3,
  })  : _store = store,
        _client = client,
        _baseUrl = baseUrl,
        _chunks = chunks,
        _session = session,
        _deviceId = deviceId,
        _compressor = compressor ?? const PackageImageCompressor(),
        _clock = clock ?? DateTime.now,
        _newKey = newKey ?? newUuidV4;

  /// How often the server may drop the chunks (a checksum mismatch) before the upload is given up.
  final int maxRestarts;

  /// How often the links may expire during one upload before it is given up.
  final int maxLinkRefreshes;

  final LocalStore _store;
  final MachvonApiClient _client;
  final Uri _baseUrl;
  final ChunkTransport _chunks;
  final SessionSnapshot Function() _session;
  final Future<String?> Function() _deviceId;
  final ImageCompressor _compressor;
  final DateTime Function() _clock;
  final String Function() _newKey;
  final StreamController<void> _changes = StreamController<void>.broadcast();
  final StreamController<void> _arrivals = StreamController<void>.broadcast();
  final Map<String, Future<void>> _running = <String, Future<void>>{};
  Future<void> _tail = Future<void>.value();

  int get _now => _clock().millisecondsSinceEpoch;

  // ---------------------------------------------------------------------------------------------------- reading

  List<AttachmentUpload> uploads() => _store.uploads.all();

  AttachmentUpload? upload(String id) => _store.uploads.byId(id);

  /// A new upload was added (a file was prepared and queued). The runner that keeps the uploads moving listens to it, so a file
  /// added while the application is open goes up without waiting for the network to change.
  Stream<void> get arrivals => _arrivals.stream;

  /// The uploads now and again after every change, for MOB-19.
  Stream<List<AttachmentUpload>> watch() => Stream<List<AttachmentUpload>>.multi((MultiStreamController<List<AttachmentUpload>> controller) {
        controller.add(uploads());
        final StreamSubscription<void> subscription = _changes.stream.listen((void _) => controller.add(uploads()));
        controller.onCancel = subscription.cancel;
      });

  /// The id on the server of a clean attachment, the one a command that links it names. Any other state is
  /// [AttachmentNotClean]: a file that is still going up, is being scanned, was infected or failed is never linked.
  String linkableId(String id) {
    final AttachmentUpload? upload = _store.uploads.byId(id);
    if (upload == null) throw ArgumentError.value(id, 'id', 'is not an upload of this device');
    final String? serverId = upload.serverId;
    if (upload.state != UploadState.clean || serverId == null) throw AttachmentNotClean(upload.state);
    return serverId;
  }

  // --------------------------------------------------------------------------------------------------- making

  /// Checks [file], prepares the copy that will be uploaded and queues it. Throws [AttachmentRefused] (the file is not
  /// there, is empty, is larger than 50 MiB, or is not a JPEG, a PNG or a PDF by its bytes) before anything is copied.
  Future<AttachmentUpload> add({required File file, required String ownerKind, String? ownerRef, String? fileName}) async {
    final String mime = await checkAttachment(file);
    final String id = _newKey();
    final Directory directory = _store.uploadsDirectory..createSync(recursive: true);
    final File prepared = File(p.join(directory.path, id));
    if (mime == kMimeJpeg) {
      await prepared.writeAsBytes(await _compressor.compress(await file.readAsBytes(), mime), flush: true);
    } else {
      await file.copy(prepared.path);
    }
    final int size = await prepared.length();
    if (size > kMaxAttachmentBytes) {
      prepared.deleteSync();
      throw const AttachmentRefused(kFileTooLarge);
    }
    final Digest digest = await sha256.bind(prepared.openRead()).first;
    final int now = _now;
    final AttachmentUpload upload = AttachmentUpload(
      id: id,
      tenantId: _store.tenantId,
      userId: _store.userId,
      ownerKind: ownerKind,
      ownerRef: ownerRef,
      fileName: fileName ?? p.basename(file.path),
      sourcePath: prepared.path,
      mime: mime,
      sizeBytes: size,
      sha256: digest.toString(),
      state: UploadState.pending,
      startKey: _newKey(),
      completeKey: _newKey(),
      createdAt: now,
      updatedAt: now,
    );
    _store.uploads.upsert(upload);
    _changes.add(null);
    _arrivals.add(null);
    return upload;
  }

  // ------------------------------------------------------------------------------------------------- sending

  /// A process that died while a file was going up leaves it `uploading` or `scanning`; both are picked up again (the server
  /// says what it holds), so they go back to waiting.
  int recoverInterrupted() {
    int count = 0;
    for (final AttachmentUpload upload in uploads()) {
      if (upload.state == UploadState.uploading) {
        _set(upload.copyWith(state: UploadState.pending, errorCode: kInterrupted));
        count += 1;
      }
    }
    return count;
  }

  /// Uploads every file that is waiting, one after the other, oldest first.
  Future<void> resumeAll() async {
    for (final AttachmentUpload upload in uploads()) {
      if (!upload.state.isFinal) await run(upload.id);
    }
  }

  /// Uploads one file, or continues it where the server stopped. Calls made while it runs join it; one file at a time is
  /// sent. A network that fails leaves the file waiting (`pending` with `NETWORK_ERROR`); a refusal of the server ends it
  /// with the code; neither throws.
  Future<void> run(String id) {
    final Future<void>? running = _running[id];
    if (running != null) return running;
    final Future<void> job = _serial(() => _run(id)).whenComplete(() {
      _running.remove(id);
    });
    _running[id] = job;
    return job;
  }

  Future<void> _serial(Future<void> Function() action) {
    final Future<void> run = _tail.then((void _) => action());
    _tail = run.then((void _) {}, onError: (Object _) {});
    return run;
  }

  /// Starts a new upload of the same prepared file after a refusal or an infection (the person's retry). The old attempt
  /// stays as it was until the new one replaces it: the row gets new keys and starts again from the first chunk.
  Future<void> retry(String id) {
    final AttachmentUpload upload = _require(id);
    if (upload.state != UploadState.failed && upload.state != UploadState.infected) throw StateError('a ${upload.state.name} upload cannot be retried');
    if (!File(upload.sourcePath).existsSync()) throw StateError('the prepared file is gone');
    _set(upload.copyWith(state: UploadState.pending, clearServer: true, clearError: true, restarts: 0, startKey: _newKey(), completeKey: _newKey()));
    return run(id);
  }

  /// Drops an upload that is not finished and removes its prepared copy. The chunks the server holds are not linked to
  /// anything and are cleaned up by the server.
  void cancel(String id) {
    final AttachmentUpload upload = _require(id);
    if (upload.state.isFinal) throw StateError('a ${upload.state.name} upload cannot be cancelled');
    _set(upload.copyWith(state: UploadState.cancelled));
    final File prepared = File(upload.sourcePath);
    if (prepared.existsSync()) prepared.deleteSync();
  }

  Future<void> _run(String id) async {
    AttachmentUpload upload = _require(id);
    if (upload.state.isFinal) return;
    final SessionSnapshot session = _session();
    if (!session.isSignedIn || session.tenantId != _store.tenantId || session.userId != _store.userId) return;
    final String? device = await _deviceId();
    if (device == null) {
      _set(upload.copyWith(state: UploadState.pending, errorCode: kNoDevice));
      return;
    }
    upload = _set(upload.copyWith(state: UploadState.uploading, clearError: true));
    try {
      final File file = File(upload.sourcePath);
      if (!file.existsSync() || file.lengthSync() != upload.sizeBytes) throw const _Failed(kFileChanged);
      await _transfer(await _started(upload, device));
    } on _Failed catch (failure) {
      _set(_require(id).copyWith(state: UploadState.failed, errorCode: failure.code));
    } on ChunkLinkRefused {
      _set(_require(id).copyWith(state: UploadState.failed, errorCode: 'CHUNK_LINK_REFUSED'));
    } on ApiError catch (error) {
      final bool waits = error.status == 0 || error.status == 401 || error.status == 429 || error.status >= 500;
      _set(_require(id).copyWith(state: waits ? UploadState.pending : UploadState.failed, errorCode: error.code));
    } on ContractMismatch {
      _set(_require(id).copyWith(state: UploadState.pending, errorCode: contractMismatchCode));
    } on FileSystemException {
      _set(_require(id).copyWith(state: UploadState.failed, errorCode: kFileChanged));
    } on IOException {
      _set(_require(id).copyWith(state: UploadState.pending, errorCode: networkErrorCode));
    } on TimeoutException {
      _set(_require(id).copyWith(state: UploadState.pending, errorCode: networkErrorCode));
    }
  }

  /// The upload on the server: the one this file already has, or a new one. The start carries the idempotency key of the
  /// upload, so if the answer was lost the same upload comes back rather than a second one.
  Future<_Links> _started(AttachmentUpload upload, String device) async {
    if (upload.serverId != null) return _Links.stale(upload);
    final Object? answer = await _client.postSyncAttachments(
      SyncAttachmentInit(deviceId: device, sha256: upload.sha256!, sizeBytes: upload.sizeBytes, mime: upload.mime!),
      attempt: CommandAttempt(upload.startKey),
    );
    final SyncAttachmentStartedResponse started = decodeAnswer('post_sync_attachments', answer)! as SyncAttachmentStartedResponse;
    final AttachmentUpload next = _set(upload.copyWith(serverId: started.resourceId, chunkBytes: started.chunkBytes, chunkCount: started.chunkCount, sentChunks: const <int>{}));
    return _Links(next, <int, String>{for (final SyncAttachmentStartedResponseChunksItem chunk in started.chunks) chunk.index: chunk.url});
  }

  Future<void> _transfer(_Links first) async {
    AttachmentUpload upload = first.upload;
    Map<int, String>? links = first.links;
    int refreshes = 0;
    while (true) {
      if (links == null) {
        // What the server holds decides what is sent, not what the phone remembers.
        final SyncAttachmentStatusResponse status = await _status(upload);
        if (status.status != 'UPLOADING') return _settle(upload, status);
        upload = _set(upload.copyWith(sentChunks: status.received.toSet()));
        links = <int, String>{for (final SyncAttachmentStatusResponseChunksItem chunk in status.chunks) chunk.index: chunk.url};
      }
      bool stale = false;
      for (final int index in (links.keys.toList()..sort())) {
        if (upload.sentChunks.contains(index)) continue;
        final ChunkAnswer answer = await _chunks.put(resolveChunkUrl(_baseUrl, links[index]!, upload.tenantId), await _readChunk(upload, index));
        if (answer.ok) {
          upload = _set(upload.copyWith(sentChunks: <int>{...upload.sentChunks, index}));
        } else if (answer.status == 401 || answer.status == 409) {
          stale = true;
          break;
        } else {
          throw _Failed(answer.code.isEmpty ? kChunkRefused : answer.code);
        }
      }
      if (stale) {
        refreshes += 1;
        if (refreshes > maxLinkRefreshes) throw const _Failed('SIGNATURE_INVALID');
        links = null;
        continue;
      }
      // Every chunk is acknowledged: the server puts the file together, compares it and has it scanned.
      final AttachmentUpload? next = await _complete(_set(upload.copyWith(state: UploadState.scanning)));
      if (next == null) return;
      upload = _set(next.copyWith(state: UploadState.uploading));
      links = null;
    }
  }

  /// Completes the upload. Returns null when the upload is settled (or waits to be looked at), or the upload to go round again
  /// with: the server is missing a chunk, or it dropped them because the checksum did not match.
  Future<AttachmentUpload?> _complete(AttachmentUpload upload) async {
    try {
      final Object? answer = await _client.postSyncAttachmentsIdComplete(SyncAttachmentComplete(sha256: upload.sha256!), id: upload.serverId!, attempt: CommandAttempt(upload.completeKey));
      final CommandResultResponse result = decodeAnswer('post_sync_attachments_id_complete', answer)! as CommandResultResponse;
      switch (result.status) {
        case 'CLEAN':
          _clean(upload);
        case 'INFECTED':
          _set(upload.copyWith(state: UploadState.infected, errorCode: (await _status(upload)).reason ?? kFileInfected));
        case 'SCANNING':
          _set(upload.copyWith(state: UploadState.scanning, clearError: true));
        default:
          throw const _Failed('UNEXPECTED_STATUS');
      }
      return null;
    } on ApiError catch (error) {
      if (error.code == 'ATTACHMENT_CHUNKS_MISSING') return upload;
      if (error.code == kChecksumMismatch) {
        // The server dropped the chunks. The refusal is remembered under the key of this completion, so the next one has a new key.
        if (upload.restarts >= maxRestarts) throw const _Failed(kChecksumMismatch);
        return _set(upload.copyWith(sentChunks: const <int>{}, restarts: upload.restarts + 1, completeKey: _newKey()));
      }
      rethrow;
    }
  }

  /// The server holds the file and it is scanned clean: the prepared copy on the phone has no further use, and a plain copy of a
  /// photograph must not stay on the device after it has gone up (SEC-03). The row keeps the name, size, checksum and server id.
  void _clean(AttachmentUpload upload) {
    _set(upload.copyWith(state: UploadState.clean, clearError: true));
    final File prepared = File(upload.sourcePath);
    if (prepared.existsSync()) prepared.deleteSync();
  }

  Future<SyncAttachmentStatusResponse> _status(AttachmentUpload upload) async {
    final Object? answer = await _client.getSyncAttachmentsId(id: upload.serverId!);
    return decodeAnswer('get_sync_attachments_id', answer)! as SyncAttachmentStatusResponse;
  }

  void _settle(AttachmentUpload upload, SyncAttachmentStatusResponse status) {
    switch (status.status) {
      case 'SCANNING':
        _set(upload.copyWith(state: UploadState.scanning, clearError: true));
      case 'CLEAN':
        _clean(upload);
      case 'INFECTED':
        _set(upload.copyWith(state: UploadState.infected, errorCode: status.reason ?? kFileInfected));
      default:
        throw const _Failed('UNEXPECTED_STATUS');
    }
  }

  Future<Uint8List> _readChunk(AttachmentUpload upload, int index) async {
    final int chunkBytes = upload.chunkBytes!;
    final int offset = index * chunkBytes;
    final int length = (upload.sizeBytes - offset).clamp(0, chunkBytes);
    if (length == 0) throw const _Failed(kFileChanged);
    final RandomAccessFile reader = await File(upload.sourcePath).open();
    try {
      await reader.setPosition(offset);
      return await reader.read(length);
    } finally {
      await reader.close();
    }
  }

  AttachmentUpload _require(String id) => _store.uploads.byId(id) ?? (throw StateError('no upload $id'));

  AttachmentUpload _set(AttachmentUpload upload) {
    final AttachmentUpload next = upload.copyWith(updatedAt: _now);
    _store.uploads.upsert(next);
    _changes.add(null);
    return next;
  }

  Future<void> dispose() async {
    await _arrivals.close();
    await _changes.close();
  }
}

/// An upload and the links of the chunks it still has to send; null links mean "ask the server first".
class _Links {
  const _Links(this.upload, this.links);

  factory _Links.stale(AttachmentUpload upload) => _Links(upload, null);

  final AttachmentUpload upload;
  final Map<int, String>? links;
}
