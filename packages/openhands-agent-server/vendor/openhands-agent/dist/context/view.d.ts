import { type Event, type LLMConvertibleEvent } from '../event/index.js';
export declare class View {
    readonly events: LLMConvertibleEvent[];
    unhandledCondensationRequest: boolean;
    constructor(events?: readonly LLMConvertibleEvent[], unhandledCondensationRequest?: boolean);
    get length(): number;
    appendEvent(event: Event): void;
    static fromEvents(events: readonly Event[]): View;
    private applyCondensation;
}
