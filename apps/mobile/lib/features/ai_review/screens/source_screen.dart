import 'package:flutter/material.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/l10n/app_strings.dart';
import '../../../core/navigation/feature.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/typography.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../read_support/widgets.dart';
import '../../read_support/wire.dart';
import '../ai_models.dart';
import '../ai_read.dart';
import '../ai_support.dart';
import '../paged_lookup.dart';

/// MOB-39: the cited source. The cited page opens only after the server has judged the person's access again, in the same request that
/// reads it: the finding (or the proposal of the package) is read first, and a person whose access was taken away gets exactly the
/// answer of a record that does not exist, 404, and nothing of the page (AC-ST-MOB-030-3, UAT-PLAN-43). Nothing here is kept on the
/// device: the page is read again every time the screen opens.
///
/// A citation of a finding is `?run=<id>&finding=<id>&evidence=<id>`; a passage found by a question is `?package=<id>&doc=<id>&page=<n>`
/// (n from 0). Anything else names nothing and is shown as not found.
Widget buildSourceScreen(BuildContext context, ScreenContext screen) {
  final Map<String, String> query = screen.queryParameters;
  return AppScaffold(
    title: context.t('mob.ai.source.title'),
    body: FreshRead<SourceView>(
      resource: (query.keys.toList()..sort()).map((String key) => '$key=${query[key]}').join('&'),
      read: (MachvonApiClient client) => readSource(client, query),
      builder: (BuildContext context, SourceView view) => _Source(view: view),
    ),
  );
}

/// What the viewer shows: where the citation points, whether the server found the words there, and the page as it was read.
final class SourceView {
  const SourceView({required this.documentVersionId, required this.pageIndex, this.quote, this.verified, this.page, this.pageDenied = false});

  final String documentVersionId;
  final int pageIndex;
  final String? quote;

  /// The server's verdict on a citation of a finding; null for a passage of a question, which is a literal piece of the page.
  final bool? verified;
  final SourcePage? page;

  /// The finding opened but the person may not read the page text (403): the quotation is shown and the page is not.
  final bool pageDenied;
}

const ApiError _hidden = ApiError(status: 404, code: notFoundCode, correlationId: '');

/// Reads the source named by [query] under the permission of the moment. Throws the 404 of a record that is not the person's.
Future<SourceView> readSource(MachvonApiClient client, Map<String, String> query) async {
  final String? run = query['run'];
  final String? finding = query['finding'];
  final String? evidence = query['evidence'];
  if (run != null && finding != null && evidence != null) return _readFindingSource(client, run, finding, evidence);
  final String? package = query['package'];
  final String? doc = query['doc'];
  final int? page = int.tryParse(query['page'] ?? '');
  if (package != null && doc != null && page != null && page >= 0) return _readPassageSource(client, package, doc, page);
  throw _hidden;
}

/// The cited page of one file, looked for in every page of the proposal's records until it is found: a long file has more records than
/// one screen reads, and a page beyond the first ones is still the page that was cited. The file's title comes with the page that
/// names it, which may be an earlier one.
Future<SourcePage?> _pageOf(MachvonApiClient client, String proposalId, String documentVersionId, int pageIndex) {
  final List<Object?> documents = <Object?>[];
  return findInPages<SourcePage>(
    client,
    'listProposalOcrPages',
    path: <String, Object?>{'id': proposalId},
    query: <String, Object?>{'document_version_id': documentVersionId, 'limit': 200},
    pick: (Json body) {
      documents.addAll(listOf(body['documents']));
      return parseSourcePage(<String, Object?>{...body, 'documents': documents}, documentVersionId: documentVersionId, pageIndex: pageIndex);
    },
  );
}

Future<SourceView> _readFindingSource(MachvonApiClient client, String run, String finding, String evidence) async {
  // The finding is looked for in every page of the run's findings: one beyond the first pages exists all the same.
  final ({FindingList list, Finding finding})? located = await findInPages<({FindingList list, Finding finding})>(
    client,
    'listAnalysisFindings',
    path: <String, Object?>{'id': run},
    query: <String, Object?>{'limit': 50},
    pick: (Json body) {
      final FindingList? list = parseFindingList(body);
      if (list == null) throw const ContractMismatch('response', 'does not hold what the screen needs');
      for (final Finding candidate in list.findings) {
        if (candidate.id == finding) return (list: list, finding: candidate);
      }
      return null;
    },
  );
  if (located == null) throw _hidden;
  final FindingList list = located.list;
  Evidence? cited;
  for (final Evidence candidate in located.finding.evidence) {
    if (candidate.id == evidence) cited = candidate;
  }
  if (cited == null || !cited.hasSource) throw _hidden;
  final String doc = cited.documentVersionId!;
  final int pageIndex = cited.pageIndex!;
  try {
    final SourcePage? page = await _pageOf(client, list.run.proposalId, doc, pageIndex);
    return SourceView(documentVersionId: doc, pageIndex: pageIndex, quote: cited.quote, verified: cited.verified, page: page);
  } on ApiError catch (error) {
    if (error.status != 403) rethrow;
    return SourceView(documentVersionId: doc, pageIndex: pageIndex, quote: cited.quote, verified: cited.verified, pageDenied: true);
  }
}

