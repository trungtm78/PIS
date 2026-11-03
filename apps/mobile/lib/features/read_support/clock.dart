import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The clock of the phone. It is used for exactly one thing: the age of a copy kept on the device (BR-MOB-01), to mark it
/// out of date. It is never used to judge a licence, a period or a deadline: the server is the authority for those, and a
/// test replaces this clock with a fixed one.
final Provider<DateTime Function()> clockProvider = Provider<DateTime Function()>((Ref ref) => () => DateTime.now().toUtc());
