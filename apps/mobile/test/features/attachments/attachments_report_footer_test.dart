import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:machvon_mobile/core/di/providers.dart';
import 'package:machvon_mobile/core/navigation/feature.dart';
import 'package:machvon_mobile/core/offline/attachments/attachment_upload.dart';
import 'package:machvon_mobile/core/offline/offline_providers.dart';
import 'package:machvon_mobile/features/attachments/attachments_feature.dart' as attachments;

import '../../support/harness.dart';

/// MOB-19 as the seventh step of a weekly report, with no database: the list of uploads is a fake stream, the review a stub screen.
/// Field finding of PHONECHK4: the step showed "Chưa có dữ liệu" and no footer, so MOB-20 (where "Nộp báo cáo" is) could not be reached.
Widget _stub(BuildContext context, ScreenContext screen) => Scaffold(body: Text('STUB ${screen.screenId} ${screen.pathParameters['draftId']}'));

const MobileFeature _review = MobileFeature(
  id: 'review_stub',
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-20', pathSuffix: '/:draftId', builder: _stub),
    ScreenSpec(screenId: 'MOB-22', builder: _stub),
  ],
);

AttachmentUpload _upload(String id, UploadState state, {String owner = 'report', String? ref = 'd-1'}) => AttachmentUpload(
      id: id,
      tenantId: 'tenant-a',
      userId: 'user-1',
      ownerKind: owner,
      ownerRef: ref,
      fileName: '$id.pdf',
      sourcePath: '/nowhere/$id.pdf',
      sizeBytes: 100,
      state: state,
      startKey: 's-$id',
      completeKey: 'c-$id',
      createdAt: 1,
      updatedAt: 1,
    );

Future<ProviderContainer> _open(WidgetTester tester, String location, {List<AttachmentUpload> uploads = const <AttachmentUpload>[], bool picker = false}) {
  useDevice(tester, const Size(390, 844));
  return pumpApp(
    tester,
    features: <MobileFeature>[attachments.feature, _review],
    location: location,
    overrides: <Override>[
      attachmentUploadsProvider.overrideWith((Ref ref) => Stream<List<AttachmentUpload>>.value(uploads)),
      if (picker) attachmentPickerProvider.overrideWithValue(() async => <File>[]),
      ...idleRunners,
    ],
  );
}

void main() {
  group('MOB-19 step of a report keeps its footer (files are optional)', () {
    testWidgets('empty list and no picker: "Chưa có dữ liệu" with Quay lại and Tiếp tục, and Tiếp tục opens the review of the draft', (WidgetTester tester) async {
      final ProviderContainer container = await _open(tester, '/projects/mob-19?owner=report&ref=d-1');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('Thêm tệp'), findsNothing);
      expect(find.text('Quay lại'), findsOneWidget);
      expect(find.textContaining('không bắt buộc'), findsOneWidget);
      await tester.tap(find.text('Tiếp tục'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-20/d-1');
      expect(find.text('STUB MOB-20 d-1'), findsOneWidget);
      await pressBack(tester);
      expect(find.text('Tiếp tục'), findsOneWidget, reason: 'back returns to the attachment step');
    });

    testWidgets('files still on their way or refused do not hide or disable the way on', (WidgetTester tester) async {
      final ProviderContainer container = await _open(tester, '/projects/mob-19?owner=report&ref=d-1', uploads: <AttachmentUpload>[_upload('a', UploadState.uploading), _upload('b', UploadState.failed)], picker: true);
      expect(find.text('a.pdf'), findsOneWidget);
      expect(find.text('Thêm tệp'), findsOneWidget);
      final FilledButton next = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Tiếp tục'));
      expect(next.onPressed, isNotNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Tiếp tục'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-20/d-1');
    });

    testWidgets('opened from the review, the way on is Xem lại and returns to that review without opening a second one', (WidgetTester tester) async {
      final ProviderContainer container = await _open(tester, '/projects/mob-20/d-1');
      unawaited(container.read(routerProvider).push('/projects/mob-19?owner=report&ref=d-1&from=MOB-20'));
      await tester.pumpAndSettle();
      expect(find.text('Tiếp tục'), findsNothing);
      await tester.tap(find.text('Xem lại'));
      await tester.pumpAndSettle();
      expect(currentLocation(container), '/projects/mob-20/d-1');
      expect(find.text('STUB MOB-20 d-1'), findsOneWidget);
      await pressBack(tester);
      expect(find.text('STUB MOB-20 d-1'), findsNothing, reason: 'there was only one review on the stack');
    });

    testWidgets('the list of another kind of record (a site photo) has no report footer', (WidgetTester tester) async {
      await _open(tester, '/projects/mob-19?owner=site_photo&ref=p-1');
      expect(find.text('Chưa có dữ liệu'), findsOneWidget);
      expect(find.text('Tiếp tục'), findsNothing);
      expect(find.textContaining('không bắt buộc'), findsNothing);
    });
  });
}
