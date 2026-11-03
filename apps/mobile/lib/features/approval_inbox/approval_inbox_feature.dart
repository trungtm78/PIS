import '../../core/navigation/feature.dart';
import 'approval_strings.dart';
import 'screens/approval_confirm_screen.dart';
import 'screens/approval_detail_screen.dart';
import 'screens/approval_inbox_screen.dart';
import 'screens/approval_return_screen.dart';

/// ST-MOB-013: the approvals. MOB-23 the inbox, MOB-24 the detail with the comparison and the evidence, MOB-25 the confirmation
/// (a second factor, no signature in this release) and MOB-26 the return with reasons. Online only: no approval is queued, sent
/// from a copy, or made by a swipe or one tap from a push.
const MobileFeature feature = MobileFeature(
  id: 'approval_inbox',
  strings: approvalStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-23', builder: buildApprovalInboxScreen),
    ScreenSpec(screenId: 'MOB-24', pathSuffix: '/:taskId', builder: buildApprovalDetailScreen),
    ScreenSpec(screenId: 'MOB-25', pathSuffix: '/:taskId', builder: buildApprovalConfirmScreen),
    ScreenSpec(screenId: 'MOB-26', pathSuffix: '/:taskId', builder: buildApprovalReturnScreen),
  ],
);
