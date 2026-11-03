// A weekly report as the server holds it and as a device edited it offline: the fixtures of the conflict tests.

const String reportId = '5b3c0e7a-0a56-4c0e-8c33-0f2f6b7f1a01';

/// The report as the server shows it after the other device saved 120,000,000 (version 7).
Map<String, Object?> serverView({String construction = '120000000', int version = 7}) => <String, Object?>{
      'id': reportId,
      'version': version,
      'status': 'DRAFT',
      'report_type': 'WEEKLY',
      'measurement_basis': 'PERIOD',
      'negative_delta_explanation': null,
      'funding_lines': <Object?>[
        <String, Object?>{'bucket': 'CARRYOVER', 'budget_level': 'LOCAL', 'allocated_vnd': '999', 'cumulative_vnd': '70000000', 'source_year': null},
        <String, Object?>{'bucket': 'CURRENT_YEAR', 'budget_level': 'CENTRAL', 'allocated_vnd': '999', 'cumulative_vnd': '50000000', 'ctmtqg_subset_vnd': '10000000', 'source_year': null},
      ],
      'progress': <String, Object?>{'construction_vnd': construction, 'acceptance_vnd': '80000000', 'physical_progress_pct': '40.50'},
      'narrative': <String, Object?>{'results': 'Done on site', 'causes': 'Rain'},
    };

/// What this device saved offline against version 3: 130,000,000 for the construction volume.
Map<String, Object?> devicePayload({String construction = '130000000'}) => <String, Object?>{
      'report_id': reportId,
      'report_type': 'WEEKLY',
      'client_operation_id': 'c0000000-0000-4000-8000-0000000000aa',
      'construction_vnd': construction,
      'acceptance_vnd': '80000000.00',
      'funding_lines': <Object?>[
        <String, Object?>{'bucket': 'CURRENT_YEAR', 'budget_level': 'CENTRAL', 'cumulative_vnd': '50000000', 'ctmtqg_subset_vnd': '10000000'},
        <String, Object?>{'bucket': 'CARRYOVER', 'budget_level': 'LOCAL', 'cumulative_vnd': '65000000'},
      ],
      'narrative': <String, Object?>{'results': 'Done on site and checked'},
    };
