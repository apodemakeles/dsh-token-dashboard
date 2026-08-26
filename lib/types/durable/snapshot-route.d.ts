import type { Context } from '@deepseek-ai/cordis';
import { type SnapshotQuery, type SnapshotV1 } from './contracts';
export interface SnapshotProvider {
    /** Query a consistent snapshot of the current store. */
    snapshot(query: SnapshotQuery): Promise<SnapshotV1>;
    /** Current store generation; advances on every committed fact batch and projection state change. */
    revision(): Promise<{
        commitGeneration: number;
        stateGeneration: number;
    }>;
}
export declare function registerSnapshotRoute(ctx: Context, provider: SnapshotProvider): () => void;
//# sourceMappingURL=snapshot-route.d.ts.map