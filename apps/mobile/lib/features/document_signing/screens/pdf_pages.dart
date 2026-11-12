import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';
import 'package:machvon_tokens/machvon_tokens.dart';

import '../../../core/format/format.dart';
import '../../../core/l10n/app_strings.dart';
import '../../../core/security/secure_screen.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/app_scaffold.dart';
import '../../../core/widgets/state_view.dart';
import '../document_fetcher.dart';
import '../pdf_engine.dart';
import '../pdf_loading.dart';
import '../signing_models.dart';
import '../signing_support.dart';
import 'signing_notice.dart';

/// The width a page is drawn at for reading: the width of the screen in device pixels, within what a phone can hold in memory.
int _readingWidth(BuildContext context) {
  final MediaQueryData media = MediaQuery.of(context);
  return (media.size.width * media.devicePixelRatio).round().clamp(320, 1400);
}

/// A document opened for reading: loading, the pages, or why it could not be opened (with a retry). The document is closed with
/// the screen; the bytes were only ever in memory.
mixin _OpensPdf<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  final Map<String, PdfDoc> _open = <String, PdfDoc>{};
  Object? failure;
  bool loading = true;

  /// Opens each version of [files], by id; when all are open [opened] runs.
  Future<void> openAll(List<FileVersion> files, Future<void> Function() opened) async {
    setState(() {
      loading = true;
      failure = null;
    });
    try {
      for (final FileVersion file in files) {
        if (_open.containsKey(file.id)) continue;
        final PdfDoc doc = await ref.read(pdfLoaderProvider).load(file);
        if (!mounted) {
          // The screen was left while the file was being opened: [closeAll] has already run, so nobody would ever close this one.
          doc.close().ignore();
          return;
        }
        _open[file.id] = doc;
      }
      await opened();
      if (mounted) setState(() => loading = false);
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          failure = error;
          loading = false;
        });
      }
    }
  }

  PdfDoc docOf(FileVersion file) => _open[file.id]!;

  void closeAll() {
    for (final PdfDoc doc in _open.values) {
      doc.close().ignore();
    }
    _open.clear();
  }
}

/// Why a file could not be opened, with the action that follows: a lost connection is the offline state, anything else the error state, and
/// both end in "try again".
class _FailureView extends StatelessWidget {
  const _FailureView({required this.failure, required this.onRetry});

  final Object failure;
  final VoidCallback onRetry;

  bool get _unreachable =>
      (failure is DocumentFetchException && (failure as DocumentFetchException).failure == FetchFailure.unreachable) || (failure is ApiError && (failure as ApiError).code == networkErrorCode);

  @override
  Widget build(BuildContext context) {
    return StateView(
      kind: _unreachable ? StateKind.offline : StateKind.error,
      title: _unreachable ? context.t('mob.signing.viewer.offline.title') : context.t('mob.signing.viewer.failed.title'),
      body: viewerFailureText(context, failure),
      actionLabel: context.t('mob.signing.viewer.retry.action'),
      onAction: onRetry,
    );
  }
}

class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Semantics(liveRegion: true, label: context.t('mob.signing.viewer.loading.label'), child: const CircularProgressIndicator()),
    );
  }
}

/// The final PDF of a document, page by page. A tap on a page opens it large, to pinch and move.
class PdfViewerPage extends ConsumerStatefulWidget {
  const PdfViewerPage({required this.file, required this.title, super.key});

  final FileVersion file;
  final String title;

  @override
  ConsumerState<PdfViewerPage> createState() => _PdfViewerPageState();
}

class _PdfViewerPageState extends ConsumerState<PdfViewerPage> with _OpensPdf<PdfViewerPage> {
  final Map<int, Future<RenderedPage>> _pages = <int, Future<RenderedPage>>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() => openAll(<FileVersion>[widget.file], () async {});

  @override
  void dispose() {
    closeAll();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Object? problem = failure;
    return AppScaffold(
      title: context.t('mob.signing.viewer.title'),
      body: loading
          ? const _LoadingView()
          : problem != null
              ? _FailureView(failure: problem, onRetry: _load)
              : _pagesView(context),
    );
  }

