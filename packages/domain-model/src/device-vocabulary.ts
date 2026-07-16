/**
 * Universal Device Vocabulary (§ Universal Device Intelligence Engine — "Do NOT hardcode
 * it... every vocabulary should be loaded from configuration"). Pure data, no logic — a
 * plugin/config-driven vocabulary the classification engine (`device-classification.ts`)
 * consumes. Adding a new device type, category, or synonym is a new entry here; it never
 * requires touching the matching/scoring code, exactly like `schema-engine.ts`'s
 * `defineHierarchySchema()` keeps a schema declarative instead of imperative.
 *
 * This is a representative starter vocabulary covering every category the spec names
 * (Lighting, Security, Shading, Access, HVAC, Water, Energy, Media, Sensors, Buttons) —
 * not an exhaustive transcription of every example in the spec. Expanding it (installer
 * vocabularies, company/industry/regional templates, marketplace entries, JSON import) is
 * additive: append `DeviceVocabularyEntry` objects, nothing else changes.
 */

export interface DeviceVocabularyEntry {
  /** Top-level grouping (§ Device Category) — e.g. "Lighting", "Security". */
  category: string;
  /** Specific device type within the category (§ Device Type) — e.g. "Ceiling Light". */
  type: string;
  /** Every phrase that identifies this type, lowercase. Multi-word phrases (e.g.
   * "roller blind") are matched as substrings; single words are matched as tokens.
   * List the most distinctive phrase FIRST — it's used as the canonical explanation. */
  keywords: string[];
  /** Which existing device-detail page this type routes to (§ Canonical Device Type —
   * prepares Priority 3: "never duplicate detail pages"). Must be a page that already
   * exists in `apps/web-homeowner/src/features/*` — this table never invents a new one. */
  canonicalDetailPage: "lighting" | "security" | "curtains" | "climate" | "media" | "sensors" | "fans" | "energy" | "scenes" | "generic";
  /** Icon name from the existing Aureon icon set (`packages/aureon-web/src/components/Icon.tsx`) — never a new icon invented here. */
  icon: string;
  /** Automation-engine grouping this type surfaces under. */
  automationCategory: string;
}

