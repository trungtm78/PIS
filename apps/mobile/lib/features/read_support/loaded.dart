/// Where the data on the screen came from.
enum DataSource { network, cache }

/// A read as the screen shows it: the value, the moment it describes, and whether it is the answer the server just gave
/// or a copy kept on the device (and, if a copy, whether it is older than the time it may be trusted for).
final class Loaded<T> {
  const Loaded({required this.value, required this.source, required this.fetchedAt, this.asOf, this.stale = false});

  final T value;
  final DataSource source;

  /// The moment the data describes, as the server gave it (`as_of` or `as_of_date`); null when the answer names none.
  final String? asOf;

  /// When the phone got the answer.
  final DateTime fetchedAt;

  /// A copy older than its time to live (BR-MOB-01).
  final bool stale;

  bool get fromCache => source == DataSource.cache;
}
