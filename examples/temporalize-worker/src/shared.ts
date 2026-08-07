import { createRoleBasedPermissions } from "@azerothian/utilize";
import type { QueueMap, TemporalizeOptions } from "@azerothian/temporalize";

/**
 * Two roles: `admin` may do anything, `reader` may read but not write. The
 * client uses both so you can watch a denied call come back as a *non-retryable*
 * failure instead of retrying against a wall.
 */
const RULES: any = {
  admin: { model: "allow", field: "allow", mutation: "allow" },
  reader: { mutation: "deny" },
};

// Memoised per role. `resolvePermission` runs on every activity call, and the
// registry caches generated schemas by permission object identity — returning a
// new object each time would throw that cache away.
const cache: { [role: string]: any } = {};

export const TEMPORALIZE_OPTIONS: TemporalizeOptions = {
  queuePrefix: "example",
  /**
   * `context` is opaque to temporalize; it is whatever the caller attached to
   * the activity input. This hook is the only place it is interpreted.
   */
  resolvePermission: (context: any) =>
    (cache[context.role] = cache[context.role] || createRoleBasedPermissions(context.role, RULES, { defaultDeny: false })),
};

/**
 * The queue map, written out by hand.
 *
 * `buildQueueMap(orm, TEMPORALIZE_OPTIONS)` produces exactly this JSON — the
 * worker prints it at startup so you can compare. Hardcoding it here is the
 * point of the example: a client process needs no ormize instance and no
 * database connection to dispatch work, just the names.
 */
export const QUEUE_MAP: QueueMap = {
  byModel: {
    Item: "example.sqlite.Item",
    Task: "example.sqlite.Task",
  },
  byQueue: {
    "example.sqlite.Item": ["Item"],
    "example.sqlite.Task": ["Task"],
  },
};
