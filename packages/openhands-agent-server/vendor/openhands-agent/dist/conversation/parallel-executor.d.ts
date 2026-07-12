import { type ActionEvent, type Event } from '../event/index.js';
import type { CancellationToken } from './state.js';
export type ToolRunner = (action: ActionEvent) => readonly Event[] | Promise<readonly Event[]>;
export interface ParallelToolExecutorOptions {
    readonly maxConcurrency?: number;
}
export interface ExecuteBatchOptions {
    readonly cancelToken?: CancellationToken | null;
}
export declare class ParallelToolExecutor {
    readonly maxConcurrency: number;
    constructor(options?: ParallelToolExecutorOptions);
    executeBatch(actions: readonly ActionEvent[], runner: ToolRunner, options?: ExecuteBatchOptions): Promise<readonly (readonly Event[])[]>;
    private runSafe;
}
