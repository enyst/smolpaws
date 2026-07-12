import type { Condensation } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { View } from './view.js';
export type CondenserResult = View | Condensation;
export type CondensationRequirement = 'hard' | 'soft';
export declare const condensationRequirement: {
    readonly HARD: "hard";
    readonly SOFT: "soft";
};
export interface Condenser {
    condense(view: View, agentLlm?: LLMClient | null): CondenserResult;
    handlesCondensationRequests?(): boolean;
}
export declare class NoCondensationAvailableError extends Error {
}
export declare abstract class RollingCondenser implements Condenser {
    abstract condensationRequirement(view: View, agentLlm?: LLMClient | null): CondensationRequirement | null;
    abstract getCondensation(view: View, agentLlm?: LLMClient | null): Condensation;
    hardContextReset(_view: View, _agentLlm?: LLMClient | null): Condensation | null;
    condense(view: View, agentLlm?: LLMClient | null): CondenserResult;
}
export declare class NoOpCondenser implements Condenser {
    condense(view: View): View;
    handlesCondensationRequests(): boolean;
}
export declare class PipelineCondenser implements Condenser {
    readonly condensers: readonly Condenser[];
    constructor(condensers: readonly Condenser[]);
    condense(view: View, agentLlm?: LLMClient | null): CondenserResult;
    handlesCondensationRequests(): boolean;
}
