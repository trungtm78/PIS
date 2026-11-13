import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart' show addTearDown;
import 'package:machvon_mobile/core/l10n/app_strings.dart';
import 'package:machvon_mobile/core/l10n/string_table.dart';
import 'package:machvon_mobile/core/widgets/app_scaffold.dart';
import 'package:machvon_mobile/features/command_support/field_widgets.dart';
import 'package:machvon_mobile/features/field_evidence/field_evidence_strings.dart';
import 'package:machvon_mobile/features/field_quantities/inspection_models.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_models.dart';
import 'package:machvon_mobile/features/field_quantities/quantity_strings.dart';
import 'package:machvon_mobile/features/field_quantities/screens/inspection_view.dart';
import 'package:machvon_mobile/features/field_quantities/screens/quantity_view.dart';

/// The words the two views need: their own, and the field words of the bar and of the receipt of a save made offline.
const List<StringTable> kFieldViewTables = <StringTable>[quantityStrings, fieldEvidenceStrings];

const BoqItem _item = BoqItem(lineId: 'l-1', revisionId: 'r-1', businessKey: 'B01', description: 'Đào đất', unitCode: 'm3', quantity: '8000', itemId: 'item-1');

Measurement measurementOf(String id, {String status = 'DRAFT', bool canSubmit = true, int evidence = 0, String quantity = '1234.5'}) => Measurement(
      id: id,
      itemKey: 'B01',
      periodCode: '2026-11',
      quantityPeriod: quantity,
      status: status,
      version: 2,
      canSubmit: canSubmit,
      remainingQuantity: '6765.5',
      unitCode: 'm3',
      evidenceCount: evidence,
    );

/// The controllers of one quantity form, disposed when the test ends.
QuantityFields quantityFields({String quantity = '1234.5', String reference = 'BB-014'}) {
  final QuantityFields fields = QuantityFields(
    quantity: TextEditingController(text: quantity),
    reference: TextEditingController(text: reference),
    override: TextEditingController(),
    periodId: TextEditingController(),
  );
  addTearDown(() {
    fields.quantity.dispose();
    fields.reference.dispose();
    fields.override.dispose();
    fields.periodId.dispose();
  });
  return fields;
}

/// The screen of MOB-63 on sample data, in the state asked for: [empty] has no item to record against and nothing recorded, [offline] shows the
/// receipt of a save kept on the phone and the bar that saves for later, [readOnly] locks the bar, [errors] draws the words under the fields.
Widget sampleQuantityScreen({
  bool empty = false,
  bool offline = false,
  bool readOnly = false,
  Map<String, String> errors = const <String, String>{},
  VoidCallback? onSave,
  VoidCallback? onReload,
  ValueChanged<Measurement>? onSubmit,
  QuantityFields? fields,
  String quantity = '1234.5',
}) {
  final QuantityFields controllers = fields ?? quantityFields(quantity: empty ? '' : quantity, reference: empty ? '' : 'BB-014');
  return Builder(
    builder: (BuildContext context) => AppScaffold(
      title: context.t('mob.qty.title'),
      body: QuantityEntryView(
        contractLabel: 'HD-A-001 · Đường tỉnh ĐT.A1',
        contractStatus: 'ACTIVE',
        items: empty ? const <BoqItem>[] : const <BoqItem>[_item],
        periods: const <MeasurePeriod>[MeasurePeriod(id: 'per-1', code: '2026-11')],
        form: empty ? const QuantityForm() : QuantityForm(itemLineId: 'l-1', periodId: 'per-1', quantity: quantity, referenceNo: 'BB-014'),
        fields: controllers,
        errors: errors,
        saving: false,
        onItem: (String _) {},
        onPeriod: (String _) {},
        onPeriodText: (String _) {},
        onQuantity: (String _) {},
        onReference: (String _) {},
        onOverride: (String _) {},
        remaining: empty ? null : '6.765,5',
        unit: empty ? null : 'm3',
        echo: empty || errors.containsKey('quantity') ? null : '1.234,5',
        notices: <Widget>[if (offline) SavedForLaterPanel(onOpenQueue: () {})],
        placeField: const Text('Vị trí đo: chưa lấy vị trí'),
        photosField: const Text('Ảnh bằng chứng: chưa chọn ảnh'),
        measurements: empty
            ? const <Measurement>[]
            : <Measurement>[measurementOf('m-1', evidence: 2), measurementOf('m-2', status: 'APPROVED', canSubmit: false, evidence: 3, quantity: '2000')],
        submitWhy: offline ? context.t('mob.qty.gate.offline') : null,
        busy: false,
        onSubmit: onSubmit ?? (Measurement _) {},
        onReload: onReload ?? () {},
        bar: FieldSendBar(
          label: context.t('mob.qty.save.action'),
          offline: offline,
          onSend: readOnly ? null : (onSave ?? () {}),
          why: readOnly ? context.t('mob.qty.gate.readOnly') : null,
        ),
      ),
    ),
  );
}

