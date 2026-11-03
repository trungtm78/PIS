import '../acceptance_handover/fixtures.dart' show page;
import '../support/scripted_server.dart';

export '../acceptance_handover/fixtures.dart' show page, problem;

const String kPackage = 'pk-1';
const String kProposal = 'prop-1';
const String kRun = 'run-1';
const String kDoc = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const String kDoc2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/// The words of the page the finding cites; the quotation is in them with a line break where the citation has a space.
const String kPageText = 'Nhà thầu đã thực hiện hợp đồng tương tự\ntại tỉnh B trong năm 2024 với giá trị 12 tỷ đồng.\nHết trang.';
const String kQuote = 'thực hiện hợp đồng tương tự tại tỉnh B';

Map<String, Object?> evidence(String id, {int? page = 11, String? doc = kDoc, bool verified = true, String? quote = kQuote, String kind = 'DOCUMENT', Map<String, Object?>? calc}) => <String, Object?>{
      'id': id,
      'kind': kind,
      'document_version_id': doc,
      'page_index': page,
      'quote_excerpt': quote,
      'calc_ref': calc,
      'verified_present': verified,
    };

Map<String, Object?> finding(
  String id, {
  String criterion = 'C-EXP-01',
  String status = 'SUPPORTED',
  String text = 'Nhà thầu có kinh nghiệm thực hiện hợp đồng tương tự.',
  String confidence = 'HEURISTIC',
  bool missingSource = false,
  String? finalStatus,
  List<Map<String, Object?>>? evidence_,
}) {
  final List<Map<String, Object?>> cited = evidence_ ?? <Map<String, Object?>>[evidence('ev-$id')];
  return <String, Object?>{
    'id': id,
    'run_id': kRun,
    'criterion_id': criterion,
    'status': status,
    'finding': text,
    'confidence_type': confidence,
    'evidence_count': cited.where((Map<String, Object?> e) => e['verified_present'] == true).length,
    'missing_source': missingSource,
    'final_status': finalStatus,
    'final_score': null,
    'reviewed_at': finalStatus == null ? null : '2026-11-02T08:00:00Z',
    'review_count': finalStatus == null ? 0 : 1,
    'version': 1,
    'created_at': '2026-11-02T07:00:00Z',
    'evidence': cited,
    'reviews': <Object?>[],
  };
}

Map<String, Object?> run({String status = 'AWAITING_REVIEW', String? failure, int findings = 2, int reviewed = 0}) => <String, Object?>{
      'id': kRun,
      'proposal_id': kProposal,
      'package': <String, Object?>{'id': kPackage, 'code': 'GT-2026-07'},
      'contractor': <String, Object?>{'id': 'c-1', 'legal_name': 'Công ty Xây dựng Sông Hồng'},
      'criteria_version_id': 'cv-1',
      'profile_version_id': 'pv-1',
      'status': status,
      'data_classification': 'CONFIDENTIAL',
      'route_class': 'SELF_HOSTED',
      'failure_code': failure,
      'finding_count': findings,
      'missing_source_count': 0,
      'reviewed_count': reviewed,
      'created_at': '2026-11-02T07:00:00Z',
      'version': 3,
    };

Map<String, Object?> findingsOf(List<Map<String, Object?>> items, {Map<String, Object?>? run_}) => <String, Object?>{'run': run_ ?? run(findings: items.length), 'items': items, 'next_cursor': null, 'as_of': '2026-11-03T02:00:00Z'};

Map<String, Object?> ocrPage(String doc, int index, String? text, {String reviewStatus = 'AUTO_ACCEPTED', String textState = 'READABLE', String? corrected}) => <String, Object?>{
      'id': 'pg-$index',
      'document_version_id': doc,
      'page_index': index,
      'ocr_confidence': '0.9120',
      'review_status': reviewStatus,
      'table_mismatch': false,
      'text': text,
      'text_state': textState,
      'corrected_text': corrected,
    };

Map<String, Object?> ocrPages(List<Map<String, Object?>> items) => <String, Object?>{
      'items': items,
      'next_cursor': null,
      'as_of': '2026-11-03T02:00:00Z',
      'financial_ready': true,
      'blocked_pages': 0,
      'threshold': '0.8500',
      'documents': <Object?>[
        <String, Object?>{'document_version_id': kDoc, 'title': 'Hồ sơ năng lực', 'part': 'TECHNICAL', 'page_count': 30},
      ],
    };

Map<String, Object?> passage(String doc, int pageIndex, int chunk, String text) => <String, Object?>{
      'document_version_id': doc,
      'page_index': pageIndex,
      'chunk_no': chunk,
      'classification': 'CONFIDENTIAL',
      'distance': 0.12,
      'text': text,
    };

Map<String, Object?> models({bool embedding = true, String status = 'APPROVED'}) => <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'id': 'm-old', 'status': 'APPROVED', 'capabilities': <String, Object?>{'embedding': true}, 'created_at': '2026-01-01T00:00:00Z'},
        <String, Object?>{'id': 'm-1', 'status': status, 'capabilities': <String, Object?>{'embedding': embedding}, 'created_at': '2026-06-01T00:00:00Z'},
        <String, Object?>{'id': 'm-chat', 'status': 'APPROVED', 'capabilities': <String, Object?>{'embedding': false}, 'created_at': '2026-09-01T00:00:00Z'},
      ],
      'next_cursor': null,
      'as_of': '2026-11-03T02:00:00Z',
    };

Map<String, Object?> proposals({String access = 'FULL', bool locked = false}) => page(<Object?>[
      <String, Object?>{'id': kProposal, 'access': access, 'locked': locked},
    ]);

Map<String, Object?> packages() => page(<Object?>[
      <String, Object?>{'id': kPackage, 'code': 'GT-2026-07', 'title': 'Xây dựng cầu Nam Sông', 'project': <String, Object?>{'id': 'p-1', 'code': 'DA-01'}},
    ]);

/// A server where everything the AI screens read is in place.
void aiServer(ScriptedServer server, {List<Map<String, Object?>>? passages}) {
  server
    ..on('GET', '/ai-models', (_) => models())
    ..on('GET', '/procurement-packages/:id/proposal-passages', (_) => <String, Object?>{'items': passages ?? <Object?>[passage(kDoc, 11, 0, 'Nhà thầu đã thực hiện hợp đồng tương tự tại tỉnh B.')], 'as_of': '2026-11-03T02:00:00Z'})
    ..on('GET', '/resources/procurement_package', (_) => packages())
    ..on('GET', '/resources/analysis_run', (_) => page(<Object?>[run()]))
    ..on('GET', '/analysis-runs/:id/findings', (_) => findingsOf(<Map<String, Object?>>[finding('f-1'), finding('f-2', criterion: 'C-FIN-02', status: 'NEEDS_REVIEW', missingSource: true, evidence_: <Map<String, Object?>>[evidence('ev-x', verified: false)])]))
    ..on('GET', '/proposals/:id/ocr-pages', (_) => ocrPages(<Map<String, Object?>>[ocrPage(kDoc, 11, kPageText)]))
    ..on('GET', '/resources/proposal', (_) => proposals());
}
