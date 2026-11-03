import '../read_support/wire.dart';
import 'vendor_sdk.dart' show sameSubject;

/// The role a signing session is for; the phone only ever opens the leader's (numbering and the seal of the organisation are the
/// clerk's, on the web: DOC-06).
const String leaderRole = 'LEADER';

/// The stage of the file that waits for the leader's signature, and of the file the leader's signature produces.
const String finalStage = 'RENDERED_FINAL';
const String leaderSignedStage = 'LEADER_SIGNED';

/// A session that still waits for its signer (the server's words; the phone never judges the 15 minutes with its own clock).
const List<String> openSessionStatuses = <String>['CREATED', 'HASH_READY', 'AWAITING_SIGNER'];

/// One outgoing document waiting for the leader (`listOutgoingDocuments?status=SUBMITTED`).
final class WaitingDocument {
  const WaitingDocument({required this.id, required this.title, required this.docTypeCode, this.signerTitle, this.signerUserId, this.drafterUserId});

  final String id;
  final String title;
  final String docTypeCode;
  final String? signerTitle;
  final String? signerUserId;
  final String? drafterUserId;
}

WaitingDocument? parseWaitingDocument(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  return WaitingDocument(
    id: id,
    title: text(row['title']) ?? '',
    docTypeCode: text(row['doc_type_code']) ?? '',
    signerTitle: filled(row['signer_title']),
    signerUserId: filled(row['signer_user_id']),
    drafterUserId: filled(row['drafter_user_id']),
  );
}

final class WaitingList {
  const WaitingList({required this.documents, required this.more, this.asOf});

  final List<WaitingDocument> documents;

  /// The queue has more documents than the pages that were read.
  final bool more;
  final String? asOf;
}

WaitingList? parseWaitingList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return WaitingList(
    documents: <WaitingDocument>[for (final Object? item in listOf(body['items'])) ?parseWaitingDocument(item)],
    more: filled(body['next_cursor']) != null,
    asOf: filled(body['as_of']),
  );
}

/// One stored file version of a document. A stored version never changes.
final class FileVersion {
  const FileVersion({required this.id, required this.version, required this.stage, required this.checksum, required this.pageCount, required this.scanStatus, this.byteLength, this.prefixSha256, this.createdAt});

  final String id;
  final int version;
  final String stage;

  /// SHA-256 of the whole file, in lower-case hex.
  final String checksum;
  final int pageCount;
  final String scanStatus;
  final int? byteLength;

  /// SHA-256 of the file this version was built on top of (the signature is an incremental update): it is how the phone shows that
  /// the content signed is the content that was read.
  final String? prefixSha256;
  final String? createdAt;

  bool get isClean => scanStatus == 'CLEAN';
}

FileVersion? parseFileVersion(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? checksum = filled(row?['checksum']);
  if (row == null || id == null || version == null || checksum == null) return null;
  return FileVersion(
    id: id,
    version: version,
    stage: text(row['stage']) ?? '',
    checksum: checksum.toLowerCase(),
    pageCount: count(row['page_count']),
    scanStatus: text(row['scan_status']) ?? '',
    byteLength: whole(row['byte_length']),
    prefixSha256: filled(row['prefix_sha256'])?.toLowerCase(),
    createdAt: filled(row['created_at']),
  );
}

/// A signing session as the server keeps it.
final class SigningSession {
  const SigningSession({required this.id, required this.role, required this.status, required this.expiresAt, required this.version, required this.adapterCode, this.digestHex, this.errorCode, this.resultVersionId});

  final String id;
  final String role;
  final String status;
  final String expiresAt;
  final int version;
  final String adapterCode;
  final String? digestHex;
  final String? errorCode;
  final String? resultVersionId;

  bool get isOpen => openSessionStatuses.contains(status);
}

SigningSession? parseSession(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? status = filled(row?['status']);
  final String? expiresAt = filled(row?['expires_at']);
  final int? version = whole(row?['version']);
  if (row == null || id == null || status == null || expiresAt == null || version == null) return null;
  return SigningSession(
    id: id,
    role: text(row['role']) ?? '',
    status: status,
    expiresAt: expiresAt,
    version: version,
    adapterCode: text(row['adapter_code']) ?? '',
    digestHex: filled(row['digest_hex']),
    errorCode: filled(row['error_code']),
    resultVersionId: filled(row['result_version_id']),
  );
}

/// A certificate the signer may sign with.
final class SigningCertificate {
  const SigningCertificate({required this.id, required this.kind, required this.subject, required this.validUntil, required this.status});

  final String id;
  final String kind;
  final String subject;
  final String validUntil;
  final String status;

  bool get isActivePersonal => kind == 'PERSONAL' && status == 'Active';
}

SigningCertificate? parseCertificate(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  return SigningCertificate(
    id: id,
    kind: row['kind'] == 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSONAL',
    subject: text(row['subject_dn']) ?? '',
    validUntil: text(row['valid_until']) ?? '',
    status: text(row['status']) ?? '',
  );
}

/// The verdict of the server's verification of one signature of the current file.
final class SignatureVerdict {
  const SignatureVerdict({required this.role, required this.status, this.signedAt, this.subject, this.incrementalChangesAllowed});

  final String role;

  /// `VALID`, `INVALID` or `INDETERMINATE`.
  final String status;
  final String? signedAt;
  final String? subject;
  final bool? incrementalChangesAllowed;
}

