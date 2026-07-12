import type { ConversationState } from './state.js';
export interface StuckDetectionThresholds {
    readonly actionObservation?: number;
    readonly actionError?: number;
    readonly monologue?: number;
    readonly alternatingPattern?: number;
}
export declare class StuckDetector {
    readonly state: ConversationState;
    readonly thresholds: Required<StuckDetectionThresholds>;
    constructor(state: ConversationState, thresholds?: StuckDetectionThresholds);
    isStuck(): boolean;
    private hasRepeatingActionObservation;
    private hasRepeatingActionError;
    private hasMonologue;
}
