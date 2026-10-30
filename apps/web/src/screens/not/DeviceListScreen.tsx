import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import './delivery/delivery.css';
import { useDevices } from './device/hooks';
import { PLATFORMS, READ_PERMISSION, STATUSES, canReceivePush, shortId } from './device/model';
import type { DevicePage, DeviceView } from './device/model';


/**
 * NOT-14: the push devices of the tenant. For each device the operator sees the member it belongs to (a short id), the platform, the hint of its public id, whether the operating system allowed push, the version of the
 * app, when it was last seen, and whether it is registered or was removed (with the reason). Never the push token, the reference to it or the whole public id of the device. A removed device is history: it is never pushed to.
 */
export default function DeviceListScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const platformLabel = (platform: string): string => (platform === 'ios' ? t('not.device.platform.ios') : platform === 'android' ? t('not.device.platform.android') : platform === 'web' ? t('not.device.platform.web') : platform);
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const pages = useDevices({ status, platform }, canRead);
  const items: DeviceView[] = ((pages.data?.pages ?? []) as DevicePage[]).flatMap((page) => page.items);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data });
  // Without the right nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  const day = (value: string): string => instantText(locale, value);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.device.page.title')}</h1>
          <p>{t('not.device.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('not.device.rule.text')}</p>
        <div className="filters">
          <div>
            <label htmlFor="device-status">{t('not.device.filter.status.label')}</label>
            <select id="device-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t('not.device.filter.all')}</option>
              {STATUSES.map((name) => (
                <option key={name} value={name}>
                  {name === 'Active' ? t('not.device.status.active') : t('not.device.status.revoked')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="device-platform">{t('not.device.filter.platform.label')}</label>
            <select id="device-platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
              <option value="">{t('not.device.filter.all')}</option>
              {PLATFORMS.map((name) => (
                <option key={name} value={name}>
                  {platformLabel(name)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('not.device.list.none')}
            </p>
          ) : (
            <div className="tablewrap">
              <table data-devices>
                <thead>
                  <tr>
                    <th>{t('not.device.col.device')}</th>
                    <th>{t('not.device.col.member')}</th>
                    <th>{t('not.device.col.platform')}</th>
                    <th>{t('not.device.col.permission')}</th>
                    <th>{t('not.device.col.app')}</th>
                    <th>{t('not.device.col.seen')}</th>
                    <th>{t('not.device.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((device) => (
                    <tr key={device.id} data-device-id={device.id} data-status={device.status}>
                      <td>
                        <code>{device.deviceHint}</code>
                      </td>
                      <td>
                        <code>{shortId(device.membershipId)}</code>
                      </td>
                      <td>{platformLabel(device.platform)}</td>
                      <td data-permission={device.permissionState}>
                        {device.permissionState === 'granted'
                          ? t('not.device.permission.granted')
                          : device.permissionState === 'provisional'
                            ? t('not.device.permission.provisional')
                            : device.permissionState === 'denied'
                              ? t('not.device.permission.denied')
                              : t('not.device.permission.unknown')}
                      </td>
                      <td>{device.appVersion}</td>
                      <td>{day(device.lastSeenAt)}</td>
                      <td>
                        <span className={device.status === 'Active' ? (canReceivePush(device) ? 'pill' : 'pill warn') : 'pill gray'}>
                          {device.status === 'Active' ? t('not.device.status.active') : t('not.device.status.revoked')}
                        </span>
                        {device.status === 'Revoked' ? (
                          <small className="sub" data-revoke-reason>
                            {' · '}
                            {device.revokedAt === undefined ? '' : day(device.revokedAt)}
                            {device.revokeReason === undefined ? '' : ` · ${device.revokeReason}`}
                          </small>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('not.device.list.more.action')}
              </button>
            </div>
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}
