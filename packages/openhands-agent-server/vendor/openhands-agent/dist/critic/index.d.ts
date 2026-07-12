import type { LLMConvertibleEvent } from '../event/index.js';
export interface CriticResultOptions {
    readonly score: number;
    readonly message?: string | null;
    readonly metadata?: Record<string, unknown> | null;
}
export declare class CriticResult {
    static readonly THRESHOLD = 0.5;
    static readonly DISPLAY_THRESHOLD = 0.2;
    readonly score: number;
    readonly message: string | null;
    readonly metadata: Record<string, unknown> | null;
    constructor(options: CriticResultOptions);
    get success(): boolean;
    get starRating(): string;
    visualize(): string;
}
export interface IterativeRefinementConfig {
    readonly success_threshold?: number;
    readonly max_iterations?: number;
}
export interface Critic {
    readonly mode?: 'finish_and_message' | 'all_actions';
    readonly iterative_refinement?: IterativeRefinementConfig | null;
    evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;
}
export declare abstract class CriticBase implements Critic {
    readonly mode: 'finish_and_message' | 'all_actions';
    readonly iterative_refinement: Required<IterativeRefinementConfig> | null;
    constructor(options?: {
        readonly mode?: 'finish_and_message' | 'all_actions';
        readonly iterative_refinement?: IterativeRefinementConfig | null;
    });
    abstract evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;
    getFollowupPrompt(criticResult: CriticResult, iteration: number): string;
    shouldRefine(criticResult: CriticResult): boolean;
}
export declare class PassCritic extends CriticBase {
    evaluate(): CriticResult;
}
export declare class EmptyPatchCritic extends CriticBase {
    evaluate(_events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;
}
export declare class AgentFinishedCritic extends CriticBase {
    evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;
}