const Inspection sampleInspection = Inspection(
  id: 'i-1',
  inspectionNo: 'INS-A-0002',
  title: 'Nghiệm thu cốt thép móng T3',
  status: 'SCHEDULED',
  canRecord: true,
  version: 3,
  locationText: 'Trụ T3, km3+200',
  checklist: <ChecklistItem>[ChecklistItem(code: 'K1', label: 'Cốt thép đúng chủng loại'), ChecklistItem(code: 'K2', label: 'Khoảng cách thép đai')],
);

/// The screen of MOB-64 on sample data: the first item failed, the second not answered, a result chosen. [errors] draws the words under the
/// answers, [offline] shows the receipt of a save kept on the phone and the bar that saves for later.
Widget sampleInspectionScreen({
  bool offline = false,
  bool readOnly = false,
  Map<String, String> errors = const <String, String>{},
  ResultForm form = const ResultForm(answers: <String, ItemAnswer>{'K1': ItemAnswer(outcome: 'FAIL', note: 'Thép phi 12, không phải phi 16')}, result: 'CONDITIONAL'),
  void Function(String code, String outcome)? onOutcome,
}) {
  final Map<String, TextEditingController> notes = <String, TextEditingController>{
    for (final ChecklistItem item in sampleInspection.checklist) item.code: TextEditingController(text: form.answerOf(item.code).note),
  };
  final TextEditingController resultNote = TextEditingController(text: form.resultNote);
  addTearDown(() {
    for (final TextEditingController controller in notes.values) {
      controller.dispose();
    }
    resultNote.dispose();
  });
  return Builder(
    builder: (BuildContext context) => AppScaffold(
      title: context.t('mob.chk.title'),
      body: InspectionEntryView(
        contractLabel: 'HD-A-001 · Đường tỉnh ĐT.A1',
        inspections: const <Inspection>[sampleInspection],
        inspection: sampleInspection,
        onPick: (String _) {},
        formOpen: true,
        form: form,
        itemNotes: notes,
        resultNote: resultNote,
        errors: errors,
        saving: false,
        onOutcome: onOutcome ?? (String code, String outcome) {},
        onItemNote: (String code, String note) {},
        onResult: (String _) {},
        onResultNote: (String _) {},
        placeField: const Text('Vị trí kiểm tra: chưa lấy vị trí'),
        photosField: const Text('Ảnh kiểm tra: chưa chọn ảnh'),
        raised: const <Nonconformance>[],
        notices: <Widget>[if (offline) SavedForLaterPanel(onOpenQueue: () {})],
        bar: FieldSendBar(
          label: context.t('mob.chk.save.action'),
          offline: offline,
          onSend: readOnly ? null : () {},
          why: readOnly ? context.t('mob.chk.gate.readOnly') : null,
        ),
      ),
    ),
  );
}
