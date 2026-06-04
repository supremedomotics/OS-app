import type {
  AutomationAction,
  AutomationTrigger,
  CapabilityCommand,
  SceneStep,
} from "@supreme/domain-model";

/**
 * Home context the assistant reasons over. The gateway builds this from the Supreme
 * domain (rooms + devices) — the assistant never sees a backend (HA).
 */
export interface AssistantDevice {
  id: string;
  name: string;
  roomId: string | null;
  supremeType: string;
  capabilities: string[];
}
export interface AssistantRoom {
  id: string;
  name: string;
}
export interface AssistantContext {
  rooms: AssistantRoom[];
  devices: AssistantDevice[];
}

export interface AssistantRequest {
  utterance: string;
  context: AssistantContext;
}

/** A single proposed device command (immediate action draft). */
export interface ProposedCommand {
  deviceId: string;
  deviceName: string;
  command: CapabilityCommand;
}

/**
 * The assistant returns a DRAFT the user confirms before anything is applied
 * (blueprint §10). One of: immediate commands, a scene, an automation, or a
 * plain answer when nothing actionable was understood.
 */
export type AssistantResult =
  | { kind: "actions"; summary: string; commands: ProposedCommand[] }
  | { kind: "scene"; summary: string; name: string; steps: SceneStep[] }
  | {
      kind: "automation";
      summary: string;
      name: string;
      triggers: AutomationTrigger[];
      actions: AutomationAction[];
    }
  | { kind: "answer"; summary: string };
