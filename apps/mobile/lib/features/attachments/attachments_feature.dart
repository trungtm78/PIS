import '../../core/navigation/feature.dart';
import 'attachments_strings.dart';
import 'screens/attachments_screen.dart';

/// ST-MOB-009: the attachment list (MOB-19). The uploader itself is `lib/core/offline/attachments`;
/// docs/mobile-offline.md describes how a feature adds a file to a record.
const MobileFeature feature = MobileFeature(
  id: 'attachments',
  strings: attachmentsStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-19', builder: buildAttachmentsScreen),
  ],
);
