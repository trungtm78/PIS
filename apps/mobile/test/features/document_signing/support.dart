import 'dart:convert';
import 'dart:typed_data';

import 'package:image/image.dart' as img;
import 'package:machvon_mobile/features/document_signing/document_fetcher.dart';
import 'package:machvon_mobile/features/document_signing/pdf_engine.dart';
import 'package:machvon_mobile/features/document_signing/signing_models.dart';
import 'package:machvon_mobile/features/document_signing/signing_port.dart';

export '../acceptance_handover/fixtures.dart' show page, problem, recorded;

/// The bytes of a document that is a PDF to the checks of the phone (`%PDF-`), different for each [label].
Uint8List pdfBytes(String label) => Uint8List.fromList(utf8.encode('%PDF-1.7\n$label\n%%EOF'));

String hashOf(String label) => sha256Hex(pdfBytes(label));

/// One page as a PNG: white, with a black block where [mark] says (so pages with different marks differ).
Uint8List pagePng(int mark) {
  final img.Image image = img.Image(width: 60, height: 80);
  img.fill(image, color: img.ColorRgb8(255, 255, 255));
  if (mark > 0) img.fillRect(image, x1: 4, y1: 4 + mark * 4, x2: 40, y2: 20 + mark * 4, color: img.ColorRgb8(0, 0, 0));
  return Uint8List.fromList(img.encodePng(image));
}

/// A page that is one flat colour.
Uint8List solidPng(int red, int green, int blue) {
  final img.Image image = img.Image(width: 20, height: 20);
  img.fill(image, color: img.ColorRgb8(red, green, blue));
  return Uint8List.fromList(img.encodePng(image));
}

/// A document the fake renderer "reads": the marks of its pages.
final class FakePdfDoc implements PdfDoc {
  FakePdfDoc(this.marks);

  final List<int> marks;
  bool closed = false;
  final List<int> rendered = <int>[];

  @override
  int get pageCount => marks.length;

  @override
  Future<RenderedPage> render(int index, {required int width}) async {
    rendered.add(index);
    return RenderedPage(png: pagePng(marks[index]), width: 60, height: 80);
  }

  @override
  Future<void> close() async => closed = true;
}

/// A renderer that opens the files of the tests by their bytes: the label inside them says which pages they have.
final class FakePdfEngine implements PdfEngine {
  FakePdfEngine(this.pages);

  /// Pages (their marks) by the label of the file.
  final Map<String, List<int>> pages;
  final List<FakePdfDoc> opened = <FakePdfDoc>[];
  bool unreadable = false;

  @override
  Future<PdfDoc> open(Uint8List bytes) async {
    if (unreadable) throw const PdfOpenException();
    final String text = utf8.decode(bytes);
    final String label = text.split('\n')[1];
    final FakePdfDoc doc = FakePdfDoc(pages[label] ?? const <int>[0]);
    opened.add(doc);
    return doc;
  }
}

/// A fetcher that returns the file behind an address and records what was asked.
final class FakeFetcher implements DocumentFetcher {
  FakeFetcher(this.files);

  final Map<String, Uint8List> files;
  final List<Uri> asked = <Uri>[];
  Object? failure;

  @override
  Future<Uint8List> fetch(Uri url, {int maxBytes = maxDocumentBytes}) async {
    asked.add(url);
    if (failure != null) throw failure!;
    return files[url.toString()] ?? (throw const DocumentFetchException(FetchFailure.unreachable));
  }
}

/// A phone whose signing key is held by a vendor SDK behind a biometric: the port signs the digest by itself.
final class FakeSdkPort implements SigningPort {
  FakeSdkPort({this.proof});

  SigningProof? proof;
  final List<SigningChallenge> challenges = <SigningChallenge>[];

  @override
  String get adapterCode => 'LOCAL_AGENT';

  @override
  bool get needsTypedCode => false;

  @override
  bool get unlocksCredential => true;

  @override
  Future<Readiness> readiness({SigningCertificate? certificate}) async => Readiness.ready;

  @override
  Future<SigningProof?> prove(SigningChallenge challenge, {String? typedCode}) async {
    challenges.add(challenge);
    return proof ?? SigningProof(cmsSignature: 'Q01TLXNpZ25hdHVyZQ==', clientDigestHex: challenge.digestHex);
  }
}

// ---- what the server answers ---------------------------------------------------------------------------------------------------

const String kDigest = 'a3f5c2d1e4b6978800aabbccddeeff00112233445566778899aabbccddeeff00';

