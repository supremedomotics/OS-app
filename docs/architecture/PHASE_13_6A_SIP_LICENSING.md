# Phase 13.6A — SIP Licensing (Re-verified Against Authoritative Sources)

Supersedes/updates `docs/architecture/PHASE_13_6_SIP_LICENSING.md`'s analysis with direct
verification against pjsip.org and the pjproject GitHub repository this session (not re-derived
from the prior report alone, per this phase's explicit gate). Findings below are sourced; see the
Sources list at the end.

## 1. Core license — verified

The `pjproject` GitHub repository's own declared license (GitHub API `license.spdx_id`) is
**`GPL-2.0`**. pjsip.org's own licensing page independently confirms: PJSIP is licensed under
"General Public License (GPL) version 2 or later," and if an application cannot be released as
open source, the maintainer (Teluu) invites contacting `licensing@teluu.com` to "arrange
alternative licensing." This matches and confirms Phase 13.6's prior conclusion — **not a
re-derivation from that report alone**, but an independent re-check against the primary source.

One secondary (non-authoritative) web-search summary encountered during this verification
incorrectly asserted PJSIP's core license is "Apache 2.0." **This is wrong and was not used** —
it appears to conflate the core `GPL-2.0` project license with several *individually*
Apache-2.0-licensed *bundled third-party components* (see §5: Oboe, Lyra, OpenCore AMR are
Apache-2.0; the core `pjlib`/`pjsip`/`pjmedia`/`pjsua2` code is not). This document relies only on
pjsip.org and the GitHub repository's own license metadata, not on that summary.

## 2. Commercial rights required for SupremeOS

Unchanged conclusion: SupremeOS is closed-source and commercially distributed, so the GPLv2 path
(which would require releasing SupremeOS's own combined-work source) is not viable. A commercial
license, negotiated directly with Teluu (`licensing@teluu.com`), is required. **Not yet
procured.**

## 3. Source/binary redistribution obligations

- Under GPLv2 (not the path taken): source-disclosure obligation for the combined work.
- Under a commercial license: no source-disclosure obligation for SupremeOS's own code; PJSIP's
  own source remains published by Teluu regardless of license path. The exact scope of any
  specific commercial agreement (fees, term, what's covered) is a negotiated contract this
  document cannot substitute for.

## 4. Static linking / Android / iOS redistribution implications

Unchanged from Phase 13.6: PJSIP is conventionally statically linked into the app binary on both
platforms (an NDK-built `.so`/static lib on Android, a static library/`.xcframework` on iOS) —
there is no realistic dynamic-linking-avoids-copyleft argument available here, so the commercial
license is required regardless of linking strategy on either platform.

## 5. Codec and third-party dependency licensing — verified in detail

Directly fetched from PJSIP's own "Third Party Software" documentation page
(`docs.pjsip.org/en/latest/overview/license_3rd_party.html`) this session:

**Bundled with PJSIP's own source distribution:**

| Component | License |
|---|---|
| G.722 codec | Public domain |
| GSM 06.10 codec | Free to use, no warranty |
| iLBC codec (from WebRTC) | BSD |
| Speex | Per `third_party/speex/COPYING` (permissive) |
| libSRTP | BSD 3-clause |
| libYUV | BSD 3-clause (+ third-party components) |
| Resample library | LGPL |
| GNU Getopt | LGPL |
| ACE Timer Heap, Alaw/Ulaw converter, CRC32, MD5, SHA1 | Public domain / unrestricted |
| Milenage/Rijndael | 3GPP spec, no additional authorization needed |
| DirectShow base classes | Microsoft Windows SDK License |
| WebRTC / WebRTC AEC3 components | Per `third_party/webrtc/LICENSE` (+ abseil/rnnoise/pffft) |
| **G.722.1 (Siren7/Siren14)** | **Polycom proprietary — a separate license must be acquired to use it** |

**External, not bundled (must be separately obtained/integrated if used):**

| Component | License | Patent/royalty note |
|---|---|---|
| bcg729 (G.729 codec) | Per the bcg729 project's own license (GPL/commercial, Belledonne Communications — the same maintainer as the Linphone SDK evaluated in Phase 13.5) | G.729 itself carries **separate patent-pool royalty obligations** independent of bcg729's own software license |
| OpenCore AMR (AMR-NB/AMR-WB codec) | **Apache-2.0** (the software) | AMR itself carries **separate patent-pool royalty obligations** (VoiceAge/Ericsson/Nokia-era pool) — the Apache license covers the *implementation's copyright*, not the *codec's patents*; these are independent legal questions |
| Opus | Per opus-codec.org (BSD-style, royalty-free by design/agreement — the one exception where the codec itself, not just an implementation, is patent-unencumbered) | None |
| OpenH264, FFmpeg/libx264, VPX (VP8/VP9) | Various (BSD-3 for VPX; consult respective project sites for H.264/FFmpeg) | **Not relevant to this phase — these are video codecs; Phase 13.6A is voice-only and does not build against any of them** |
| Silk, Lyra (experimental), Oboe | Various / Apache-2.0 (Lyra, Oboe) | Not part of this phase's planned codec set |
| OpenSSL | "Apache-style" license, with an explicit GPL-compatibility permission grant | None |

**Conclusion, reaffirmed and now source-verified**: the codec set actually planned for SupremeOS's
voice-only door-station use case — **PCMU, PCMA, G.722, Opus** — draws only on public-domain
(G.722), unencumbered software with no known patent pool (PCMU/PCMA are ancient ITU codecs, long
off-patent), and Opus (explicitly royalty-free by design). **None of G.729, AMR, or G.722.1/Siren
are part of the planned build configuration**, so the separate patent-royalty and Polycom
proprietary-license exposure documented above does not apply to SupremeOS's actual codec set — but
this must remain an explicit, enforced build-configuration decision (excluding these codecs at
PJSIP compile time), not merely an unadvertised default, exactly as Phase 13.6 already concluded.

## 6. Attribution requirements

Unchanged: standard open-source attribution practice expects PJSIP's own copyright notice, plus
every bundled third-party component actually compiled in (libSRTP, iLBC, Speex, GSM, G.722,
OpenSSL, etc. — see §5's table) to appear in SupremeOS's "Open Source Licenses" screen once native
integration ships. Low-cost, not a blocker.

## 7. Is the intended SupremeOS commercial distribution model permitted?

**Only with a purchased commercial license from Teluu.** Without one, GPLv2's terms would require
SupremeOS to release its own source — incompatible with the product's closed-source commercial
model. This is unambiguous and has now been verified directly against pjsip.org and the
pjproject repository's own license metadata, not merely re-asserted from the prior report.

## Classification

**PRODUCTION HARDENING REQUIRED** — unchanged from Phase 13.6, now with primary-source
verification rather than reliance on the prior report alone. The commercial license has not been
purchased. Per this phase's explicit instruction, this does not block the technical
proof-of-concept work (native bridge, build strategy, domain integration) from continuing, but
**SupremeOS must never be classified as commercially shippable** while this remains open.

## Sources

- [PJSIP Licensing](https://www.pjsip.org/licensing.htm) — pjsip.org, core GPLv2/commercial dual-license statement, Teluu contact for alternative licensing.
- [PJSIP Third Party Software](https://docs.pjsip.org/en/latest/overview/license_3rd_party.html) — docs.pjsip.org, per-component license table (§5 above).
- `https://api.github.com/repos/pjsip/pjproject` — GitHub API license metadata (`spdx_id: GPL-2.0`), confirming the core repository's declared license independently of pjsip.org's own page.
