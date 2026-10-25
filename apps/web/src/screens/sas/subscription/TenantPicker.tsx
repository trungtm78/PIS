import type { TenantChoice } from './hooks';

interface Props {
  id: string;
  label: string;
  moreLabel: string;
  choice: TenantChoice;
}

/** The select that names the tenant a control-plane screen works on; it stays outside the state boundary, so a failed read never takes the way to another tenant with it. */
export function TenantPicker({ id, label, moreLabel, choice }: Props) {
  return (
    <div className="card">
      <div className="filters">
        <div>
          <label htmlFor={id}>{label}</label>
          <select id={id} value={choice.chosen ?? ''} onChange={(event) => choice.choose(event.target.value)}>
            {choice.options.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.code === '' ? tenant.name : `${tenant.name} (${tenant.code})`}
              </option>
            ))}
          </select>
          {choice.hasNextPage ? (
            <button type="button" disabled={choice.isFetchingNextPage} onClick={choice.fetchNextPage}>
              {moreLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
