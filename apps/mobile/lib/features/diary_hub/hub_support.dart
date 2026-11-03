import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/di/providers.dart';
import '../../core/l10n/app_strings.dart';
import '../../core/session/session.dart';
import '../site_diary/contract_models.dart';
import 'hub_commands.dart';
import 'hub_models.dart';

export '../read_support/offline.dart' show isOffline;

/// Why a conflict cannot be settled now. The reason is always written beside the disabled button. Offline wins over everything: a
/// settling is made on the server, on the diary as it is now, never from a copy kept on the phone and never from a queue.
enum ResolveGate { open, offline, readOnly, noCopy, noAction }

ResolveGate gateOf({required ServerDiary diary, required bool offline, required bool fromCopy, required SessionSnapshot session}) {
  if (offline || fromCopy) return ResolveGate.offline;
  if (session.isReadOnly) return ResolveGate.readOnly;
  if (!diary.hasConflict) return ResolveGate.noCopy;
  if (!diary.canResolve) return ResolveGate.noAction;
  return ResolveGate.open;
}

String gateText(BuildContext context, ResolveGate gate) {
  switch (gate) {
    case ResolveGate.open:
      return '';
    case ResolveGate.offline:
      return context.t('mob.dryhub.gate.offline');
    case ResolveGate.readOnly:
      return context.t('mob.dryhub.gate.readOnly');
    case ResolveGate.noCopy:
      return context.t('mob.dryhub.gate.noCopy');
    case ResolveGate.noAction:
      return context.t('mob.dryhub.gate.noAction');
  }
}

String stateLabel(BuildContext context, LocalState state) {
  switch (state) {
    case LocalState.conflict:
      return context.t('mob.dryhub.state.conflict');
    case LocalState.rejected:
      return context.t('mob.dryhub.state.rejected');
    case LocalState.unknown:
      return context.t('mob.dryhub.state.unknown');
    case LocalState.sending:
      return context.t('mob.dryhub.state.sending');
    case LocalState.queued:
      return context.t('mob.dryhub.state.queued');
    case LocalState.draft:
      return context.t('mob.dryhub.state.draft');
    case LocalState.sent:
      return context.t('mob.dryhub.state.sent');
  }
}

String resolveProblemText(BuildContext context, ResolveProblem problem) {
  switch (problem) {
    case ResolveProblem.noCopy:
      return context.t('mob.dryhub.resolve.problem.noCopy');
    case ResolveProblem.noResolution:
      return context.t('mob.dryhub.resolve.problem.noResolution');
    case ResolveProblem.adoptSigned:
      return context.t('mob.dryhub.resolve.problem.adoptSigned');
    case ResolveProblem.noteRequired:
      return context.t('mob.dryhub.resolve.problem.noteRequired');
    case ResolveProblem.noteTooLong:
      return context.t('mob.dryhub.resolve.problem.noteTooLong');
  }
}

String problemText(BuildContext context, HubProblem problem) {
  switch (problem) {
    case HubProblem.diaryState:
      return context.t('mob.dryhub.problem.diaryState');
    case HubProblem.versionConflict:
      return context.t('mob.dryhub.problem.versionConflict');
    case HubProblem.stepUp:
      return context.t('mob.dryhub.problem.stepUp');
    case HubProblem.licenseExpired:
      return context.t('mob.dryhub.problem.licenseExpired');
    case HubProblem.validation:
      return context.t('mob.dryhub.problem.validation');
    case HubProblem.notFound:
      return context.t('mob.dryhub.problem.notFound');
    case HubProblem.denied:
      return context.t('mob.dryhub.problem.denied');
    case HubProblem.sessionEnded:
      return context.t('mob.dryhub.problem.sessionEnded');
    case HubProblem.general:
      return context.t('mob.dryhub.problem.general');
  }
}

/// The codes of the contracts the person works on, by id, so that a diary on the phone is named by its contract. A contract that cannot
/// be read now is left without its code: the row says the contract is not known, and nothing else changes.
final FutureProvider<Map<String, String>> contractCodesProvider = FutureProvider.autoDispose<Map<String, String>>((Ref ref) async {
  try {
    final List<ContractLine> contracts = parseContracts(await readContracts(ref.watch(apiClientProvider))) ?? const <ContractLine>[];
    return <String, String>{for (final ContractLine contract in contracts) contract.id: contract.code};
  } on Object {
    return const <String, String>{};
  }
});

/// Counts the changes made to the diaries from this hub, so that the list under a diary that was just settled reads again.
class HubChanged extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state += 1;
}

final NotifierProvider<HubChanged, int> hubChangedProvider = NotifierProvider<HubChanged, int>(HubChanged.new);
