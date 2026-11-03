import '../read_support/wire.dart';

/// What the model may say about a criterion (`SUPPORTED`, `CONTRADICTED`, `MISSING`, `NEEDS_REVIEW`). Whatever it says is a proposal: a
/// person decides (BR-BID-09), and that decision is kept apart from this status.
const List<String> findingStatuses = <String>['SUPPORTED', 'CONTRADICTED', 'MISSING', 'NEEDS_REVIEW'];

/// One citation under a finding. `verified` is the server's word that the words quoted are on the page they name (BR-BID-07); the phone
/// never decides it.
final class Evidence {
  const Evidence({required this.id, required this.kind, required this.verified, this.documentVersionId, this.pageIndex, this.quote, this.calcId});

  final String id;
  final String kind;
  final bool verified;
  final String? documentVersionId;

  /// From 0; the screen shows the page as `pageIndex + 1`.
  final int? pageIndex;
  final String? quote;

  /// The figure the pipeline computed in code (`calc_ref.id`), for a citation that is a calculation and not a page.
  final String? calcId;

  /// A citation that names a page of a file can be opened at its source.
  bool get hasSource => kind == 'DOCUMENT' && documentVersionId != null && pageIndex != null;
}

Evidence? parseEvidence(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  if (row == null || id == null) return null;
  return Evidence(
    id: id,
    kind: text(row['kind']) ?? 'DOCUMENT',
    verified: row['verified_present'] == true,
    documentVersionId: filled(row['document_version_id']),
    pageIndex: whole(row['page_index']),
    quote: filled(row['quote_excerpt']),
    calcId: filled(asRecord(row['calc_ref'])?['id']),
  );
}

/// One finding of an analysis run. The AI proposal ([status], [text]) and what a person decided ([finalStatus]) are separate.
final class Finding {
  const Finding({
    required this.id,
    required this.runId,
    required this.criterionId,
    required this.status,
    required this.text,
    required this.confidenceType,
    required this.missingSource,
    required this.evidence,
    required this.reviewCount,
    this.finalStatus,
    this.reviewedAt,
  });

  final String id;
  final String runId;
  final String criterionId;
  final String status;
  final String text;

  /// `CALIBRATED`, `HEURISTIC` or `NONE`: a signal, never the probability of being right (BR-BID-08).
  final String confidenceType;

  /// The model claimed without a citation found on its page and was taken back to `NEEDS_REVIEW` (BR-BID-07).
  final bool missingSource;
  final String? finalStatus;
  final String? reviewedAt;
  final int reviewCount;
  final List<Evidence> evidence;

  /// No person has decided this finding yet: it awaits verification, and nothing on the phone can change that.
  bool get awaitsVerification => finalStatus == null;

  int get verifiedCount => evidence.where((Evidence item) => item.verified).length;
}

Finding? parseFinding(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? runId = filled(row?['run_id']);
  final String? criterion = filled(row?['criterion_id']);
  final String? status = filled(row?['status']);
  if (row == null || id == null || runId == null || criterion == null || status == null || !findingStatuses.contains(status)) return null;
  return Finding(
    id: id,
    runId: runId,
    criterionId: criterion,
    status: status,
    text: text(row['finding']) ?? '',
    confidenceType: text(row['confidence_type']) ?? 'NONE',
    missingSource: row['missing_source'] == true,
    finalStatus: findingStatuses.contains(row['final_status']) ? row['final_status'] as String : null,
    reviewedAt: filled(row['reviewed_at']),
    reviewCount: count(row['review_count']),
    evidence: <Evidence>[for (final Object? item in listOf(row['evidence'])) ?parseEvidence(item)],
  );
}

/// An analysis run as the list and the header of its findings show it. Never the input hash or the request made at the gateway.
final class Run {
  const Run({
    required this.id,
    required this.proposalId,
    required this.packageCode,
    required this.contractorName,
    required this.status,
    required this.findingCount,
    required this.missingSourceCount,
    required this.reviewedCount,
    this.failureCode,
    this.createdAt,
    this.dataClassification,
  });

  final String id;
  final String proposalId;
  final String packageCode;
  final String contractorName;
  final String status;
  final int findingCount;
  final int missingSourceCount;
  final int reviewedCount;
  final String? failureCode;
  final String? createdAt;
  final String? dataClassification;
}

Run? parseRun(Object? raw) {
  final Json? row = asRecord(raw);
  final String? id = filled(row?['id']);
  final String? proposal = filled(row?['proposal_id']);
  final String? status = filled(row?['status']);
  if (row == null || id == null || proposal == null || status == null) return null;
  return Run(
    id: id,
    proposalId: proposal,
    packageCode: text(asRecord(row['package'])?['code']) ?? '',
    contractorName: text(asRecord(row['contractor'])?['legal_name']) ?? '',
    status: status,
    findingCount: count(row['finding_count']),
    missingSourceCount: count(row['missing_source_count']),
    reviewedCount: count(row['reviewed_count']),
    failureCode: filled(row['failure_code']),
    createdAt: filled(row['created_at']),
    dataClassification: filled(row['data_classification']),
  );
}

final class RunList {
  const RunList({required this.runs, required this.more, this.asOf});

  final List<Run> runs;
  final bool more;
  final String? asOf;
}

RunList? parseRunList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return RunList(runs: <Run>[for (final Object? item in listOf(body['items'])) ?parseRun(item)], more: filled(body['next_cursor']) != null, asOf: filled(body['as_of']));
}

/// The findings of one run, one card each.
final class FindingList {
  const FindingList({required this.run, required this.findings, required this.more, this.asOf});

  final Run run;
  final List<Finding> findings;

