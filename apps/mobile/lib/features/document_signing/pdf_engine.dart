import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image/image.dart' as img;

import 'pdfx_engine.dart';

/// One page drawn as a PNG image.
final class RenderedPage {
  const RenderedPage({required this.png, required this.width, required this.height});

  final Uint8List png;
  final int width;
  final int height;
}

/// An open PDF. The phone shows a document as the page images a renderer draws from its bytes; nothing of the PDF is executed or
/// stored.
abstract interface class PdfDoc {
  int get pageCount;

  /// Draws page [index] (from 0) [width] pixels wide, white background.
  Future<RenderedPage> render(int index, {required int width});

  Future<void> close();
}

/// The PDF renderer behind a port. The package that draws pages (`pdfx`: the system renderer, PdfRenderer on Android and PDFKit on
/// iOS) is used in one file, `pdfx_engine.dart`; everything else, the viewer, the comparison and the tests, speaks to this port, so a
/// test runs on the host with a renderer that returns images and no platform plugin.
abstract interface class PdfEngine {
  /// Opens the bytes as a PDF; throws [PdfOpenException] when they are not one the renderer can read.
  Future<PdfDoc> open(Uint8List bytes);
}

class PdfOpenException implements Exception {
  const PdfOpenException();

  @override
  String toString() => 'PdfOpenException';
}

final Provider<PdfEngine> pdfEngineProvider = Provider<PdfEngine>((Ref ref) => const PdfxEngine());

// ---- comparing two versions ----------------------------------------------------------------------------------------------------

enum PageChange { same, changed, added, removed }

/// What became of one page between the previous version and the current one.
final class PageComparison {
  const PageComparison({required this.index, required this.change, this.differing = 0});

  /// From 0.
  final int index;
  final PageChange change;

  /// The share of the pixels that differ, 0 to 1, for a page that is in both versions.
  final double differing;
}

/// The comparison of two versions of a document, page by page.
final class VersionComparison {
  const VersionComparison(this.pages);

  final List<PageComparison> pages;

  int get changedPages => pages.where((PageComparison page) => page.change != PageChange.same).length;

  bool get identical => changedPages == 0;
}

/// The width the pages are drawn at for the comparison: small, because only whether they differ matters, not how they look.
const int comparisonWidth = 240;

/// A channel may differ by this much (of 255) before the pixels count as different: anti-aliasing noise is not a change.
const int channelTolerance = 24;

/// The share of the pixels of a page that may differ before the page counts as changed.
const double pageTolerance = 0.002;

/// Compares [previous] and [current] page by page: a page that only one of them has is added or removed, a page in both is drawn
/// at the same width and compared pixel by pixel. The result says where to look; reading the pages stays the leader's act.
Future<VersionComparison> compareDocuments(PdfDoc previous, PdfDoc current, {int width = comparisonWidth}) async {
  final int pages = previous.pageCount > current.pageCount ? previous.pageCount : current.pageCount;
  final List<PageComparison> result = <PageComparison>[];
  for (int index = 0; index < pages; index += 1) {
    if (index >= previous.pageCount) {
      result.add(PageComparison(index: index, change: PageChange.added));
    } else if (index >= current.pageCount) {
      result.add(PageComparison(index: index, change: PageChange.removed));
    } else {
      final double share = pixelDifference((await previous.render(index, width: width)).png, (await current.render(index, width: width)).png);
      result.add(PageComparison(index: index, change: share > pageTolerance ? PageChange.changed : PageChange.same, differing: share));
    }
  }
  return VersionComparison(result);
}

/// The share (0 to 1) of the pixels that differ between two PNG images; 1 when they cannot be compared (not images, other sizes).
double pixelDifference(Uint8List first, Uint8List second) {
  final img.Image? a = img.decodePng(first);
  final img.Image? b = img.decodePng(second);
  if (a == null || b == null || a.width != b.width || a.height != b.height) return 1;
  final Uint8List left = a.getBytes(order: img.ChannelOrder.rgb);
  final Uint8List right = b.getBytes(order: img.ChannelOrder.rgb);
  int differing = 0;
  final int pixels = a.width * a.height;
  for (int pixel = 0; pixel < pixels; pixel += 1) {
    final int at = pixel * 3;
    if ((left[at] - right[at]).abs() > channelTolerance || (left[at + 1] - right[at + 1]).abs() > channelTolerance || (left[at + 2] - right[at + 2]).abs() > channelTolerance) {
      differing += 1;
    }
  }
  return differing / pixels;
}
