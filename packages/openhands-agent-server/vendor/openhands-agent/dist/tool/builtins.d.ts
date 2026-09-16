import { z } from 'zod';
import { ToolDefinition } from './index.js';
export * from './switch-llm.js';
export declare const baseObservationSchema: z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const finishActionSchema: z.ZodObject<{
    message: z.ZodString;
}, z.core.$strict>;
export declare const thinkActionSchema: z.ZodObject<{
    thought: z.ZodString;
}, z.core.$strict>;
export type BaseObservation = z.infer<typeof baseObservationSchema>;
export type FinishAction = z.infer<typeof finishActionSchema>;
export type ThinkAction = z.infer<typeof thinkActionSchema>;
export declare class FinishTool {
    static readonly className = "FinishTool";
    static create(): ToolDefinition<typeof finishActionSchema, typeof baseObservationSchema>;
}
export declare class ThinkTool {
    static readonly className = "ThinkTool";
    static create(): ToolDefinition<typeof thinkActionSchema, typeof baseObservationSchema>;
}
export type BuiltInToolFactory = () => ToolDefinition;
export declare const BUILT_IN_TOOLS: ((() => ToolDefinition<z.ZodObject<{
    message: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>>) | (() => ToolDefinition<z.ZodObject<{
    thought: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    text: z.ZodString;
    is_error: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>>))[];
export declare const BUILT_IN_TOOL_FACTORIES: {
    FinishTool: () => ToolDefinition<z.ZodObject<{
        message: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    ThinkTool: () => ToolDefinition<z.ZodObject<{
        thought: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        text: z.ZodString;
        is_error: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    SwitchLLMTool: () => ToolDefinition<z.ZodObject<{
        profile_name: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
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
    }, z.core.$strict>>;
};
