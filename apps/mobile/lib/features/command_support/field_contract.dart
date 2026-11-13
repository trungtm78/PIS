import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session.dart';

/// The contract the person worked on last in this run (a diary, a quantity, a photograph opened for it): the quick "Report" sheet chooses
/// it for them, so a report from the field is two taps (the button, the kind) and not a walk through the lists of contracts. It belongs to
/// one session: another tenant, user or membership starts with none, so a contract of the previous person is never offered.
class LastFieldContract extends Notifier<String?> {
  @override
  String? build() {
    ref.watch(sessionProvider.select((SessionSnapshot s) => '${s.tenantId}|${s.userId}|${s.membershipId}'));
    return null;
  }

  void remember(String contractId) {
    if (contractId.isNotEmpty && state != contractId) state = contractId;
  }
}

final NotifierProvider<LastFieldContract, String?> lastFieldContractProvider = NotifierProvider<LastFieldContract, String?>(LastFieldContract.new);
