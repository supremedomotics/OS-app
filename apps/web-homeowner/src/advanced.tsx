import { useEffect, useState } from "react";
import {
  applyCircadian,
  getAllDevices,
  getCircadian,
  getClimateProgram,
  getDeferrableLoads,
  getEnergyProvider,
  getTariff,
  getVentilation,
  setClimateProgram,
  setDeferrableLoads,
  setEnergyProvider,
  setTariff,
  setVentilation,
  type ClimateBlock,
  type DeviceLite,
  type Tariff,
} from "./api.js";

/**
 * Advanced settings (§10/§16): the "pro" hub functions that used to be API-only are now
 * point-and-click — circadian lighting, the climate schedule, adaptive ventilation, the energy
 * tariff, the electricity provider/rate, and peak load-shifting. Each panel loads its current state,
 * edits it, and saves back through the Supreme API (no Home Assistant awareness).
 */
export function AdvancedSettings() {
  return (
    <section className="card-section">
      <h2 className="section-title">Advanced</h2>
      <p className="muted" style={{ marginTop: -4 }}>Automation &amp; energy tuning. Optional — sensible defaults apply until you set these.</p>
      <CircadianPanel />
      <ClimatePanel />
      <VentilationPanel />
      <TariffPanel />
      <ProviderPanel />
      <LoadShiftPanel />
    </section>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="adv-panel">
      <button className="adv-head" onClick={() => setOpen((v) => !v)}>
        <span className="adv-caret">{open ? "▾" : "▸"}</span>
        <span className="adv-title">{title}</span>
        {subtitle && <span className="adv-sub">{subtitle}</span>}
      </button>
      {open && <div className="adv-body">{children}</div>}
    </div>
  );
}

