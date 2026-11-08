import { useTranslation } from '../i18n';

export interface TablePagerProps {
  from: number;
  to: number;
  total: number;
  size: number;
  /** Zero-based index of the current page. */
  index: number;
  onPage: (index: number) => void;
  onSize: (size: number) => void;
}

const SIZES = [10, 20, 50, 100];
const WINDOW = 2;

/** The footer of a table: "Showing a to b of n", the page size and the page buttons. */
export function TablePager({ from, to, total, size, index, onPage, onSize }: TablePagerProps) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  const first = Math.max(0, Math.min(index - WINDOW, pages - 1 - WINDOW * 2));
  const last = Math.min(pages - 1, first + WINDOW * 2);
  const numbers: number[] = [];
  for (let page = first; page <= last; page += 1) numbers.push(page);
  const sizes = SIZES.includes(size) ? SIZES : [...SIZES, size].sort((a, b) => a - b);
  return (
    <div className="ui-pager">
      <span className="ui-pager__range">{t('ui.tablePager.range', { from, to, total })}</span>
      <label className="ui-pager__size">
        <span className="ui-sr-only">{t('ui.tablePager.size')}</span>
        <select value={size} onChange={(event) => onSize(Number(event.target.value))}>
          {sizes.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <nav className="ui-pager__nav" aria-label={t('ui.tablePager.nav')}>
        <button type="button" className="ui-pager__button" aria-label={t('ui.tablePager.prev')} disabled={index <= 0} onClick={() => onPage(index - 1)}>
          ‹
        </button>
        {numbers.map((page) => (
          <button
            type="button"
            key={page}
            className="ui-pager__button"
            aria-label={t('ui.tablePager.page', { page: page + 1 })}
            aria-current={page === index ? 'page' : undefined}
            onClick={() => onPage(page)}
          >
            {page + 1}
          </button>
        ))}
        <button type="button" className="ui-pager__button" aria-label={t('ui.tablePager.next')} disabled={index >= pages - 1} onClick={() => onPage(index + 1)}>
          ›
        </button>
      </nav>
    </div>
  );
}