Future<SourceView> _readPassageSource(MachvonApiClient client, String package, String doc, int pageIndex) async {
  // Every page of the package's proposals is walked until one holds the page: the passage was found among all the proposals the person
  // may read, not among the first ones.
  final SourceView? view = await findInPages<SourceView>(
    client,
    'get_resources_proposal',
    query: <String, Object?>{'package_id': package, 'limit': 50},
    pick: (Json body) async {
      for (final Object? item in listOf(body['items'])) {
        final Json? row = asRecord(item);
        final String? id = filled(row?['id']);
        if (id == null || row?['access'] != 'FULL' || row?['locked'] == true) continue;
        try {
          final SourcePage? page = await _pageOf(client, id, doc, pageIndex);
          if (page != null) return SourceView(documentVersionId: doc, pageIndex: pageIndex, page: page);
        } on ApiError catch (error) {
          // A proposal this person may not open holds no page for them; the next one may.
          if (error.status != 403 && error.status != 404) rethrow;
        }
      }
      return null;
    },
  );
  if (view == null) throw _hidden;
  return view;
}

class _Source extends StatelessWidget {
  const _Source({required this.view});

  final SourceView view;

  @override
  Widget build(BuildContext context) {
    final MachvonV2Text text = context.v2text;
    final SourcePage? page = view.page;
    final String? title = page?.fileTitle;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        SectionCard(
          title: context.t('mob.ai.source.where.title'),
          children: <Widget>[
            FactLine(label: context.t('mob.ai.source.file'), value: title ?? context.t('mob.ai.source.file.id', <String, Object>{'id': shortId(view.documentVersionId)})),
            FactLine(label: context.t('mob.ai.source.page'), value: '${view.pageIndex + 1}'),
            if (view.verified != null) FactLine(label: context.t('mob.ai.source.check'), value: view.verified! ? context.t('mob.ai.evidence.verified') : context.t('mob.ai.evidence.notFound')),
            if (page != null) FactLine(label: context.t('mob.ai.source.ocr'), value: reviewStatusLabel(context, page.reviewStatus)),
            if (page != null && page.waitsForPerson) Text(context.t('mob.ai.source.ocr.waiting'), style: text.body),
          ],
        ),
        if (view.quote != null)
          SectionCard(
            title: context.t('mob.ai.source.quote.title'),
            children: <Widget>[Text('“${view.quote}”', style: text.bodyStrong)],
          ),
        SectionCard(
          title: context.t('mob.ai.source.text.title'),
          children: <Widget>[
            if (view.pageDenied) Text(context.t('mob.ai.source.text.denied'), style: text.body),
            if (!view.pageDenied && (page == null || page.text == null)) Text(context.t('mob.ai.source.text.unreadable'), style: text.body),
            if (page?.text != null) _PageText(text: page!.text!, quote: view.quote),
            const SizedBox(height: MachvonV2Space.s8),
            Text(context.t('mob.ai.source.text.note'), style: text.caption),
          ],
        ),
      ],
    );
  }
}

/// The text of the page with the cited words marked where they stand. The marking is a convenience for reading: whether the words are on
/// the page is the server's verdict, shown above, and a quotation the text does not hold in these words is not marked at all.
class _PageText extends StatelessWidget {
  const _PageText({required this.text, required this.quote});

  final String text;
  final String? quote;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    final MachvonV2Text style = context.v2text;
    final ({int start, int end})? at = quote == null ? null : locateQuote(text, quote!);
    final TextStyle base = style.body;
    if (at == null) return Text(text, style: base);
    return Text.rich(
      TextSpan(
        style: base,
        children: <InlineSpan>[
          TextSpan(text: text.substring(0, at.start)),
          TextSpan(text: text.substring(at.start, at.end), style: style.bodyStrong.copyWith(backgroundColor: v2.palette.primarySoft, color: v2.palette.ink)),
          TextSpan(text: text.substring(at.end)),
        ],
      ),
    );
  }
}
