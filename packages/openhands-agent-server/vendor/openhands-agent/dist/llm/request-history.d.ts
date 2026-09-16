import { type Event, type LLMConvertibleEvent } from '../event/index.js';
export declare const LLM_REQUEST_BOUNDARY_KEY = "llm_request_boundary";
/** Persist with the response events, never associate by a provider's reusable response ID. */
export declare function requestBoundaryEvent(inputEventId: string | null, responseEvents: readonly Event[]): Event;
/**
 * Project only retained input events after replaying condensation in durable order.
 * A response precedes users that arrived after its request snapshot. The saved log,
 * public eventsToMessages conversion and unknown legacy causality remain unchanged.
 */
export declare function historyForRequests(view: readonly LLMConvertibleEvent[], history: readonly Event[]): LLMConvertibleEvent[];
