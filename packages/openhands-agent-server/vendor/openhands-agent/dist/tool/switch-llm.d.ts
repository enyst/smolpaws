import { z } from 'zod';
import { ToolDefinition } from './index.js';
export declare const switchLLMActionSchema: z.ZodObject<{
    profile_name: z.ZodString;
    reason: z.ZodString;
}, z.core.$strict>;
export declare const switchLLMObservationSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodLiteral<"SwitchLLMObservation">>;
    content: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodObject<{
        cache_prompt: z.ZodDefault<z.ZodBoolean>;
        enable_truncation: z.ZodOptional<z.ZodBoolean>;
        type: z.ZodDefault<z.ZodLiteral<"text">>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodTransform<{
        cache_prompt: boolean;
        type: "text";
        text: string;
    }, {
        cache_prompt: boolean;
        type: "text";
        text: string;
        enable_truncation?: boolean | undefined;
    }>>>>;
    is_error: z.ZodDefault<z.ZodBoolean>;
    profile_name: z.ZodString;
    reason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    active_model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type SwitchLLMAction = z.infer<typeof switchLLMActionSchema>;
export type SwitchLLMObservation = z.infer<typeof switchLLMObservationSchema>;
export interface SwitchLLMToolOptions {
    readonly profileNames: readonly string[];
    /**
     * Resolve and accept the selection for the next LLM call. A host queuing a
     * step-boundary replacement must durably save it before returning, and must
     * not await the current step (which is awaiting this tool). Hosts own profile
     * storage, credentials, and safe error messages.
     */
    readonly switchProfile?: (profileName: string) => Promise<{
        model: string;
    }> | {
        model: string;
    };
}
export declare class SwitchLLMTool {
    static readonly className = "SwitchLLMTool";
    static create(options?: SwitchLLMToolOptions): ToolDefinition<typeof switchLLMActionSchema, typeof switchLLMObservationSchema>;
}
