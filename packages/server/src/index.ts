/**
 * @orgloop/server — OrgLoop HTTP API Server
 *
 * Re-exports core engine and REST API registration.
 */

export type { ApiHandler, EventHistoryOptions, EventRecord, RouteStats } from '@orgloop/core';
export { OrgLoop, registerRestApi } from '@orgloop/core';
