import type { CapabilityCommand, DeviceId } from "@supreme/domain-model";
import type {
  AssistantContext,
  AssistantDevice,
  AssistantRequest,
  AssistantResult,
  ProposedCommand,
} from "./types.js";

/**
 * Deterministic NL → Supreme-DSL planner (§10). It resolves device/room names from
 * the home context and proposes a draft (commands / scene / automation) the user
 * confirms. It is intentionally rule-based so the AI assistant works fully offline;
 * a local LLM can replace `plan()` behind the same interface for richer language.
 */
const LIGHTING = new Set(["light", "dimmer", "color_light"]);

export function plan(req: AssistantRequest): AssistantResult {
  const u = req.utterance.toLowerCase().trim();
  const ctx = req.context;

  // 1. Automation? (has a trigger clause)
  const trigger = parseTrigger(u, ctx);
  if (trigger) {
    const actionClause = u.replace(/^.*?\b(then|,|turn|set|dim|lock|unlock|open|close|activate)\b/, "$1");
    const cmds = buildCommands(actionClause, ctx);
    if (cmds.length > 0) {
      return {
        kind: "automation",
        summary: `Automation: ${describe(trigger)} → ${cmds.length} action(s)`,
        name: titleCase(stripTrigger(u)) || "New Automation",
        triggers: [trigger.trigger],
        actions: cmds.map((c) => ({ type: "device_command", deviceId: c.deviceId as DeviceId, command: c.command })),
      };
    }
  }

  // 2. Scene? (explicit "scene")
  if (/\bscene\b/.test(u)) {
    const cmds = buildCommands(u, ctx);
    if (cmds.length > 0) {
      return {
        kind: "scene",
        summary: `Scene with ${cmds.length} step(s)`,
        name: sceneName(u),
        steps: cmds.map((c) => {
          const { capability, ...values } = c.command;
          return { deviceId: c.deviceId as DeviceId, capability, values };
        }),
      };
    }
  }

  // 3. Immediate commands.
  const cmds = buildCommands(u, ctx);
  if (cmds.length > 0) {
    return {
      kind: "actions",
      summary: cmds.map((c) => `${c.deviceName}: ${describeCmd(c.command)}`).join("; "),
      commands: cmds,
    };
  }

  return {
    kind: "answer",
    summary: "I couldn't find a matching device or action. Try naming a room or device.",
  };
}

// ── targets ──────────────────────────────────────────────────────────────────

function resolveTargets(u: string, ctx: AssistantContext): AssistantDevice[] {
  const wantLights = /\blights?\b/.test(u);
  if (/\b(all|every)\b[^.]*\blights?\b/.test(u)) {
    return ctx.devices.filter((d) => LIGHTING.has(d.supremeType));
  }
  const out: AssistantDevice[] = [];
  for (const room of ctx.rooms) {
    if (u.includes(room.name.toLowerCase())) {
      const roomDevs = ctx.devices.filter((d) => d.roomId === room.id);
      out.push(...(wantLights ? roomDevs.filter((d) => LIGHTING.has(d.supremeType)) : roomDevs));
    }
  }
  for (const d of ctx.devices) {
    if (u.includes(d.name.toLowerCase())) out.push(d);
  }
  const unique = [...new Map(out.map((d) => [d.id, d])).values()];
  if (unique.length === 0 && wantLights) return ctx.devices.filter((d) => LIGHTING.has(d.supremeType));
  return unique;
}

// ── command building ─────────────────────────────────────────────────────────

function buildCommands(u: string, ctx: AssistantContext): ProposedCommand[] {
  const targets = resolveTargets(u, ctx);
  const action = detectAction(u);
  const level = parseLevel(u);
  const out: ProposedCommand[] = [];
  for (const d of targets) {
    const command = commandFor(d, action, level);
    if (command) out.push({ deviceId: d.id, deviceName: d.name, command });
  }
  return out;
}

type Action = "on" | "off" | "toggle" | "dim" | "lock" | "unlock" | "open" | "close" | undefined;

function detectAction(u: string): Action {
  if (/\bunlock\b/.test(u)) return "unlock";
  if (/\block\b/.test(u)) return "lock";
  if (/\bopen\b/.test(u)) return "open";
  if (/\bclose\b/.test(u)) return "close";
  if (/\b(turn off|switch off|off)\b/.test(u)) return "off";
  if (/\b(turn on|switch on|on)\b/.test(u)) return "on";
  if (/\b(dim|set|brightness)\b/.test(u)) return "dim";
  if (/\btoggle\b/.test(u)) return "toggle";
  return undefined;
}

