import type { Context } from '@deepseek-ai/cordis';
import { type GenerationInfo, type SnapshotQuery, type SnapshotV1 } from './contracts';
export interface SnapshotProvider {
    snapshot(query: SnapshotQuery): Promise<SnapshotV1>;
    /** Cheap read of the store generations that invalidate every cached snapshot. */
    getGeneration(): Promise<GenerationInfo>;
}
export declare function registerSnapshotRoute(ctx: Context, provider: SnapshotProvider): () => void;
//# sourceMappingURL=snapshot-route.d.ts.map