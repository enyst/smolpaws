import type { Agent } from '../../agent/index.js';
import type { ConversationState } from '../state.js';
/** EXT-SDK-003: host preparation runs only outside a model/tool batch. */
export type AgentStepBoundary = (agent: Agent) => Promise<Agent | void> | Agent | void;
export declare function applyAgentStepBoundary(agent: Agent, state: ConversationState, callback: AgentStepBoundary | undefined): Promise<Agent>;