  Widget _pagesView(BuildContext context) {
    final PdfDoc doc = docOf(widget.file);
    final int width = _readingWidth(context);
    return ListView.builder(
      itemCount: doc.pageCount + 1,
      itemBuilder: (BuildContext context, int index) {
        if (index == 0) {
          return Padding(
            padding: const EdgeInsets.all(MachvonV2Space.s16),
            child: Text(context.t('mob.signing.viewer.summary', <String, Object>{'title': widget.title, 'version': widget.file.version, 'pages': doc.pageCount}), style: context.v2text.heading),
          );
        }
        final int page = index - 1;
        return _PageTile(
          label: context.t('mob.signing.viewer.page', <String, Object>{'page': page + 1, 'pages': doc.pageCount}),
          render: _pages.putIfAbsent(page, () => doc.render(page, width: width)),
          zoom: () => Navigator.of(context).push(secureRoute<void>((_) => ZoomPage(label: context.t('mob.signing.viewer.page', <String, Object>{'page': page + 1, 'pages': doc.pageCount}), doc: doc, index: page))),
        );
      },
    );
  }
}

class _PageTile extends StatelessWidget {
  const _PageTile({required this.label, required this.render, required this.zoom});

  final String label;
  final Future<RenderedPage> render;
  final VoidCallback zoom;

  @override
  Widget build(BuildContext context) {
    final MachvonV2 v2 = context.v2;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: MachvonV2Space.s16, vertical: MachvonV2Space.s8),
      child: FutureBuilder<RenderedPage>(
        future: render,
        builder: (BuildContext context, AsyncSnapshot<RenderedPage> snapshot) {
          final RenderedPage? page = snapshot.data;
          if (snapshot.hasError) return Text(context.t('mob.signing.viewer.pageFailed', <String, Object>{'label': label}), style: context.v2text.body.copyWith(color: v2.palette.lateFg));
          if (page == null) return AspectRatio(aspectRatio: 0.707, child: Center(child: Semantics(label: label, child: const CircularProgressIndicator())));
          return Semantics(
            button: true,
            label: context.t('mob.signing.viewer.page.open', <String, Object>{'label': label}),
            excludeSemantics: true,
            child: Material(
              color: v2.palette.surface,
              clipBehavior: Clip.hardEdge,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(MachvonV2Radius.chip), side: BorderSide(color: v2.palette.lineStrong)),
              child: InkWell(
                onTap: zoom,
                // The shape of the page is known before the image is decoded, so the list does not jump while the pages arrive.
                child: AspectRatio(aspectRatio: page.width / page.height, child: Image.memory(page.png, fit: BoxFit.fill, gaplessPlayback: true)),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// One page large, to pinch and move.
class ZoomPage extends StatelessWidget {
  const ZoomPage({required this.label, required this.doc, required this.index, super.key});

  final String label;
  final PdfDoc doc;
  final int index;

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: label,
      body: FutureBuilder<RenderedPage>(
        future: doc.render(index, width: _readingWidth(context) * 2),
        builder: (BuildContext context, AsyncSnapshot<RenderedPage> snapshot) {
          final RenderedPage? page = snapshot.data;
          if (snapshot.hasError) return Center(child: Text(context.t('mob.signing.viewer.pageFailed', <String, Object>{'label': label}), style: context.v2text.body));
          if (page == null) return const _LoadingView();
          return InteractiveViewer(minScale: 1, maxScale: 6, child: Center(child: Semantics(label: label, image: true, child: Image.memory(page.png, fit: BoxFit.contain))));
        },
      ),
    );
  }
}

/// The current version of a document against the one before it: what the two files are, and page by page whether they differ.
class PdfComparePage extends ConsumerStatefulWidget {
  const PdfComparePage({required this.previous, required this.current, super.key});

  final FileVersion previous;
  final FileVersion current;

  @override
  ConsumerState<PdfComparePage> createState() => _PdfComparePageState();
}

class _PdfComparePageState extends ConsumerState<PdfComparePage> with _OpensPdf<PdfComparePage> {
  VersionComparison? _comparison;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() => openAll(<FileVersion>[widget.previous, widget.current], () async {
        _comparison = await compareDocuments(docOf(widget.previous), docOf(widget.current));
      });

  @override
  void dispose() {
    closeAll();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Object? problem = failure;
    final VersionComparison? comparison = _comparison;
    return AppScaffold(
      title: context.t('mob.signing.compare.title'),
      body: loading
          ? const _LoadingView()
          : problem != null || comparison == null
              ? _FailureView(failure: problem ?? const PdfOpenException(), onRetry: _load)
              : _comparisonView(context, comparison),
    );
  }

  Widget _comparisonView(BuildContext context, VersionComparison comparison) {
    final MachvonV2Text text = context.v2text;
    final bool sameFile = widget.previous.checksum == widget.current.checksum;
    return ListView(
      padding: const EdgeInsets.only(bottom: MachvonV2Space.s24),
      children: <Widget>[
        SigningSection(
          title: context.t('mob.signing.compare.versions.title'),
          padded: true,
          children: <Widget>[
            _versionLine(context, context.t('mob.signing.compare.previous'), widget.previous),
            _versionLine(context, context.t('mob.signing.compare.current'), widget.current),
            Padding(
              padding: const EdgeInsets.only(top: MachvonV2Space.s8),
              child: Text(sameFile ? context.t('mob.signing.compare.sameFile') : context.t('mob.signing.compare.otherFile'), style: text.bodyStrong),
            ),
          ],
        ),
        SigningSection(
          title: context.t('mob.signing.compare.pages.title'),
          padded: true,
          children: <Widget>[
            Text(
              comparison.identical
                  ? context.t('mob.signing.compare.summary.identical', <String, Object>{'pages': comparison.pages.length})
                  : context.t('mob.signing.compare.summary.changed', <String, Object>{'changed': comparison.changedPages, 'pages': comparison.pages.length}),
              style: text.body,
            ),
            for (final PageComparison page in comparison.pages) _comparedPage(context, page),
          ],
        ),
      ],
    );
  }

  Widget _versionLine(BuildContext context, String label, FileVersion file) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s4),
      child: MergeSemantics(
        child: Text(
          context.t('mob.signing.compare.version', <String, Object>{
            'label': label,
            'version': file.version,
            'stage': stageLabel(context, file.stage),
            'pages': file.pageCount,
            'time': file.createdAt == null ? '' : formatMoment(file.createdAt!),
            'hash': file.checksum.substring(0, math.min(12, file.checksum.length)),
          }),
          style: context.v2text.body,
        ),
      ),
    );
  }

