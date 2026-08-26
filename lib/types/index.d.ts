import type { Context } from '@deepseek-ai/cordis';
import { type FlushService } from './durable/collector';
/** Required services: HTTP routes, persistence seam and live session store. */
export declare const inject: string[];
/** Structural view of the live session store used by the flush barrier. */
export interface SessionStoreLike {
    /** Look up a live session by id; `undefined` once the session is disposed. */
    get(id: string): unknown;
    /** Durability checkpoint for one live session. */
    flush(session: unknown): Promise<boolean>;
}
/**
 * Build the collector's source-durability barrier on top of the session store.
 *
 * A session that is no longer live in the store has already persisted its
 * buffered events (the store drains a session before disposal), so its
 * barrier is already met. Projecting its batch via a bare `flush` call would
 * make the store reject the disposed session and the collector would drop
 * the batch with nothing to recover it; live sessions await `flush` as usual.
 */
export declare function createFlushService(sessions: SessionStoreLike): FlushService;
/** Mount the durable projection runtime and the single snapshot route. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map