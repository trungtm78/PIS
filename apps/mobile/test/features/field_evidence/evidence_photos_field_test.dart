import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/features/field_evidence/device_sources.dart';
import 'package:machvon_mobile/features/field_evidence/evidence_photos.dart';
import 'package:machvon_mobile/features/field_evidence/evidence_photos_field.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';
import 'package:machvon_mobile/features/field_evidence/jpeg_metadata.dart';

import '../../support/widget_host.dart';
import 'exif_fixtures.dart';

class _Source implements PhotoSource {
  _Source(this.file);

  final File file;
  final Completer<void> discarded = Completer<void>();

  @override
  Future<File?> takePhoto() async => file;

  @override
  Future<File?> pickPhoto() async => file;

  @override
  Future<void> discard(File picked) async {
    if (!discarded.isCompleted) discarded.complete();
  }
}

/// The screen around the field: it holds the consent and the list, as the real screens do, and can take the consent back or
/// drop the field while a photograph is being prepared.
class _Host extends StatefulWidget {
  const _Host({required this.onState});

  final void Function(_HostState state) onState;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  bool consent = true;
  bool shown = true;
  List<EvidencePhoto> photos = const <EvidencePhoto>[];

  @override
  void initState() {
    super.initState();
    widget.onState(this);
  }

  void withdraw() => setState(() => consent = false);

  void leave() => setState(() => shown = false);

  @override
  Widget build(BuildContext context) => shown
      ? EvidencePhotosField(
          photos: photos,
          keepPlaceAndTime: consent,
          onChanged: (List<EvidencePhoto> next) => setState(() => photos = next),
        )
      : const SizedBox();
}

/// Real time passes (files are read and written, an isolate runs) until the picker's copy is discarded, which is the last thing the
/// field does with a photograph; the screen is pumped as it goes.
Future<void> _untilDiscarded(WidgetTester tester, _Source source) async {
  for (int i = 0; i < 600 && !source.discarded.isCompleted; i += 1) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(source.discarded.isCompleted, isTrue, reason: 'the photograph was handled');
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
  await tester.pump();
}

/// Wider than the uploader takes, so the photograph is scaled down and the original is kept beside it.
Uint8List _wideGeotaggedJpeg() => withBlocks(plainJpeg(width: 2400, height: 16), <Uint8List>[
      exifSegment(orientation: 1, takenAt: '2026:11:03 08:15:00', gps: true),
    ]);

/// Windows keeps a file busy for a moment after the isolate that read it has gone: the folder is removed once it lets go.
Future<void> _remove(Directory folder) async {
  for (int attempt = 0; attempt < 20; attempt += 1) {
    try {
      folder.deleteSync(recursive: true);
      return;
    } on FileSystemException {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }
  folder.deleteSync(recursive: true);
}

void main() {
  group('AC-ST-MOB-014-2 UAT-AC367 BR-MOB-06 the consent is read again when the photograph is ready', () {
    Future<({_HostState host, Directory folder, _Source source})> pumpField(WidgetTester tester, void Function(_HostState host) duringPreparation) async {
      final Directory folder = Directory.systemTemp.createTempSync('machvon-field-');
      addTearDown(() => tester.runAsync(() => _remove(folder)));
      final Directory evidence = Directory('${folder.path}/evidence')..createSync();
      final _Source source = _Source(File('${folder.path}/picked.jpg')..writeAsBytesSync(_wideGeotaggedJpeg()));
      late _HostState host;
      await tester.pumpWidget(
        ProviderScope(
          overrides: <Override>[
            photoSourceProvider.overrideWithValue(source),
            // The directory is asked for while the photograph is prepared: the person acts there.
            evidenceDirectoryProvider.overrideWith((Ref ref) async {
              duringPreparation(host);
              return evidence;
            }),
          ],
          child: hostWidget(_Host(onState: (_HostState state) => host = state), tables: <StringTable>[fieldEvidenceStrings]),
        ),
      );
      return (host: host, folder: evidence, source: source);
    }

    testWidgets('a photograph prepared while the consent held loses its place and time, and so does its original, when the consent is withdrawn meanwhile', (WidgetTester tester) async {
      late _HostState host;
      final ({_HostState host, Directory folder, _Source source}) world = await pumpField(tester, (_) => host.withdraw());
      host = world.host;

      await tester.tap(find.byType(OutlinedButton));
      await _untilDiscarded(tester, world.source);

      expect(host.consent, isFalse);
      expect(host.photos, hasLength(1));
      final EvidencePhoto photo = host.photos.single;
      expect(photo.originalPath, isNotNull, reason: 'the retention policy keeps the original beside it');
      for (final String path in <String>[photo.path, photo.originalPath!]) {
        final Uint8List bytes = File(path).readAsBytesSync();
        expect(readJpegMetadata(bytes).carriesPlaceOrTime, isFalse, reason: path);
        expect(String.fromCharCodes(bytes).contains('Exif'), isFalse, reason: path);
      }
      expect(photo.keepsPlaceOrTime || photo.keptGps || photo.keptTime, isFalse);
      expect(photo.bytes, File(photo.path).lengthSync());
    });

    testWidgets('a photograph that nobody holds any more (the screen is gone) is not left on the device', (WidgetTester tester) async {
      late _HostState host;
      final ({_HostState host, Directory folder, _Source source}) world = await pumpField(tester, (_) => host.leave());
      host = world.host;

      await tester.tap(find.byType(OutlinedButton));
      await _untilDiscarded(tester, world.source);

      expect(host.photos, isEmpty);
      expect(world.folder.listSync(), isEmpty, reason: 'neither the prepared file nor the original stays');
    });
  });
}
