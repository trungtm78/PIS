import 'clearance_models.dart';

// The rules of the inventory form are those of the web LND-04 (apps/web/src/screens/lnd/inventory/model.ts), so that an inventory
// typed on the phone is judged the same as one typed on the web; the server judges them again, and it alone judges the price decision of
// the day of the survey, the household's right on the parcel, the consent and whether the survey is in the future.

const int descriptionMax = 2000;
const int unitCodeMax = 50;
const int referenceMax = 100;
const int noteMax = 2000;

final RegExp _quantity = RegExp(r'^(0|[1-9]\d{0,17})(\.\d{1,6})?$');
final RegExp _zero = RegExp(r'^0(\.0+)?$');
final RegExp _price = RegExp(r'^(0|[1-9]\d{0,23})$');
final RegExp _control = RegExp(r'[\u0000-\u001f\u007f]');

enum InventoryProblem {
  parcelRequired,
  kindRequired,
  descriptionRequired,
  descriptionTooLong,
  descriptionInvalid,
  quantityRequired,
  quantityInvalid,
  unitRequired,
  unitTooLong,
  unitInvalid,
  priceRequired,
  priceInvalid,
  referenceRequired,
  referenceTooLong,
  referenceInvalid,
  dayRequired,
  dayInvalid,
}

/// A calendar day that exists, written `YYYY-MM-DD` (the 30th of February is not one).
bool isCalendarDay(String value) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) return false;
  final DateTime? parsed = DateTime.tryParse('${value}T00:00:00Z');
  return parsed != null && parsed.toIso8601String().substring(0, 10) == value;
}

/// What the person typed for an inventory record.
final class InventoryForm {
  const InventoryForm({this.parcelId, this.itemKind, this.description = '', this.quantity = '', this.unitCode = '', this.unitPriceVnd = '', this.priceDecisionRef = '', this.surveyedOn = ''});

  final String? parcelId;
  final String? itemKind;
  final String description;
  final String quantity;
  final String unitCode;
  final String unitPriceVnd;
  final String priceDecisionRef;
  final String surveyedOn;
}

/// A Vietnamese keyboard types a decimal comma; the server takes a point. Only the comma is changed, nothing is guessed.
String normaliseQuantity(String quantity) => quantity.trim().replaceAll(',', '.');

/// What the form lacks before it is kept or sent.
Map<String, InventoryProblem> checkInventory(InventoryForm form) {
  final Map<String, InventoryProblem> problems = <String, InventoryProblem>{};
  if (form.parcelId == null || form.parcelId!.isEmpty) problems['parcel'] = InventoryProblem.parcelRequired;
  if (form.itemKind == null || !itemKinds.contains(form.itemKind)) problems['kind'] = InventoryProblem.kindRequired;
  final String description = form.description.trim();
  if (description.isEmpty) {
    problems['description'] = InventoryProblem.descriptionRequired;
  } else if (description.length > descriptionMax) {
    problems['description'] = InventoryProblem.descriptionTooLong;
  } else if (_control.hasMatch(description)) {
    problems['description'] = InventoryProblem.descriptionInvalid;
  }
  final String quantity = normaliseQuantity(form.quantity);
  if (quantity.isEmpty) {
    problems['quantity'] = InventoryProblem.quantityRequired;
  } else if (!_quantity.hasMatch(quantity) || _zero.hasMatch(quantity)) {
    problems['quantity'] = InventoryProblem.quantityInvalid;
  }
  final String unit = form.unitCode.trim();
  if (unit.isEmpty) {
    problems['unit'] = InventoryProblem.unitRequired;
  } else if (unit.length > unitCodeMax) {
    problems['unit'] = InventoryProblem.unitTooLong;
  } else if (_control.hasMatch(unit)) {
    problems['unit'] = InventoryProblem.unitInvalid;
  }
  final String price = form.unitPriceVnd.trim();
  if (price.isEmpty) {
    problems['price'] = InventoryProblem.priceRequired;
  } else if (!_price.hasMatch(price)) {
    problems['price'] = InventoryProblem.priceInvalid;
  }
  final String reference = form.priceDecisionRef.trim();
  if (reference.isEmpty) {
    problems['reference'] = InventoryProblem.referenceRequired;
  } else if (reference.length > referenceMax) {
    problems['reference'] = InventoryProblem.referenceTooLong;
  } else if (_control.hasMatch(reference)) {
    problems['reference'] = InventoryProblem.referenceInvalid;
  }
  final String surveyed = form.surveyedOn.trim();
  if (surveyed.isEmpty) {
    problems['day'] = InventoryProblem.dayRequired;
  } else if (!isCalendarDay(surveyed)) {
    problems['day'] = InventoryProblem.dayInvalid;
  }
  return problems;
}

/// `quantity × unit price` rounded half up to the dong, on whole numbers (BR-LND-04: 80 m2 × 4.500.000 = 360.000.000); null while the two
/// are not figures. It is a preview for the person: the amount of the record is the server's.
String? amountOf(String quantity, String unitPriceVnd) {
  final String q = normaliseQuantity(quantity);
  final String p = unitPriceVnd.trim();
  if (!_quantity.hasMatch(q) || _zero.hasMatch(q) || !_price.hasMatch(p)) return null;
  final List<String> parts = q.split('.');
  final String fraction = parts.length > 1 ? parts[1] : '';
  final BigInt scale = BigInt.from(1000000);
  final BigInt scaled = BigInt.parse('${parts[0]}${fraction.padRight(6, '0')}');
  return ((scaled * BigInt.parse(p) + scale ~/ BigInt.two) ~/ scale).toString();
}

// ---- the answer of the household ---------------------------------------------------------------------------------------------------

enum AnswerProblem { outcomeRequired, dayRequired, dayInvalid, dayBeforeSurvey, noteRequired, noteTooLong, noteInvalid }

/// What the answer of the household lacks: an outcome, a day that is a day and not before the survey, and the reason of an objection.
/// Whether the day is yet to come is for the server to judge, not for the clock of the phone.
Map<String, AnswerProblem> checkAnswer({required String? outcome, required String answeredOn, required String note, required String surveyedOn}) {
  final Map<String, AnswerProblem> problems = <String, AnswerProblem>{};
  if (outcome != 'CONFIRMED' && outcome != 'DISPUTED') problems['outcome'] = AnswerProblem.outcomeRequired;
  final String on = answeredOn.trim();
  if (on.isEmpty) {
    problems['day'] = AnswerProblem.dayRequired;
  } else if (!isCalendarDay(on)) {
    problems['day'] = AnswerProblem.dayInvalid;
  } else if (on.compareTo(surveyedOn) < 0) {
    problems['day'] = AnswerProblem.dayBeforeSurvey;
  }
  final String words = note.trim();
  if (outcome == 'DISPUTED' && words.isEmpty) {
    problems['note'] = AnswerProblem.noteRequired;
  } else if (words.length > noteMax) {
    problems['note'] = AnswerProblem.noteTooLong;
  } else if (_control.hasMatch(words)) {
    problems['note'] = AnswerProblem.noteInvalid;
  }
  return problems;
}
