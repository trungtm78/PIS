import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session.dart';
import 'device_integrity.dart';
import 'integrity_state.dart';

/// Asks the session for the second factor (the step-up of MOB-03). The session of `features/session` provides it; the default does
/// nothing, so a screen that is tried on its own has no session to ask.
final Provider<void Function()> secondFactorRequesterProvider = Provider<void Function()>((Ref ref) => () {});

/// Wraps a screen whose action a phone that looks modified may not take on its own authority (D-SEC-01, mode
/// `restrict_sensitive`): approving or rejecting, and signing. While the policy restricts [restriction] and the session has not
/// passed a second factor, the screen asks for the step-up, and the router sends the person to MOB-03 and back. The server
/// judges the step-up as it does for any other session, so the phone is not trusted with the decision. A phone that is not
/// restricted, or a session already at the second level, is not interrupted.
class IntegrityStepUp extends ConsumerStatefulWidget {
  const IntegrityStepUp({required this.restriction, required this.child, super.key});

  final IntegrityRestriction restriction;
  final Widget child;

  @override
  ConsumerState<IntegrityStepUp> createState() => _IntegrityStepUpState();
}

class _IntegrityStepUpState extends ConsumerState<IntegrityStepUp> {
  @override
  void initState() {
    super.initState();
    // Asking changes the session, which the router listens to: not while this frame is being built.
    WidgetsBinding.instance.addPostFrameCallback((Duration _) => _ask());
  }

  void _ask() {
    if (!mounted) return;
    final SessionSnapshot session = ref.read(sessionProvider);
    final bool restricted = ref.read(integrityProvider).decision.restricts(widget.restriction);
    if (restricted && session.isSignedIn && session.assurance == AssuranceLevel.aal1 && !session.stepUpRequired) {
      ref.read(secondFactorRequesterProvider)();
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<IntegrityStatus>(integrityProvider, (IntegrityStatus? previous, IntegrityStatus next) => _ask());
    return widget.child;
  }
}