export const DEFAULT_DEVICE_VOCABULARY: DeviceVocabularyEntry[] = [
  // ── Lighting ──────────────────────────────────────────────────────────────────
  { category: "Lighting", type: "Downlight", keywords: ["downlight", "down light", "dl", "recessed light"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Spot Light", keywords: ["spot light", "spotlight", "spot"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Pendant Light", keywords: ["pendant", "hanging light", "hanging lamp", "pendant lamp", "hanging"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Chandelier", keywords: ["chandelier"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "LED Strip", keywords: ["led strip", "strip light", "linear light", "cove light", "cove"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Stretch Ceiling", keywords: ["barrisol", "stretch ceiling"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Wall Light", keywords: ["wall light", "wall lamp"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Track Light", keywords: ["track light", "track lighting"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Garden Light", keywords: ["garden light", "facade light", "flood light", "floodlight"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Stair Light", keywords: ["stair light", "staircase light"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Mirror Light", keywords: ["mirror light"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Reading Light", keywords: ["reading light", "bedside light"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Pool Light", keywords: ["pool light"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Ceiling Light", keywords: ["ceiling light", "ceiling lamp"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },
  { category: "Lighting", type: "Light", keywords: ["light", "lamp", "lighting"], canonicalDetailPage: "lighting", icon: "light", automationCategory: "lighting" },

  // ── Security ──────────────────────────────────────────────────────────────────
  { category: "Security", type: "Main Door Lock", keywords: ["main door lock", "entrance door lock", "front door lock"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },
  { category: "Security", type: "Cupboard Lock", keywords: ["cupboard lock"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },
  { category: "Security", type: "Drawer Lock", keywords: ["drawer lock"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },
  { category: "Security", type: "Magnetic Lock", keywords: ["magnetic lock", "maglock"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },
  { category: "Security", type: "Gate Lock", keywords: ["gate lock", "strike lock"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },
  { category: "Security", type: "Door Lock", keywords: ["door lock", "lock", "latch"], canonicalDetailPage: "security", icon: "security", automationCategory: "security" },

  // ── Shading ───────────────────────────────────────────────────────────────────
  { category: "Shading", type: "Roller Blind", keywords: ["roller blind"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Roman Blind", keywords: ["roman blind"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Venetian Blind", keywords: ["venetian blind"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Blackout Blind", keywords: ["blackout blind"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Blind", keywords: ["blind"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Curtain", keywords: ["curtain"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Awning", keywords: ["awning"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Pergola", keywords: ["pergola"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },
  { category: "Shading", type: "Skylight", keywords: ["skylight"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "shading" },

  // ── Access ────────────────────────────────────────────────────────────────────
  { category: "Access", type: "Sliding Gate", keywords: ["sliding gate"], canonicalDetailPage: "generic", icon: "door", automationCategory: "access" },
  { category: "Access", type: "Swing Gate", keywords: ["swing gate"], canonicalDetailPage: "generic", icon: "door", automationCategory: "access" },
  { category: "Access", type: "Gate", keywords: ["gate"], canonicalDetailPage: "generic", icon: "door", automationCategory: "access" },
  { category: "Access", type: "Garage Door", keywords: ["garage door"], canonicalDetailPage: "generic", icon: "door", automationCategory: "access" },
  { category: "Access", type: "Boom Barrier", keywords: ["boom barrier", "barrier"], canonicalDetailPage: "generic", icon: "door", automationCategory: "access" },
  { category: "Access", type: "Rolling Shutter", keywords: ["rolling shutter", "shutter"], canonicalDetailPage: "curtains", icon: "cover", automationCategory: "access" },

  // ── HVAC ──────────────────────────────────────────────────────────────────────
  { category: "HVAC", type: "Thermostat", keywords: ["thermostat"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },
  { category: "HVAC", type: "Fan Coil", keywords: ["fan coil", "fcu"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },
  { category: "HVAC", type: "VRV", keywords: ["vrv", "vrf"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },
  { category: "HVAC", type: "Damper", keywords: ["damper"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },
  { category: "HVAC", type: "Fresh Air Unit", keywords: ["fresh air", "ahu", "air handling"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },
  { category: "HVAC", type: "Exhaust Fan", keywords: ["exhaust fan"], canonicalDetailPage: "fans", icon: "fan", automationCategory: "climate" },
  { category: "HVAC", type: "AC", keywords: ["ac", "air conditioning", "air conditioner", "hvac"], canonicalDetailPage: "climate", icon: "climate", automationCategory: "climate" },

  // ── Water ─────────────────────────────────────────────────────────────────────
  { category: "Water", type: "Sprinkler", keywords: ["sprinkler", "irrigation"], canonicalDetailPage: "generic", icon: "sensor", automationCategory: "water" },
  { category: "Water", type: "Valve", keywords: ["valve"], canonicalDetailPage: "generic", icon: "sensor", automationCategory: "water" },
  { category: "Water", type: "Pump", keywords: ["pump"], canonicalDetailPage: "generic", icon: "sensor", automationCategory: "water" },
  { category: "Water", type: "Leak Sensor", keywords: ["leak sensor", "water leak", "leak"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "water" },

  // ── Energy ────────────────────────────────────────────────────────────────────
  { category: "Energy", type: "Energy Meter", keywords: ["energy meter", "power meter"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Gas Meter", keywords: ["gas meter"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Water Meter", keywords: ["water meter"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Solar Meter", keywords: ["solar meter", "solar"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Battery", keywords: ["battery"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "UPS", keywords: ["ups"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Generator", keywords: ["generator"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },
  { category: "Energy", type: "Meter", keywords: ["meter"], canonicalDetailPage: "energy", icon: "energy", automationCategory: "energy" },

  // ── Media ─────────────────────────────────────────────────────────────────────
  { category: "Media", type: "TV", keywords: ["tv", "television"], canonicalDetailPage: "media", icon: "tv", automationCategory: "media" },
  { category: "Media", type: "Projector", keywords: ["projector", "screen"], canonicalDetailPage: "media", icon: "tv", automationCategory: "media" },
  { category: "Media", type: "AVR", keywords: ["avr", "amplifier", "amp"], canonicalDetailPage: "media", icon: "speaker", automationCategory: "media" },
  { category: "Media", type: "Speaker", keywords: ["speaker", "subwoofer", "music zone"], canonicalDetailPage: "media", icon: "speaker", automationCategory: "media" },

  // ── Sensors ───────────────────────────────────────────────────────────────────
  { category: "Sensors", type: "Temperature Sensor", keywords: ["temperature", "temp sensor"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Humidity Sensor", keywords: ["humidity"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Motion Sensor", keywords: ["motion"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Occupancy Sensor", keywords: ["occupancy", "presence"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Smoke Detector", keywords: ["smoke"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Heat Sensor", keywords: ["heat sensor"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "CO Sensor", keywords: ["co sensor", "carbon monoxide"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "CO2 Sensor", keywords: ["co2", "co₂"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "VOC Sensor", keywords: ["voc"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Door Sensor", keywords: ["door contact", "door sensor"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Window Sensor", keywords: ["window contact", "window sensor"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Rain Sensor", keywords: ["rain"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Wind Sensor", keywords: ["wind"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Lux Sensor", keywords: ["lux", "illuminance"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Pressure Sensor", keywords: ["pressure"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Level Sensor", keywords: ["level sensor"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Current Sensor", keywords: ["current"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Voltage Sensor", keywords: ["voltage"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },
  { category: "Sensors", type: "Frequency Sensor", keywords: ["frequency"], canonicalDetailPage: "sensors", icon: "sensor", automationCategory: "sensors" },

  // ── Buttons ───────────────────────────────────────────────────────────────────
  { category: "Buttons", type: "Scene Button", keywords: ["scene"], canonicalDetailPage: "scenes", icon: "switch", automationCategory: "buttons" },
  { category: "Buttons", type: "Bell", keywords: ["bell", "doorbell"], canonicalDetailPage: "generic", icon: "switch", automationCategory: "buttons" },
  { category: "Buttons", type: "Emergency Button", keywords: ["emergency button", "panic button", "sos"], canonicalDetailPage: "generic", icon: "switch", automationCategory: "buttons" },
  { category: "Buttons", type: "Push Button", keywords: ["push button", "pushbutton", "button"], canonicalDetailPage: "generic", icon: "switch", automationCategory: "buttons" },

  // ── Fallback ──────────────────────────────────────────────────────────────────
  { category: "Other", type: "Switch", keywords: ["switch", "switching", "sw"], canonicalDetailPage: "generic", icon: "switch", automationCategory: "other" },
  { category: "Other", type: "Socket", keywords: ["socket", "outlet", "plug"], canonicalDetailPage: "generic", icon: "plug", automationCategory: "other" },
  { category: "Other", type: "Relay", keywords: ["relay"], canonicalDetailPage: "generic", icon: "switch", automationCategory: "other" },
];