  /// The run has more findings than the pages that were read.
  final bool more;
  final String? asOf;
}

FindingList? parseFindingList(Object? raw) {
  final Json? body = asRecord(raw);
  final Run? run = parseRun(body?['run']);
  if (body == null || run == null || body['items'] is! List) return null;
  return FindingList(run: run, findings: <Finding>[for (final Object? item in listOf(body['items'])) ?parseFinding(item)], more: filled(body['next_cursor']) != null, asOf: filled(body['as_of']));
}

/// A passage the retrieval found in the files the person may read, with the place it was found.
final class Passage {
  const Passage({required this.documentVersionId, required this.pageIndex, required this.chunkNo, required this.text, this.classification});

  final String documentVersionId;
  final int pageIndex;
  final int chunkNo;
  final String text;
  final String? classification;

  String get key => '$documentVersionId:$pageIndex:$chunkNo';
}

Passage? parsePassage(Object? raw) {
  final Json? row = asRecord(raw);
  final String? doc = filled(row?['document_version_id']);
  final int? page = whole(row?['page_index']);
  final int? chunk = whole(row?['chunk_no']);
  final String? body = filled(row?['text']);
  if (row == null || doc == null || page == null || chunk == null || body == null) return null;
  return Passage(documentVersionId: doc, pageIndex: page, chunkNo: chunk, text: body, classification: filled(row['classification']));
}

List<Passage>? parsePassages(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  return <Passage>[for (final Object? item in listOf(body['items'])) ?parsePassage(item)];
}

/// A procurement package the person may ask about.
final class PackageChoice {
  const PackageChoice({required this.id, required this.code, required this.title, this.projectCode});

  final String id;
  final String code;
  final String title;
  final String? projectCode;
}

final class PackageList {
  const PackageList({required this.packages, required this.more, this.asOf});

  final List<PackageChoice> packages;
  final bool more;
  final String? asOf;
}

PackageList? parsePackageList(Object? raw) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  final List<PackageChoice> packages = <PackageChoice>[];
  for (final Object? item in listOf(body['items'])) {
    final Json? row = asRecord(item);
    final String? id = filled(row?['id']);
    if (row == null || id == null) continue;
    packages.add(PackageChoice(id: id, code: text(row['code']) ?? '', title: text(row['title']) ?? '', projectCode: filled(asRecord(row['project'])?['code'])));
  }
  return PackageList(packages: packages, more: filled(body['next_cursor']) != null, asOf: filled(body['as_of']));
}

/// One page of a proposal as the OCR read it (`listProposalOcrPages`), with the file it belongs to.
final class SourcePage {
  const SourcePage({required this.documentVersionId, required this.pageIndex, required this.reviewStatus, this.text, this.confidence, this.fileTitle, this.filePart});

  final String documentVersionId;
  final int pageIndex;

  /// `AUTO_ACCEPTED`, `NEEDS_REVIEW`, `CONFIRMED` or `CORRECTED`: a page that still waits for a person may be misread.
  final String reviewStatus;

  /// The text of the page that counts: the reviewer's correction for a corrected page, otherwise what the engine recognised and the
  /// server could read back against its digest; null when it cannot be read.
  final String? text;
  final String? confidence;
  final String? fileTitle;
  final String? filePart;

  bool get waitsForPerson => reviewStatus == 'NEEDS_REVIEW';
}

/// The page [pageIndex] of [documentVersionId] among the pages of one answer, or null when the answer does not hold it.
SourcePage? parseSourcePage(Object? raw, {required String documentVersionId, required int pageIndex}) {
  final Json? body = asRecord(raw);
  if (body == null || body['items'] is! List) return null;
  String? title;
  String? part;
  for (final Object? item in listOf(body['documents'])) {
    final Json? doc = asRecord(item);
    if (filled(doc?['document_version_id']) == documentVersionId) {
      title = filled(doc?['title']);
      part = filled(doc?['part']);
    }
  }
  for (final Object? item in listOf(body['items'])) {
    final Json? row = asRecord(item);
    if (row == null || filled(row['document_version_id']) != documentVersionId || whole(row['page_index']) != pageIndex) continue;
    final String? corrected = filled(row['corrected_text']);
    final String? recognised = row['text_state'] == 'READABLE' ? filled(row['text']) : null;
    return SourcePage(
      documentVersionId: documentVersionId,
      pageIndex: pageIndex,
      reviewStatus: text(row['review_status']) ?? 'NEEDS_REVIEW',
      text: corrected ?? recognised,
      confidence: filled(row['ocr_confidence']),
      fileTitle: title,
      filePart: part,
    );
  }
  return null;
}

/// Where the part of a page that was quoted starts and ends in the text of the page, white space ignored (a line break in the page is
/// a space in the quotation). Null when the words are not in this text: the screen then says so instead of marking something else.
({int start, int end})? locateQuote(String page, String quote) {
  final List<int> map = <int>[];
  final StringBuffer collapsed = StringBuffer();
  bool space = true;
  for (int i = 0; i < page.length; i += 1) {
    final String char = page[i];
    if (char.trim().isEmpty) {
      if (!space) {
        collapsed.write(' ');
        map.add(i);
        space = true;
      }
    } else {
      collapsed.write(char);
      map.add(i);
      space = false;
    }
  }
  final String needle = quote.trim().split(RegExp(r'\s+')).join(' ');
  if (needle.isEmpty) return null;
  final int at = collapsed.toString().indexOf(needle);
  if (at < 0) return null;
  return (start: map[at], end: map[at + needle.length - 1] + 1);
}

/// The first characters of an identifier, enough to tell two files apart on a small screen without showing a whole id.
String shortId(String id) => id.length <= 8 ? id : id.substring(0, 8);
