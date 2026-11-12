import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The contract the person worked on last in this run (a diary, a quantity, a photograph opened for it): the quick "Report" sheet chooses
/// it for them, so a report from the field is two taps (the button, the kind) and not a walk through the lists of contracts.
class LastFieldContract extends Notifier<String?> {
  @override
  String? build() => null;

  void remember(String contractId) {
    if (contractId.isNotEmpty && state != contractId) state = contractId;
  }
}

final NotifierProvider<LastFieldContract, String?> lastFieldContractProvider = NotifierProvider<LastFieldContract, String?>(LastFieldContract.new);
