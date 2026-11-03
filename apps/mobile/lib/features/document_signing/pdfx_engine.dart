import 'dart:async';
import 'dart:typed_data';

import 'package:pdfx/pdfx.dart' as pdfx;

import 'pdf_engine.dart';

/// The only file that uses the `pdfx` package. `pdfx` draws a page with the renderer of the system (PdfRenderer on Android, PDFKit
/// on iOS), so the phone needs no PDF engine of its own, nothing is downloaded at build time and the app does not grow by a rendering
/// library; its channel to the platform is what a test cannot reach on the host, which is why everything else speaks to [PdfEngine].
/// Whether it draws a real signed PDF on both systems is proved on a device.
final class PdfxEngine implements PdfEngine {
  const PdfxEngine();

  @override
  Future<PdfDoc> open(Uint8List bytes) async {
    try {
      return _PdfxDoc(await pdfx.PdfDocument.openData(bytes));
    } on Object {
      throw const PdfOpenException();
    }
  }
}

final class _PdfxDoc implements PdfDoc {
  _PdfxDoc(this._document);

  final pdfx.PdfDocument _document;

  /// The system renderer draws one page at a time (a page must be closed before the next is opened), so renders wait for each other.
  Future<void> _queue = Future<void>.value();

  @override
  int get pageCount => _document.pagesCount;

  @override
  Future<RenderedPage> render(int index, {required int width}) {
    final Completer<RenderedPage> done = Completer<RenderedPage>();
    _queue = _queue.then((_) async {
      try {
        done.complete(await _draw(index, width));
      } on Object catch (error, stack) {
        done.completeError(error, stack);
      }
    });
    return done.future;
  }

  Future<RenderedPage> _draw(int index, int width) async {
    final pdfx.PdfPage page = await _document.getPage(index + 1);
    try {
      final double height = width * page.height / page.width;
      final pdfx.PdfPageImage? image = await page.render(width: width.toDouble(), height: height, format: pdfx.PdfPageImageFormat.png, backgroundColor: '#FFFFFF');
      if (image == null) throw const PdfOpenException();
      return RenderedPage(png: image.bytes, width: image.width ?? width, height: image.height ?? height.round());
    } finally {
      await page.close();
    }
  }

  @override
  Future<void> close() async {
    await _queue;
    await _document.close();
  }
}
