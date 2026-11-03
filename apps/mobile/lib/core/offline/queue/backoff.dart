import 'dart:math';

/// The wait before a command that came back without a settled answer is sent again: exponential, capped, with jitter so
/// that the phones of a whole site that come back online together do not send in the same second.
final class Backoff {
  Backoff({
    this.base = const Duration(seconds: 2),
    this.cap = const Duration(minutes: 5),
    this.jitter = 0.2,
    Random? random,
  }) : _random = random ?? Random();

  final Duration base;
  final Duration cap;

  /// The fraction of the delay that is random: 0.2 means between 80 and 120 percent of the delay.
  final double jitter;
  final Random _random;

  /// The wait after [attempts] failed sends (1 for the first failure).
  Duration delayAfter(int attempts) {
    if (attempts < 1) return Duration.zero;
    final double exponential = base.inMilliseconds * pow(2, min(attempts - 1, 30)).toDouble();
    final double capped = min(exponential, cap.inMilliseconds.toDouble());
    final double spread = 1 - jitter + _random.nextDouble() * 2 * jitter;
    return Duration(milliseconds: (capped * spread).round());
  }
}
