/**
 * Whether the membership holds a permission as the session lists them; a session that lists none (`undefined`) is unknown and the server decides.
 * A screen offers a control that changes data only to a membership that holds the permission of the command behind it.
 */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);
