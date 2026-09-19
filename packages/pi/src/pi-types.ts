import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** pi's AgentMessage union, taken from the context event so we track pi's own definition. */
export type AgentMessage = ContextEvent["messages"][number];
export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