Map<String, Object?> fileVersion(String id, int version, String stage, String label, {int pages = 2, String scan = 'CLEAN', String? prefix}) => <String, Object?>{
      'id': id,
      'version': version,
      'stage': stage,
      'checksum': hashOf(label),
      'byte_length': pdfBytes(label).length,
      'page_count': pages,
      'scan_status': scan,
      'prefix_sha256': prefix,
      'created_at': '2026-11-02T03:00:00Z',
    };

Map<String, Object?> session(String id, {String status = 'AWAITING_SIGNER', int version = 2, String? result}) => <String, Object?>{
      'id': id,
      'outgoing_document_id': 'd-1',
      'role': 'LEADER',
      'status': status,
      'signer_user_id': 'mem-1',
      'signing_certificate_id': 'cert-1',
      'adapter_code': 'REMOTE_CA',
      'adapter_status': 'VERIFIED',
      'base_version_id': 'v-2',
      'result_version_id': result,
      'digest_hex': kDigest,
      'expires_at': '2026-11-03T03:15:00Z',
      'attempts': 0,
      'error_code': null,
      'created_at': '2026-11-03T03:00:00Z',
      'version': version,
    };

/// The SHA-256 of the registered certificate of the fixtures (what the server holds as `fingerprint_sha256`).
final String kCertificateFingerprint = 'ab' * 32;

Map<String, Object?> certificate({String status = 'Active', String kind = 'PERSONAL'}) => <String, Object?>{
      'id': 'cert-1',
      'kind': kind,
      'subject_dn': 'CN=Lê Lãnh Đạo,O=UBND tỉnh A',
      'issuer_dn': 'CN=CA Test',
      'fingerprint_sha256': kCertificateFingerprint,
      'valid_until': '2027-06-30T00:00:00Z',
      'status': status,
    };

/// An outgoing document that waits for the leader: version 1 is a draft render, version 2 the final PDF.
Map<String, Object?> outgoing({
  String id = 'd-1',
  String status = 'SUBMITTED',
  int version = 7,
  String? signer = 'mem-1',
  String? leaderSignedAt,
  List<Map<String, Object?>>? versions,
  List<Map<String, Object?>> sessions = const <Map<String, Object?>>[],
  List<Map<String, Object?>>? certificates,
  List<Map<String, Object?>> signatures = const <Map<String, Object?>>[],
  String current = 'v-2',
}) =>
    <String, Object?>{
      'id': id,
      'document_id': 'doc-1',
      'title': 'Quyết định giao vốn năm 2026',
      'doc_type_code': 'QD',
      'status': status,
      'drafting_unit_id': 'u-1',
      'drafter_user_id': 'mem-9',
      'signer_user_id': signer,
      'signer_title': 'Phó Chủ tịch',
      'current_version_id': current,
      'leader_signed_at': leaderSignedAt,
      'version': version,
      'versions': versions ?? <Map<String, Object?>>[fileVersion('v-2', 2, 'RENDERED_FINAL', 'final', pages: 3), fileVersion('v-1', 1, 'DRAFT', 'draft', pages: 2)],
      'sessions': sessions,
      'certificates': certificates ?? <Map<String, Object?>>[certificate()],
      'signatures': signatures,
    };

/// The document after the leader signed: the signed file is version 3, built on the final PDF.
Map<String, Object?> signedOutgoing({String prefix = ''}) {
  final String final_ = prefix.isEmpty ? hashOf('final') : prefix;
  return outgoing(
    leaderSignedAt: '2026-11-03T03:05:00Z',
    version: 9,
    current: 'v-3',
    versions: <Map<String, Object?>>[
      fileVersion('v-3', 3, 'LEADER_SIGNED', 'signed', pages: 3, prefix: final_),
      fileVersion('v-2', 2, 'RENDERED_FINAL', 'final', pages: 3),
      fileVersion('v-1', 1, 'DRAFT', 'draft', pages: 2),
    ],
    sessions: <Map<String, Object?>>[session('s-1', status: 'EMBEDDED', result: 'v-3')],
    signatures: <Map<String, Object?>>[
      <String, Object?>{'role': 'LEADER', 'status': 'VALID', 'subject_dn': 'CN=Lê Lãnh Đạo', 'signed_at': '2026-11-03T03:05:00Z', 'incremental_changes_allowed': true, 'findings': <Object?>[]},
    ],
  );
}

Map<String, Object?> download(String label, {String? url, String? checksum}) => <String, Object?>{
      'version_id': 'v',
      'url': url ?? 'https://files.test/$label?sig=1',
      'expires_at': '2026-11-03T03:05:00Z',
      'mime': 'application/pdf',
      'checksum': checksum ?? hashOf(label),
      'page_count': 3,
    };