SignatureVerdict? parseVerdict(Object? raw) {
  final Json? row = asRecord(raw);
  final String? role = filled(row?['role']);
  final String? status = filled(row?['status']);
  if (row == null || role == null || status == null) return null;
  return SignatureVerdict(
    role: role,
    status: status,
    signedAt: filled(row['signed_at']),
    subject: filled(row['subject_dn']),
    incrementalChangesAllowed: row['incremental_changes_allowed'] is bool ? row['incremental_changes_allowed'] as bool : null,
  );
}

/// One outgoing document with what the leader needs to read it, compare it and sign it (`getOutgoingDocument`).
final class SigningDocument {
  const SigningDocument({
    required this.id,
    required this.version,
    required this.status,
    required this.title,
    required this.docTypeCode,
    required this.versions,
    required this.sessions,
    required this.certificates,
    required this.signatures,
    this.signerUserId,
    this.signerTitle,
    this.drafterUserId,
    this.currentVersionId,
    this.leaderSignedAt,
    this.asOf,
  });

  final String id;

  /// The version the screen saw: the first command is sent under it (`If-Match`).
  final int version;
  final String status;
  final String title;
  final String docTypeCode;
  final String? signerUserId;
  final String? signerTitle;
  final String? drafterUserId;
  final String? currentVersionId;
  final String? leaderSignedAt;
  final List<FileVersion> versions;
  final List<SigningSession> sessions;
  final List<SigningCertificate> certificates;
  final List<SignatureVerdict> signatures;
  final String? asOf;

  bool get isSubmitted => status == 'SUBMITTED';
  bool get isLeaderSigned => leaderSignedAt != null;

  /// The file that is read and signed: the current version of the document.
  FileVersion? get currentFile {
    for (final FileVersion file in versions) {
      if (file.id == currentVersionId) return file;
    }
    return null;
  }

  /// The version before the current one, in the order of the versions: what the current file is compared with.
  FileVersion? get previousFile {
    final FileVersion? current = currentFile;
    if (current == null) return null;
    FileVersion? best;
    for (final FileVersion file in versions) {
      if (file.version < current.version && (best == null || file.version > best.version)) best = file;
    }
    return best;
  }

  /// The newest session of the leader (the list comes newest first).
  SigningSession? get lastLeaderSession {
    for (final SigningSession session in sessions) {
      if (session.role == leaderRole) return session;
    }
    return null;
  }

  SigningSession? get openLeaderSession {
    final SigningSession? last = lastLeaderSession;
    return last != null && last.isOpen ? last : null;
  }

  /// The certificate the leader signs with: the personal one in force that ends last.
  SigningCertificate? get signingCertificate {
    final List<SigningCertificate> active = certificates.where((SigningCertificate c) => c.isActivePersonal).toList()
      ..sort((SigningCertificate a, SigningCertificate b) => b.validUntil.compareTo(a.validUntil));
    return active.isEmpty ? null : active.first;
  }

  /// The verdict on the leader's signature on the current file, when there is one.
  SignatureVerdict? get leaderVerdict {
    for (final SignatureVerdict verdict in signatures) {
      if (verdict.role == leaderRole) return verdict;
    }
    return null;
  }

  /// Whether the name on the leader's signature, as the server read it off the signature, is the holder of the certificate registered for
  /// the signer (AC-ST-MOB-032-1). Null while there is nothing to compare: no signature yet, or a signature or a certificate with no name.
  bool? get signerMatchesCertificate {
    final String? signed = leaderVerdict?.subject;
    final SigningCertificate? certificate = signingCertificate;
    if (signed == null || certificate == null || certificate.subject.isEmpty) return null;
    return sameSubject(signed, certificate.subject);
  }

  /// Whether the signature left the content as it was read. The signature is added to the file as an incremental update, so the
  /// version it produced remembers the hash of the whole file it was built on (`prefix_sha256`): when that is the hash of the
  /// version that was read, nothing of the content changed. Null while the current file is not the leader's signed one.
  bool? get signedContentUnchanged {
    final FileVersion? current = currentFile;
    if (current == null || current.stage != leaderSignedStage) return null;
    final String? prefix = current.prefixSha256;
    if (prefix == null) return null;
    for (final FileVersion file in versions) {
      if (file.stage == finalStage && file.checksum == prefix) return true;
    }
    return false;
  }
}

SigningDocument? parseSigningDocument(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final int? version = whole(row?['version']);
  final String? status = filled(row?['status']);
  if (row == null || id == null || version == null || status == null) return null;
  return SigningDocument(
    id: id,
    version: version,
    status: status,
    title: text(row['title']) ?? '',
    docTypeCode: text(row['doc_type_code']) ?? '',
    signerUserId: filled(row['signer_user_id']),
    signerTitle: filled(row['signer_title']),
    drafterUserId: filled(row['drafter_user_id']),
    currentVersionId: filled(row['current_version_id']),
    leaderSignedAt: filled(row['leader_signed_at']),
    versions: <FileVersion>[for (final Object? item in listOf(row['versions'])) ?parseFileVersion(item)],
    sessions: <SigningSession>[for (final Object? item in listOf(row['sessions'])) ?parseSession(item)],
    certificates: <SigningCertificate>[for (final Object? item in listOf(row['certificates'])) ?parseCertificate(item)],
    signatures: <SignatureVerdict>[for (final Object? item in listOf(row['signatures'])) ?parseVerdict(item)],
    asOf: filled(row['as_of']),
  );
}
