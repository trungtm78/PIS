import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:machvon_api_client/machvon_api_client.dart';

import '../../core/di/providers.dart';
import '../read_support/wire.dart';
import 'document_fetcher.dart';
import 'pdf_engine.dart';
import 'signing_models.dart';

/// Opens a stored version of a document as a PDF to read: the server gives a short-lived signed address
/// (`getDocumentVersionDownload`, needs a clean scan), the bytes are fetched from it into memory, checked to be a PDF whose SHA-256
/// is the one the server declared for the version, and handed to the renderer. Nothing is written to the phone.
final class PdfLoader {
  PdfLoader({required this.client, required this.fetcher, required this.engine, required this.apiBase, required this.allowInsecureLoopback});

  final MachvonApiClient client;
  final DocumentFetcher fetcher;
  final PdfEngine engine;
  final Uri apiBase;
  final bool allowInsecureLoopback;

  /// Throws [ApiError] when the server refuses the address, [DocumentFetchException] when the address or the bytes are not
  /// acceptable, and [PdfOpenException] when the renderer cannot read the file.
  Future<PdfDoc> load(FileVersion file) async {
    final Json? answer = asRecord(await client.getDocumentVersionDownload(id: file.id));
    final String? link = filled(answer?['url']);
    final String? declared = filled(answer?['checksum']);
    final Uri? address = link == null ? null : downloadAddress(apiBase, link, allowInsecureLoopback: allowInsecureLoopback);
    if (address == null) throw const DocumentFetchException(FetchFailure.refusedAddress);
    // The server declares the hash twice (on the version and on the download): both must be the hash of the bytes.
    if (declared != null && declared.toLowerCase() != file.checksum) throw const DocumentFetchException(FetchFailure.checksumMismatch);
    final Uint8List bytes = verifyDocument(await fetcher.fetch(address), expectedSha256: file.checksum);
    return engine.open(bytes);
  }
}

final Provider<PdfLoader> pdfLoaderProvider = Provider<PdfLoader>((Ref ref) {
  final config = ref.watch(appConfigProvider);
  return PdfLoader(
    client: ref.watch(apiClientProvider),
    fetcher: ref.watch(documentFetcherProvider),
    engine: ref.watch(pdfEngineProvider),
    apiBase: config.apiBaseUrl,
    allowInsecureLoopback: config.allowInsecureLoopback,
  );
});
