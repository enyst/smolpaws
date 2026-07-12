import { ConversationState } from './state.js';
export interface DroppedEventFields {
    readonly index: number;
    readonly fields: readonly string[];
}
export interface ConversationRestoreResult {
    readonly state: ConversationState;
    readonly droppedStateFields: readonly string[];
    readonly droppedEventFields: readonly DroppedEventFields[];
}
export declare function restoreConversationState(payload: unknown): ConversationRestoreResult;
