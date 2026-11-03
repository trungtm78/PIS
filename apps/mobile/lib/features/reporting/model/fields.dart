import 'report_review.dart';

/// The findings of a review by the field they are about, so that a screen can write each one beside its box. The first finding
/// of a field is the one shown.
Map<String, Finding> byField(Iterable<Finding> findings) {
  final Map<String, Finding> found = <String, Finding>{};
  for (final Finding finding in findings) {
    found.putIfAbsent(finding.field, () => finding);
  }
  return found;
}
