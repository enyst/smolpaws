import { type Event } from '../event/index.js';
import { type LLMCompletionResponse } from '../llm/client.js';
import { type Message } from '../llm/index.js';
import { ConversationState, ParallelToolExecutor, type ToolRunner } from '../conversation/index.js';
export declare const llmResponseType: {
    readonly TOOL_CALLS: "tool_calls";
    readonly CONTENT: "content";
    readonly REASONING_ONLY: "reasoning_only";
    readonly EMPTY: "empty";
};
export type LLMResponseType = (typeof llmResponseType)[keyof typeof llmResponseType];
export interface DispatchLlmResponseOptions {
    readonly llmResponseId?: string | null;
    readonly maxConcurrency?: number;
    readonly executor?: ParallelToolExecutor;
}
export declare function classifyResponse(message: Message): LLMResponseType;
export declare function dispatchLlmResponse(response: LLMCompletionResponse, state: ConversationState, runner: ToolRunner, options?: DispatchLlmResponseOptions): Promise<readonly Event[]>;
