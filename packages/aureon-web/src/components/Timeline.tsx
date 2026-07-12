import type { StatusTone } from "./Chip.js";

export interface TimelineEntry {
  key: string;
  icon?: string;
  title: string;
  meta?: string;
  tone?: StatusTone;
}

export interface TimelineProps {
  entries: TimelineEntry[];
}

/**
 * An activity-feed treatment for a device's History (§ Premium Device Experience Library —
 * "replace simple history lists... timelines, activity feed"). Each entry is an icon bubble on
 * a connecting rail plus title/meta — the same shape for automation executions, AI decisions,
 * state changes, or energy readings; callers decide what an entry represents, this only lays
 * the rail out.
 */
export function Timeline({ entries }: TimelineProps) {
  if (entries.length === 0) return null;
  return (
    <div className="aureon-timeline">
      {entries.map((e, i) => (
        <div key={e.key} className="aureon-timeline-row">
          <span className="aureon-timeline-rail">
            <span className={`aureon-timeline-dot${e.tone ? ` aureon-timeline-dot--${e.tone}` : ""}`}>{e.icon ?? "•"}</span>
            {i < entries.length - 1 && <span className="aureon-timeline-line" />}
          </span>
          <span className="aureon-timeline-body">
            <span className="aureon-timeline-title">{e.title}</span>
            {e.meta && <span className="aureon-timeline-meta">{e.meta}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