function parseLevel(u: string): number | undefined {
  const pct = u.match(/(\d{1,3})\s*%/);
  if (pct) return clampPct(Number(pct[1]));
  const to = u.match(/\b(?:to|at)\s+(\d{1,3})\b/);
  if (to && /\b(dim|set|brightness)\b/.test(u)) {
    const n = Number(to[1]);
    if (n <= 100) return clampPct(n);
  }
  return undefined;
}

function commandFor(d: AssistantDevice, action: Action, level: number | undefined): CapabilityCommand | null {
  const has = (c: string) => d.capabilities.includes(c);
  if ((action === "lock" || action === "unlock") && has("lock")) return { capability: "lock", action };
  if ((action === "open" || action === "close") && has("position")) return { capability: "position", action };
  if (level !== undefined && has("brightness")) return { capability: "brightness", action: "set", level };
  if (action === "dim" && has("brightness")) return { capability: "brightness", action: "set", level: level ?? 30 };
  if (action === "off") return has("brightness") ? { capability: "brightness", action: "off" } : has("onoff") ? { capability: "onoff", action: "off" } : null;
  if (action === "on") return has("brightness") ? { capability: "brightness", action: "on" } : has("onoff") ? { capability: "onoff", action: "on" } : null;
  if (action === "toggle" && has("onoff")) return { capability: "onoff", action: "toggle" };
  return null;
}

// ── triggers (automations) ───────────────────────────────────────────────────

interface ParsedTrigger {
  trigger: import("@supreme/domain-model").AutomationTrigger;
}

function parseTrigger(u: string, ctx: AssistantContext): ParsedTrigger | null {
  const time = parseTime(u);
  if (/\bat\b/.test(u) && time) return { trigger: { type: "time", at: time, days: [] } };
  const every = u.match(/\bevery\s+(\d{1,3})\s*(min|minute|minutes|hour|hours)\b/);
  if (every) {
    const n = Number(every[1]);
    const mins = /hour/.test(every[2]!) ? n * 60 : n;
    return { trigger: { type: "interval", everyMinutes: Math.max(1, mins) } };
  }
  const when = u.match(/\bwhen\s+(.*?)\s+(turns on|turns off|opens|closes|is on|is off)/);
  if (when) {
    const dev = ctx.devices.find((d) => when[1]!.includes(d.name.toLowerCase()));
    if (dev) {
      const on = /on|opens/.test(when[2]!);
      const cap = dev.capabilities.includes("position") && /open|close/.test(when[2]!) ? "position" : "onoff";
      return {
        trigger: {
          type: "device_state",
          deviceId: dev.id as import("@supreme/domain-model").DeviceId,
          capability: cap,
          field: cap === "position" ? "position" : "on",
          op: cap === "position" ? "gt" : "eq",
          value: cap === "position" ? 0 : on,
        },
      };
    }
  }
  return null;
}

function parseTime(u: string): string | undefined {
  if (/\bnoon\b/.test(u)) return "12:00";
  if (/\bmidnight\b/.test(u)) return "00:00";
  const ampm = u.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = ampm[2] ? Number(ampm[2]) : 0;
    const pm = /p/.test(ampm[3]!);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${pad(h)}:${pad(m)}`;
  }
  const h24 = u.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24) return `${pad(Number(h24[1]))}:${h24[2]}`;
  return undefined;
}

// ── misc helpers ─────────────────────────────────────────────────────────────

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
function describe(t: ParsedTrigger): string {
  const tr = t.trigger;
  if (tr.type === "time") return `at ${tr.at}`;
  if (tr.type === "interval") return `every ${tr.everyMinutes}m`;
  return `when ${tr.deviceId} changes`;
}
function describeCmd(c: CapabilityCommand): string {
  if (c.capability === "brightness" && c.action === "set") return `set to ${c.level ?? 0}%`;
  return `${c.capability}:${(c as { action?: string }).action ?? "set"}`;
}
function stripTrigger(u: string): string {
  return u.replace(/\b(at|every|when)\b.*$/, "").trim();
}
function sceneName(u: string): string {
  const named = u.match(/\b(?:called|named)\s+([a-z0-9 ]{2,30})/);
  if (named) return titleCase(named[1]!.trim());
  const before = u.match(/\b([a-z]+)\s+scene\b/);
  if (before) return `${titleCase(before[1]!)} Scene`;
  return "New Scene";
}
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
