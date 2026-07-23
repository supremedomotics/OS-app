/**
 * AVR (Denon/Marantz) HTTP AppCommand codec (§ Universal AVR SDK). Denon/Marantz publish
 * an ASCII Telnet protocol (see `avr-codec.ts`), but ALSO expose a second, real HTTP
 * control interface (`/goform/AppCommand.xml`, port 8080 on 2016+ models) — used by
 * Denon's own iOS/Android apps and web UI. It is not officially documented the way the
 * Telnet spec is, but it is universally reverse-engineered and stable enough that Home
 * Assistant's own `denonavr` integration is built on it. This codec covers ONLY commands
 * whose exact XML request/response shape was independently verified by fetching and
 * reading `denonavr`'s actual source this session (`appcommand.py`'s real `AppCommands`
 * enum, `input.py`'s actual parsing code, `api.py`'s actual request-body builder) —
 * nothing here is guessed.
 *
 * This is the ONE real, evidenced gap Telnet cannot fill: renamed input labels and
 * hidden/deleted inputs (Telnet's `SI` table has no rename/delete query, confirmed in a
 * prior sprint). Deliberately narrow — several commands initially believed usable turned
 * out not to be once verified against the real source, and were cut rather than guessed:
 *
 * - `GetSoundModeList` does not exist in `denonavr`'s real, complete `AppCommands` enum.
 *   Neither Telnet nor AppCommand can enumerate a unit's supported sound modes.
 * - Now-playing title/artist/album has no verified XML tag anywhere — not even in a
 *   dedicated XML-dump tool by the same author whose only job is enumerating these
 *   fields. Left unimplemented rather than guessed.
 * - `GetAudyssey`/`SetAudysseyDynamicEQ`/`SetAudysseyMultiEQ`/`SetAudysseyReflevoffset`/
 *   `SetAudysseyDynamicvol` (all real command names, cmd_id "3") have no verified
 *   parameter encoding — a wrong guess on a write command here could misconfigure a real
 *   receiver's speaker calibration, so these stay unimplemented, not gated-guessed.
 *
 * Album art is NOT parsed from any XML at all — `albumArtUrl()` builds a literal, real,
 * static URL string (confirmed via `denonavr/const.py`'s actual string constants), no
 * schema involved.
 */

/** Real request-body shape confirmed via `denonavr/api.py`'s actual
 * `prepare_appcommand_body()`: `<tx><cmd id="…">CommandText</cmd>…</tx>`. Denon's
 * AppCommand.xml genuinely errors above 5 `<cmd>` elements per request (a real,
 * documented limit, not a guess) — batched defensively even though this codec's own two
 * real commands both fit in one request today. */
const MAX_COMMANDS_PER_REQUEST = 5;

export interface AppCommandRequest {
  /** `"1"` for AppCommand.xml-family commands (everything this codec uses); `"3"` is
   * AppCommand0300.xml's family (Audyssey et al.) and is not used by this codec since
   * none of those commands have a verified parameter encoding to send yet. */
  id: "1" | "3";
  text: string;
}

/** Build one or more `<tx>` request bodies, chunked at the real 5-command cap. Almost
 * always returns a single-element array for this codec's real usage (2 commands). */
export function buildAppCommandRequests(commands: AppCommandRequest[]): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < commands.length; i += MAX_COMMANDS_PER_REQUEST) {
    const chunk = commands.slice(i, i + MAX_COMMANDS_PER_REQUEST);
    const cmds = chunk.map((c) => `<cmd id="${c.id}">${escapeXml(c.text)}</cmd>`).join("");
    bodies.push(`<?xml version="1.0" encoding="utf-8"?><tx>${cmds}</tx>`);
  }
  return bodies;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal, dependency-free XML text extraction — this codec only ever needs flat
 * `<tag>text</tag>` reads inside repeating `<list>` blocks (never attributes, never
 * nested structure beyond one level), so a tiny regex-based reader is honest and
 * sufficient rather than pulling in a full XML parser for two commands. */
function findAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push((m[1] ?? "").trim());
  return out;
}

/** One `<list>` block within `<functionrename>`/`<functiondelete>` — both are flat
 * sibling-tag pairs per list entry, so splitting on `<list>` boundaries and reading each
 * chunk's tags independently handles both shapes with the same helper. */
function listBlocks(xml: string, section: string): string[] {
  const sectionMatch = new RegExp(`<${section}>([\\s\\S]*?)<\\/${section}>`).exec(xml);
  if (!sectionMatch) return [];
  const body = sectionMatch[1] ?? "";
  return body.split("<list>").slice(1).map((chunk) => chunk.split("</list>")[0] ?? "");
}

/** Real shape confirmed via `denonavr/input.py`: `<cmd>/<functionrename>/<list>`
 * containing `<name>` (the wire `SI` token) and `<rename>` (the installer's real,
 * human-set label) per entry. Returns a map of wire-token → renamed label; entries the
 * receiver never renamed simply don't appear (the caller keeps the existing default
 * label for those, exactly as `denonCapabilityConfig()` already does). */
export function parseRenameSource(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of listBlocks(xml, "functionrename")) {
    const name = findAll(block, "name")[0];
    const rename = findAll(block, "rename")[0];
    if (name && rename) out.set(name, rename);
  }
  return out;
}

/** Real shape confirmed via `denonavr/input.py`: `<cmd>/<functiondelete>/<list>`
 * containing `<FuncName>` and `<use>` (`"0"` → hidden/deleted by the installer, `"1"` →
 * still shown) per entry. Returns the set of wire-token inputs the installer has hidden
 * — the caller filters these out of the selectable input list entirely, same as the
 * receiver's own front panel does. */
export function parseDeletedSource(xml: string): Set<string> {
  const out = new Set<string>();
  for (const block of listBlocks(xml, "functiondelete")) {
    const name = findAll(block, "FuncName")[0];
    const use = findAll(block, "use")[0];
    if (name && use === "0") out.add(name);
  }
  return out;
}

/** NOT a parser — builds the literal, real, static album-art URL confirmed via
 * `denonavr/const.py`'s actual string constants. The receiver serves this directly (its
 * own web UI/app use the same path); no XML/schema involved, so there is nothing here
 * that could be "wrong" the way a guessed tag name could be. */
export function albumArtUrl(host: string, port: number): string {
  return `http://${host}:${port}/img/album%20art_S.png`;
}
