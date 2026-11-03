import 'package:machvon_api_client/machvon_api_client.dart' show newUuidV4;

import '../../core/offline/drafts/draft_store.dart';
import '../../core/offline/drafts/local_draft.dart';
import 'inventory_rules.dart';

/// The kind of draft this feature keeps in the encrypted store of the device.
const String inventoryDraftKind = 'land.inventory';

/// An inventory record the officer typed in the field, kept on the device until it is sent. It holds the household by its id and its code
/// (a reference, not a person), the parcel by id and code, and what was counted: no name, no identity number, no telephone, no address.
///
/// `attemptKey` is the idempotency key of the command that will send it. It is made with the draft and kept in it, so a send whose answer
/// was lost (or an application killed in the middle) is sent again under the same key and the server records the record once. A final
/// refusal gives the draft a new key (see [InventoryDrafts.refused]), because the person changes the draft and sends another command.
///
/// `awaitingAnswer` is kept from the moment the request leaves the phone until the server has answered it (or the request is known not
/// to have left): the request may exist on the server under `attemptKey`, so the draft cannot be changed meanwhile, or the same key would
/// carry another payload. It is sent again as it is, or deleted.
final class InventoryDraft {
  const InventoryDraft({
    required this.id,
    required this.householdId,
    required this.householdCode,
    required this.parcelId,
    required this.parcelCode,
    required this.form,
    required this.attemptKey,
    this.lastRefusal,
    this.awaitingAnswer = false,
  });

  final String id;
  final String householdId;
  final String householdCode;
  final String parcelId;
  final String parcelCode;
  final InventoryForm form;
  final String attemptKey;

  /// The code of the last refusal of the server, kept to be shown beside the draft.
  final String? lastRefusal;

  /// A request was sent for this draft and no answer has settled it: it is not editable.
  final bool awaitingAnswer;

  Map<String, Object?> toFields() => <String, Object?>{
        'household_id': householdId,
        'household_code': householdCode,
        'parcel_id': parcelId,
        'parcel_code': parcelCode,
        'item_kind': form.itemKind,
        'description': form.description.trim(),
        'quantity': normaliseQuantity(form.quantity),
        'unit_code': form.unitCode.trim(),
        'unit_price_vnd': form.unitPriceVnd.trim(),
        'price_decision_ref': form.priceDecisionRef.trim(),
        'surveyed_on': form.surveyedOn.trim(),
        'attempt_key': attemptKey,
        if (lastRefusal != null) 'last_refusal': lastRefusal,
        if (awaitingAnswer) 'awaiting_answer': true,
      };

  static InventoryDraft? fromLocal(LocalDraft draft) {
    final Map<String, Object?> f = draft.fields;
    String? s(String key) => f[key] is String ? f[key]! as String : null;
    final String? householdId = s('household_id');
    final String? parcelId = s('parcel_id');
    final String? key = s('attempt_key');
    if (draft.kind != inventoryDraftKind || householdId == null || parcelId == null || key == null) return null;
    return InventoryDraft(
      id: draft.id,
      householdId: householdId,
      householdCode: s('household_code') ?? '',
      parcelId: parcelId,
      parcelCode: s('parcel_code') ?? '',
      form: InventoryForm(
        parcelId: parcelId,
        itemKind: s('item_kind'),
        description: s('description') ?? '',
        quantity: s('quantity') ?? '',
        unitCode: s('unit_code') ?? '',
        unitPriceVnd: s('unit_price_vnd') ?? '',
        priceDecisionRef: s('price_decision_ref') ?? '',
        surveyedOn: s('surveyed_on') ?? '',
      ),
      attemptKey: key,
      lastRefusal: s('last_refusal'),
      awaitingAnswer: f['awaiting_answer'] == true,
    );
  }
}

/// The draft is waiting for the answer of a request that was sent: what it says cannot be changed.
final class InventoryDraftLocked implements Exception {
  const InventoryDraftLocked(this.id);

  final String id;

  @override
  String toString() => 'InventoryDraftLocked($id)';
}

/// The inventory drafts of the person, over the draft store of the device.
final class InventoryDrafts {
  InventoryDrafts(this._store, {String Function()? newKey}) : _newKey = newKey ?? newUuidV4;

  final DraftStore _store;
  final String Function() _newKey;

  /// Keeps what was typed. A new draft gets its key now; an edited one keeps it (the same intention). A draft that waits for the answer
  /// of a request is [InventoryDraftLocked].
  InventoryDraft save({
    String? id,
    required String householdId,
    required String householdCode,
    required String parcelId,
    required String parcelCode,
    required InventoryForm form,
  }) {
    final InventoryDraft? existing = id == null ? null : of(householdId).where((InventoryDraft d) => d.id == id).firstOrNull;
    if (existing != null && existing.awaitingAnswer) throw InventoryDraftLocked(existing.id);
    final String key = existing?.attemptKey ?? _newKey();
    final InventoryDraft draft = InventoryDraft(id: id ?? '', householdId: householdId, householdCode: householdCode, parcelId: parcelId, parcelCode: parcelCode, form: form, attemptKey: key, lastRefusal: existing?.lastRefusal);
    final LocalDraft saved = _store.save(id: id, kind: inventoryDraftKind, fields: draft.toFields(), recordId: householdId);
    return InventoryDraft.fromLocal(saved)!;
  }

  /// The drafts of one household, newest first.
  List<InventoryDraft> of(String householdId) => <InventoryDraft>[
        for (final LocalDraft draft in _store.list(kind: inventoryDraftKind))
          if (InventoryDraft.fromLocal(draft) case final InventoryDraft parsed when parsed.householdId == householdId) parsed,
      ];

  /// The server recorded the record: the draft has done its work.
  void remove(String id) => _store.delete(id);

  /// The request of the draft is about to leave the phone: from now on, and across a restart, the draft waits for the answer.
  InventoryDraft sent(InventoryDraft draft) => _rewrite(draft, awaitingAnswer: true);

  /// The request is known not to have left the phone (the device was offline): the draft is free again, under the same key.
  InventoryDraft notSent(InventoryDraft draft) => _rewrite(draft, awaitingAnswer: false);

  InventoryDraft _rewrite(InventoryDraft draft, {required bool awaitingAnswer}) {
    final InventoryDraft next = InventoryDraft(
      id: draft.id,
      householdId: draft.householdId,
      householdCode: draft.householdCode,
      parcelId: draft.parcelId,
      parcelCode: draft.parcelCode,
      form: draft.form,
      attemptKey: draft.attemptKey,
      lastRefusal: draft.lastRefusal,
      awaitingAnswer: awaitingAnswer,
    );
    return InventoryDraft.fromLocal(_store.save(id: draft.id, kind: inventoryDraftKind, fields: next.toFields(), recordId: draft.householdId))!;
  }

  /// The server refused for good: the draft stays for the person to correct, with the code, and the next send is a new command.
  InventoryDraft refused(InventoryDraft draft, String code) {
    final InventoryDraft next = InventoryDraft(
      id: draft.id,
      householdId: draft.householdId,
      householdCode: draft.householdCode,
      parcelId: draft.parcelId,
      parcelCode: draft.parcelCode,
      form: draft.form,
      attemptKey: _newKey(),
      lastRefusal: code,
    );
    return InventoryDraft.fromLocal(_store.save(id: draft.id, kind: inventoryDraftKind, fields: next.toFields(), recordId: draft.householdId))!;
  }
}
