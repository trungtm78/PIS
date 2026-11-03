import '../../core/navigation/feature.dart';
import '../../core/offline/drafts/conflict_adapter.dart' show ConflictAdapter;
import 'inspection_conflict.dart';
import 'inspection_models.dart';
import 'quantity_strings.dart';
import 'screens/inspection_screen.dart';
import 'screens/quantity_screen.dart';

/// ST-MOB-021: the quantities measured on site with their evidence (MOB-63) and the field quality inspection (MOB-64). A quantity is
/// recorded on the phone, offline, and queued as `measurement.record` with a key the phone made; the result of an inspection is queued
/// as `inspection.result` on the version of the inspection that was read; sending a quantity for approval and asking for an acceptance
/// are made online. A result that came back in conflict is settled in MOB-42 through the adapter declared here.
const MobileFeature feature = MobileFeature(
  id: 'field_quantities',
  strings: quantityStrings,
  screens: <ScreenSpec>[
    ScreenSpec(screenId: 'MOB-63', pathSuffix: '/:contractId', builder: buildQuantityScreen),
    ScreenSpec(screenId: 'MOB-64', pathSuffix: '/:contractId', builder: buildInspectionScreen),
  ],
  conflictAdapters: <String, ConflictAdapter>{kInspectionResultCommand: inspectionResultConflictAdapter},
);