function Saved({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <p className={msg.ok ? "muted" : "err"}>{msg.text}</p> : null;
}

const mins = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const parseMins = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

// ── Circadian lighting ─────────────────────────────────────────────────────────
function CircadianPanel() {
  const [target, setTarget] = useState<{ kelvin: number; brightness: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void getCircadian().then((r) => setTarget(r?.target ?? null)); }, []);

  async function apply() {
    setBusy(true); setMsg(null);
    try { const r = await applyCircadian(); setMsg({ ok: true, text: `Applied to ${r.applied.length} light${r.applied.length === 1 ? "" : "s"}.` }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Circadian lighting" subtitle="Human-centric white">
      <p className="muted">Right now the natural target is <strong>{target ? `${target.kelvin}K` : "—"}</strong> at <strong>{target ? `${Math.round(target.brightness)}%` : "—"}</strong> brightness. Apply it to every colour light in the home.</p>
      <button className="primary" disabled={busy} onClick={apply}>{busy ? "Applying…" : "Apply circadian now"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}

// ── Climate schedule ───────────────────────────────────────────────────────────
function ClimatePanel() {
  const [weekday, setWeekday] = useState<ClimateBlock[]>([]);
  const [weekend, setWeekend] = useState<ClimateBlock[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getClimateProgram().then((r) => {
      setWeekday(r.program?.weekday ?? [{ atMinutes: 6 * 60, targetC: 21 }, { atMinutes: 22 * 60, targetC: 18 }]);
      setWeekend(r.program?.weekend ?? [{ atMinutes: 8 * 60, targetC: 21 }, { atMinutes: 23 * 60, targetC: 18 }]);
    });
  }, []);

  const editList = (list: ClimateBlock[], set: (b: ClimateBlock[]) => void) => (
    <div className="adv-blocks">
      {list.map((b, i) => (
        <div className="adv-block" key={i}>
          <input type="time" value={mins(b.atMinutes)} onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, atMinutes: parseMins(e.target.value) } : x)))} />
          <input type="number" min={5} max={35} step={0.5} value={b.targetC} onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, targetC: Number(e.target.value) } : x)))} />
          <span className="unit">°C</span>
          <button className="adv-x" onClick={() => set(list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => set([...list, { atMinutes: 12 * 60, targetC: 20 }])}>+ Add block</button>
    </div>
  );

  async function save() {
    setBusy(true); setMsg(null);
    try { await setClimateProgram({ weekday, weekend }); setMsg({ ok: true, text: "Climate schedule saved." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Climate schedule" subtitle="Programmable thermostat">
      <p className="opt-label">Weekday</p>
      {editList(weekday, setWeekday)}
      <p className="opt-label" style={{ marginTop: 10 }}>Weekend</p>
      {editList(weekend, setWeekend)}
      <button className="primary" disabled={busy} onClick={save} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save schedule"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}

// ── Ventilation ────────────────────────────────────────────────────────────────
function VentilationPanel() {
  const [devices, setDevices] = useState<DeviceLite[]>([]);
  const [sensor, setSensor] = useState("");
  const [fan, setFan] = useState("");
  const [high, setHigh] = useState("");
  const [low, setLow] = useState("");
  const [fanOn, setFanOn] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getAllDevices().then((r) => setDevices(r.devices));
    void getVentilation().then((r) => { setFanOn(r.fanOn); if (r.config) { setSensor(r.config.sensorDeviceId); setFan(r.config.fanDeviceId); setHigh(r.config.highThreshold?.toString() ?? ""); setLow(r.config.lowThreshold?.toString() ?? ""); } });
  }, []);
  const sensors = devices.filter((d) => d.capabilities.some((c) => c.kind === "sensor"));
  const fans = devices.filter((d) => d.capabilities.some((c) => ["fan", "onoff"].includes(c.kind)));

  async function save() {
    if (!sensor || !fan) { setMsg({ ok: false, text: "Pick a sensor and a fan." }); return; }
    setBusy(true); setMsg(null);
    try {
      await setVentilation({ sensorDeviceId: sensor, fanDeviceId: fan, ...(high ? { highThreshold: Number(high) } : {}), ...(low ? { lowThreshold: Number(low) } : {}) });
      setMsg({ ok: true, text: "Ventilation configured." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Adaptive ventilation" subtitle={fanOn ? "Fan running" : "Air-quality fan"}>
      <p className="muted">Run a fan automatically when an air-quality sensor reads high.</p>
      <label className="opt-label">Air-quality sensor</label>
      <select value={sensor} onChange={(e) => setSensor(e.target.value)}>
        <option value="">Select a sensor…</option>
        {sensors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <label className="opt-label" style={{ marginTop: 8 }}>Fan</label>
      <select value={fan} onChange={(e) => setFan(e.target.value)}>
        <option value="">Select a fan…</option>
        {fans.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <input type="number" placeholder="Turn on above" value={high} onChange={(e) => setHigh(e.target.value)} />
        <input type="number" placeholder="Turn off below" value={low} onChange={(e) => setLow(e.target.value)} />
      </div>
      <button className="primary" disabled={busy} onClick={save} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save ventilation"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}

// ── Energy tariff ──────────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => i);
function TariffPanel() {
  const [tariff, setT] = useState<Tariff>({ currency: "USD", standingChargePerDay: 0, periods: [{ name: "peak", ratePerKwh: 0.4, hours: [16, 17, 18, 19, 20] }, { name: "off-peak", ratePerKwh: 0.15, hours: HOURS.filter((h) => h < 16 || h > 20) }] });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getTariff().then((r) => { if (r.tariff) setT(r.tariff); }); }, []);

  const toggleHour = (pi: number, h: number) => setT((t) => ({ ...t, periods: t.periods.map((p, i) => i === pi ? { ...p, hours: p.hours.includes(h) ? p.hours.filter((x) => x !== h) : [...p.hours, h].sort((a, b) => a - b) } : p) }));

  async function save() {
    setBusy(true); setMsg(null);
    try { await setTariff(tariff); setMsg({ ok: true, text: "Tariff saved." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Energy tariff" subtitle="Time-of-use rate plan">
      <div className="row" style={{ gap: 8 }}>
        <input style={{ width: 90 }} value={tariff.currency} onChange={(e) => setT({ ...tariff, currency: e.target.value })} placeholder="USD" />
        <input style={{ width: 150 }} type="number" step={0.01} value={tariff.standingChargePerDay ?? 0} onChange={(e) => setT({ ...tariff, standingChargePerDay: Number(e.target.value) })} placeholder="Standing charge/day" />
      </div>
      {tariff.periods.map((p, pi) => (
        <div key={pi} className="adv-tariff">
          <div className="row" style={{ gap: 8 }}>
            <input style={{ width: 120 }} value={p.name} onChange={(e) => setT({ ...tariff, periods: tariff.periods.map((x, i) => i === pi ? { ...x, name: e.target.value } : x) })} />
            <input style={{ width: 110 }} type="number" step={0.01} value={p.ratePerKwh} onChange={(e) => setT({ ...tariff, periods: tariff.periods.map((x, i) => i === pi ? { ...x, ratePerKwh: Number(e.target.value) } : x) })} />
            <span className="unit">/kWh</span>
          </div>
          <div className="adv-hours">
            {HOURS.map((h) => <button key={h} className={p.hours.includes(h) ? "on" : ""} onClick={() => toggleHour(pi, h)}>{h}</button>)}
          </div>
        </div>
      ))}
      <button className="primary" disabled={busy} onClick={save} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save tariff"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}

// ── Electricity provider / flat rate ────────────────────────────────────────────
function ProviderPanel() {
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("");
  const [resolved, setResolved] = useState<{ ratePerKwh?: number; currency?: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getEnergyProvider().then((r) => { if (r.provider) { setCountry(r.provider.country ?? ""); setCity(r.provider.city ?? ""); setResolved(r.provider); } }); }, []);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await setEnergyProvider({ country, city: city || undefined, ratePerKwh: rate ? Number(rate) : undefined, currency: currency || undefined });
      setResolved(r.provider); setMsg({ ok: true, text: `Rate set: ${r.provider.ratePerKwh} ${r.provider.currency}/kWh.` });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Electricity provider & rate" subtitle={resolved?.ratePerKwh ? `${resolved.ratePerKwh} ${resolved.currency}/kWh` : "Not set"}>
      <p className="muted">Powers the per-room / per-device cost views. Enter your country (a curated rate is used) or a manual rate.</p>
      <div className="row" style={{ gap: 8 }}>
        <input placeholder="Country (e.g. US, IN, AE)" value={country} onChange={(e) => setCountry(e.target.value)} />
        <input placeholder="City (optional)" value={city} onChange={(e) => setCity(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <input type="number" step={0.01} placeholder="Manual rate /kWh (optional)" value={rate} onChange={(e) => setRate(e.target.value)} />
        <input style={{ width: 90 }} placeholder="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
      </div>
      <button className="primary" disabled={busy || (!country && !rate)} onClick={save} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save provider"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}

// ── Peak load-shifting ──────────────────────────────────────────────────────────
function LoadShiftPanel() {
  const [devices, setDevices] = useState<DeviceLite[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ceiling, setCeiling] = useState("");
  const [paused, setPaused] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getAllDevices().then((r) => setDevices(r.devices));
    void getDeferrableLoads().then((r) => { setSelected(r.deviceIds); setPaused(r.pausedNow); });
  }, []);
  const toggle = (id: string) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  async function save() {
    setBusy(true); setMsg(null);
    try { await setDeferrableLoads(selected, ceiling ? Number(ceiling) : undefined); setMsg({ ok: true, text: "Load-shifting saved." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Peak load-shifting" subtitle={paused.length ? `${paused.length} paused now` : "Deferrable loads"}>
      <p className="muted">Devices the hub may pause during peak-rate hours (e.g. water heater, EV charger, pool pump).</p>
      <div className="adv-devices">
        {devices.map((d) => (
          <label key={d.id} className={`adv-chip${selected.includes(d.id) ? " on" : ""}`}>
            <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} />
            {d.name}
          </label>
        ))}
      </div>
      <label className="opt-label" style={{ marginTop: 8 }}>Only pause when the rate is above (optional)</label>
      <input type="number" step={0.01} placeholder="/kWh ceiling" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
      <button className="primary" disabled={busy} onClick={save} style={{ marginTop: 10 }}>{busy ? "Saving…" : "Save load-shifting"}</button>
      <Saved msg={msg} />
    </Panel>
  );
}
