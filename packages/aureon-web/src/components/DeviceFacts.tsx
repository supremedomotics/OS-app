export interface DeviceFactRow {
  label: string;
  value: string;
}

export interface DeviceFactsProps {
  rows: DeviceFactRow[];
}

/**
 * The "Information" section of a device detail page (§ Design System — Universal Page
 * Structure): a plain key/value grid. Purely presentational — the caller decides which rows to
 * pass, so "only show fields that exist" stays a per-page decision close to the data instead of
 * being baked in here. Was `devices.tsx`'s own `.dev-facts` grid; now shared so every device
 * detail page can show the same Information section devices.tsx already did.
 */
export function DeviceFacts({ rows }: DeviceFactsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="aureon-facts">
      {rows.map((r) => (
        <div key={r.label}>
          <span className="aureon-facts-k">{r.label}</span>
          <span className="aureon-facts-v">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
