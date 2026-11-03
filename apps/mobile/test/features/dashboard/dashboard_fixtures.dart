/// The golden fixtures of the home reads: the same figures as the DIS fixtures FX-DIS-001 and FX-DIS-003.
Map<String, Object?> tile(String metric, {String? value, String? numerator, String? denominator, String? nullReason, String unit = 'PERCENT', String definition = 'PROPOSED_PENDING_SIGNOFF'}) => <String, Object?>{
      'metric_code': metric,
      'value': value,
      'numerator': numerator,
      'denominator': denominator,
      'null_reason': nullReason,
      'unit': unit,
      'formula': 'disbursed / plan',
      'definition_status': definition,
      'context_token': 'token-$metric',
    };

/// U-BQL1: project 1 disbursed 50 of 100, project 2 disbursed 90 of 900 (millions), so the rate is 140/1000 = 14%, never
/// the average of 50% and 10% (UAT-AC242).
Map<String, Object?> commandCenter({
  String freshness = 'FRESH',
  int projects = 2,
  List<Map<String, Object?>>? tiles,
  String? unitId,
}) =>
    <String, Object?>{
      'snapshot_id': '3f2b6c1e-0000-4000-8000-0000000000a1',
      'as_of_date': '2026-10-31',
      'treasury_cutoff_date': '2026-10-30',
      'freshness': freshness,
      'definition_status': 'PROPOSED_PENDING_SIGNOFF',
      'scope': <String, Object?>{'unit_id': unitId, 'projects': projects, 'scope_hash': 'hash-1'},
      'tiles': tiles ??
          <Map<String, Object?>>[
            tile('DISBURSEMENT_RATE_PM', value: '14.0000', numerator: '140000000', denominator: '1000000000'),
            tile('DISBURSEMENT_RATE_TOTAL', value: '12.5000', numerator: '140000000', denominator: '1120000000'),
            tile('DISBURSED_TREASURY', value: '140000000', unit: 'VND'),
          ],
      'projects_without_data': 1,
      'open_warnings': 3,
      'overdue_explanations': 1,
      'pending_reallocations': 2,
      'quality_badge': 'OK',
    };

Map<String, Object?> workItem(String id, String kind, String bucket, {String? dueOn = '2026-11-05', String? original, int late = 0, String screen = 'DIS-03', String title = 'Báo cáo tuần 44'}) => <String, Object?>{
      'id': id,
      'kind': kind,
      'title': title,
      'subtitle': 'Dự án đường vành đai',
      'status': 'OPEN',
      'due_on': dueOn,
      'original_due_on': original ?? dueOn,
      'bucket': bucket,
      'days_late': late,
      'target': <String, Object?>{'screen': screen, 'id': id},
    };

Map<String, Object?> myWork(List<Map<String, Object?>> items, {bool truncated = false}) => <String, Object?>{
      'items': items,
      'counts': <String, Object?>{'total': items.length, 'overdue': items.where((Map<String, Object?> item) => item['bucket'] == 'OVERDUE').length, 'APPROVAL': items.where((Map<String, Object?> item) => item['kind'] == 'APPROVAL').length},
      'next_cursor': null,
      'truncated': truncated,
    };

Map<String, Object?> appropriation(String id, String category, String origin, String amount, {int year = 2026, String status = 'PUBLISHED', String? relation}) => <String, Object?>{
      'id': id,
      'fund_source': <String, Object?>{'version_id': 'v-$id', 'business_key': '$category-$id', 'label': category, 'category': category, 'relation': relation, 'valid_from': '2026-01-01'},
      'origin': origin,
      'plan_year': year,
      'amount_vnd': amount,
      'status': status,
    };

Map<String, Object?> allocationLine(String appropriationId, String ctmtqg, {String status = 'PUBLISHED'}) => <String, Object?>{
      'id': 'line-$appropriationId',
      'plan_status': status,
      'appropriation': <String, Object?>{'id': appropriationId},
      'ctmtqg_subset_vnd': ctmtqg,
    };

Map<String, Object?> page(List<Object?> items, {String? next}) => <String, Object?>{'items': items, 'next_cursor': next};
