import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';

export interface FundCell {
  label: string;
  control: ReactNode;
}

export interface FundGroup {
  title: string;
  total?: string;
  cells: FundCell[];
  programme?: { title: string; cells: FundCell[] } | 'na';
}

export interface FundMatrixProps {
  groups: FundGroup[];
}

// The fund-source colours of design.md, in the order of the sources; each is a CSS class so no colour is written here.
const SOURCE_CLASSES = ['ui-fund--year', 'ui-fund--carry', 'ui-fund--other', 'ui-fund--increase'];

function Cells({ cells }: { cells: FundCell[] }) {
  return (
    <div className="ui-fund__cells">
      {cells.map((cell) => (
        <label className="ui-fund__cell" key={cell.label}>
          <span className="ui-fund__cell-label">{cell.label}</span>
          {cell.control}
        </label>
      ))}
    </div>
  );
}

/** The matrix of the fund sources of a plan: one block per source with its cells and, under it, the programme block; at 360 px the blocks and the cells stack. */
export function FundMatrix({ groups }: FundMatrixProps) {
  const { t } = useTranslation();
  return (
    <div className="ui-fund-matrix">
      {groups.map((group, position) => (
        <section className={`ui-fund ${SOURCE_CLASSES[position % SOURCE_CLASSES.length]}`} key={group.title} aria-label={group.title}>
          <header className="ui-fund__head">
            <h3 className="ui-fund__title">{group.title}</h3>
            {group.total !== undefined && <span className="ui-fund__total">{t('ui.fundMatrix.total', { total: group.total })}</span>}
          </header>
          <Cells cells={group.cells} />
          {group.programme === 'na' && <p className="ui-fund__na">{t('ui.fundMatrix.na')}</p>}
          {group.programme !== undefined && group.programme !== 'na' && (
            <div className="ui-fund__programme">
              <h4 className="ui-fund__programme-title">{group.programme.title}</h4>
              <Cells cells={group.programme.cells} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
