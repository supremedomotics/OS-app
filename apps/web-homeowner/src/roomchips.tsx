import type { Device } from "@supreme/domain-model";
import { roomChips, type ChipKind } from "./roomsummary.js";
import { Icon } from "./icons.js";

/**
 * The glyph summary of a room — icons first, counts second, so the eye understands before it reads
 * (§ luxury communicates before you read). Renders nothing extra when the room is at rest; the caller
 * shows a calm "resting" dot instead.
 */
const GLYPH: Record<ChipKind, "light" | "climate" | "media" | "fan" | "power" | "cover"> = {
  light: "light",
  climate: "climate",
  media: "media",
  fan: "fan",
  switch: "power",
  cover: "cover",
};

export function RoomChips({ devices }: { devices: Device[] }) {
  const chips = roomChips(devices);
  if (chips.length === 0) {
    return <span className="rc-rest"><span className="rc-rest-dot" />Resting</span>;
  }
  return (
    <span className="rc-row">
      {chips.map((c) => (
        <span className="rc-chip" key={c.kind}>
          <Icon name={GLYPH[c.kind]} size={15} />
          <span className="rc-count">{c.label}</span>
        </span>
      ))}
    </span>
  );
}
