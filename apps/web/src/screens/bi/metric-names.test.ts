import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { metricLabel, metricName } from './metric-names';

describe('the name people read for a metric', () => {
  it('translates the certified metrics of the platform and keeps the code beside the name in a list', () => {
    expect(metricName(translator.t, 'ctr_top5_share')).toBe('Tỷ trọng 5 nhà thầu lớn nhất');
    expect(metricLabel(translator.t, 'ctr_hhi')).toBe('Chỉ số tập trung nhà thầu (HHI) (ctr_hhi)');
    expect(metricLabel(translator.t, 'prj_cpi')).toBe('Chỉ số hiệu quả chi phí (CPI) (prj_cpi)');
  });

  it('falls back to the code for a metric a company defined', () => {
    expect(metricName(translator.t, 't_company_made')).toBe('t_company_made');
    expect(metricLabel(translator.t, 't_company_made')).toBe('t_company_made');
  });
});
