import { Navigate, useParams } from 'react-router-dom';
import { detailPathOf } from '../screens/not/InboxScreen';
import { NotFound } from './NotFound';

/** The shape of the opaque link of a push (`/r/{notification_id}`, the same as the kernel's `OPAQUE_LINK`): an id and nothing else. */
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The link a push carries (ST-NOT-007): it names the notification and nothing about what it is about. Opening it goes to the details of that notification (NOT-02), which asks the server for it with the session of the
 * person: a signed-out person is sent through the sign-in first by the shell, and a notification that is not theirs, or whose record they may no longer read, is refused by the server, not by this link.
 */
export function OpaqueLink() {
  const { id } = useParams();
  if (id === undefined || !NOTIFICATION_ID.test(id)) return <NotFound />;
  return <Navigate to={detailPathOf(id)} replace />;
}