  Widget _comparedPage(BuildContext context, PageComparison page) {
    final int number = page.index + 1;
    final String change = changeLabel(context, page.change);
    final bool inPrevious = page.change != PageChange.added;
    final bool inCurrent = page.change != PageChange.removed;
    final MachvonV2Palette p = context.v2.palette;
    void zoom(FileVersion file, String label) => Navigator.of(context).push(
          secureRoute<void>((_) => ZoomPage(label: context.t('mob.signing.compare.page.zoom', <String, Object>{'page': number, 'which': label}), doc: docOf(file), index: page.index)),
        );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: MachvonV2Space.s8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          MergeSemantics(
            child: Text(
              context.t('mob.signing.compare.page', <String, Object>{'page': number, 'change': change}),
              style: page.change == PageChange.same ? context.v2text.body : context.v2text.bodyStrong.copyWith(color: p.soonFg),
            ),
          ),
          const SizedBox(height: MachvonV2Space.s8),
          Wrap(
            spacing: MachvonV2Space.s8,
            runSpacing: MachvonV2Space.s8,
            children: <Widget>[
              if (inPrevious) OutlinedButton(onPressed: () => zoom(widget.previous, context.t('mob.signing.compare.previous')), child: Text(context.t('mob.signing.compare.openPrevious.action', <String, Object>{'page': number}))),
              if (inCurrent) OutlinedButton(onPressed: () => zoom(widget.current, context.t('mob.signing.compare.current')), child: Text(context.t('mob.signing.compare.openCurrent.action', <String, Object>{'page': number}))),
            ],
          ),
        ],
      ),
    );
  }
}
