import type { LLMProfile, Message } from './index.js';
export declare const ANTHROPIC_CACHE_CONTROL: {
    readonly type: "ephemeral";
};
/** Python LLM._apply_prompt_caching, applied to request copies, never history. */
export declare function prepareAnthropicPromptCaching(profile: LLMProfile, messages: readonly Message[]): Message[];
/** Count wire locations, including lifted tool-result markers, not nested data. */
export declare function validateAnthropicCacheBreakpoints(body: Record<string, unknown>): void;
