import { type LLMClient, type LLMCompletionResponse, type LLMUsage } from '../llm/client.js';
import { type LLMProfile, type Message } from '../llm/index.js';
export type TestLLMScriptedMessage = Message | Error;
export type TestLLMScriptedResponse = LLMCompletionResponse | Error;
export interface TestLLMOptions {
    readonly profile?: LLMProfile;
    readonly scriptedResponses?: readonly (TestLLMScriptedMessage | TestLLMScriptedResponse)[];
    readonly defaultUsage?: LLMUsage | null;
}
export declare class TestLLMExhaustedError extends Error {
    constructor(callCount: number);
}
export declare class TestLLM implements LLMClient {
    readonly profile: LLMProfile;
    private readonly responses;
    private readonly defaultUsage;
    private calls;
    constructor(options?: TestLLMOptions);
    static fromMessages(messages: readonly TestLLMScriptedMessage[], options?: Omit<TestLLMOptions, 'scriptedResponses'>): TestLLM;
    static fromResponses(responses: readonly TestLLMScriptedResponse[], options?: Omit<TestLLMOptions, 'scriptedResponses'>): TestLLM;
    get callCount(): number;
    get remainingResponses(): number;
    complete(_messages: readonly Message[]): Promise<LLMCompletionResponse>;
    private nextResponse;
}
