/// Where an attachment upload stands (MOB.md 5 BR-MOB-03). The path of the server is UPLOADING, SCANNING, CLEAN or
/// INFECTED; the phone adds the states that exist only on the device.
enum UploadState {
  /// Prepared and waiting for a network, or interrupted and waiting to resume. [AttachmentUpload.errorCode] tells which.
  pending,

  /// The chunks are going up.
  uploading,

  /// Complete on the server, which compares the checksum and has the file scanned.
  scanning,

  /// Scanned clean: the only state in which the attachment can be linked to a record.
  clean,

  /// The scan found a virus. The file is not linked; the person starts a new upload to try again.
  infected,

  /// Refused for good (too large, not an allowed type, a checksum that cannot be made right). The reason is a code.
  failed,

  /// Dropped by the person.
  cancelled;

  bool get isFinal => this == clean || this == infected || this == failed || this == cancelled;

  static UploadState parse(String name) => UploadState.values.byName(name);
}

/// One file on its way to the server (`attachment_upload`). The file itself stays where it is; the row remembers the
/// upload on the server and which chunks it holds, so the app can be killed at any moment and the upload resumed.
final class AttachmentUpload {
  const AttachmentUpload({
    required this.id,
    required this.tenantId,
    required this.userId,
    required this.ownerKind,
    required this.fileName,
    required this.sourcePath,
    required this.sizeBytes,
    required this.state,
    required this.startKey,
    required this.completeKey,
    required this.createdAt,
    required this.updatedAt,
    this.ownerRef,
    this.mime,
    this.sha256,
    this.serverId,
    this.chunkBytes,
    this.chunkCount,
    this.sentChunks = const <int>{},
    this.restarts = 0,
    this.errorCode,
  });

  final String id;
  final String tenantId;
  final String userId;

  /// The kind of record the file is for (`report`, `issue`, ...) and its local id or server id.
  final String ownerKind;
  final String? ownerRef;
  final String fileName;

  /// The file that is uploaded: the prepared copy (compressed when it is a photo), never the gallery original.
  final String sourcePath;
  final String? mime;
  final int sizeBytes;
  final String? sha256;
  final UploadState state;

  /// The idempotency keys of the two commands of an upload; a repeated start or completion gets the same answer.
  final String startKey;
  final String completeKey;

  /// The id of the upload on the server, once it has started.
  final String? serverId;
  final int? chunkBytes;
  final int? chunkCount;

  /// The chunks the server has acknowledged (its answer, not a guess).
  final Set<int> sentChunks;

  /// How often the server dropped the chunks (a checksum mismatch) and the upload began again.
  final int restarts;
  final String? errorCode;
  final int createdAt;
  final int updatedAt;

  /// Whole chunks acknowledged out of the chunks of the file, for the progress bar; null before the upload has started.
  double? get progress {
    final int? total = chunkCount;
    if (total == null || total == 0) return null;
    return sentChunks.length / total;
  }

  AttachmentUpload copyWith({
    String? mime,
    String? sha256,
    UploadState? state,
    String? serverId,
    bool clearServer = false,
    int? chunkBytes,
    int? chunkCount,
    Set<int>? sentChunks,
    int? restarts,
    String? errorCode,
    bool clearError = false,
    String? startKey,
    String? completeKey,
    int? updatedAt,
  }) =>
      AttachmentUpload(
        id: id,
        tenantId: tenantId,
        userId: userId,
        ownerKind: ownerKind,
        ownerRef: ownerRef,
        fileName: fileName,
        sourcePath: sourcePath,
        sizeBytes: sizeBytes,
        mime: mime ?? this.mime,
        sha256: sha256 ?? this.sha256,
        state: state ?? this.state,
        startKey: startKey ?? this.startKey,
        completeKey: completeKey ?? this.completeKey,
        serverId: clearServer ? null : serverId ?? this.serverId,
        chunkBytes: clearServer ? null : chunkBytes ?? this.chunkBytes,
        chunkCount: clearServer ? null : chunkCount ?? this.chunkCount,
        sentChunks: clearServer ? const <int>{} : sentChunks ?? this.sentChunks,
        restarts: restarts ?? this.restarts,
        errorCode: clearError ? null : errorCode ?? this.errorCode,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
      );
}
