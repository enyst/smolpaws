import type { LLMProfile, Message } from './index.js';
export declare const ANTHROPIC_CACHE_CONTROL: {
    readonly type: "ephemeral";
};
/** Python LLM._apply_prompt_caching, applied to request copies, never history. */
export declare function prepareAnthropicPromptCaching(profile: LLMProfile, messages: readonly Message[]): Message[];
/** Apply one profile duration to actual wire breakpoints, including lifted tool results. */
export declare function finalizeAnthropicCacheBreakpoints(profile: LLMProfile, body: Record<string, unknown>): void;
