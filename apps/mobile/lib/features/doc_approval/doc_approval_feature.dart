import '../../core/navigation/feature.dart';
import 'approval_strings.dart';
import 'screens/approval_screen.dart';

/// DOC-22 (ST-DOC-020, FR-DOC-22): the leader approves and signs a document on the phone, or gives it back to its drafter with a reason.
/// It is built on the signing view of `document_signing` (MOB-67): the list, the final PDF, the comparison, the remote certificate
/// authority with the one-time code. Online only: no signing command and no return is ever queued. A document is opened with
/// `?doc=<id>`; without it the screen is the list.
const MobileFeature feature = MobileFeature(
  id: 'doc_approval',
  strings: docApprovalStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'DOC-22', builder: buildApprovalScreen),
  ],
);
