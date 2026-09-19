# Phase 13.6 — SIP Licensing

Critical licensing gate required before any production-distributable PJSIP/PJSUA2 integration.
This document inspects PJSIP's actual license and dependency components against SupremeOS's
commercial, closed-source distribution model. **No native PJSIP integration has actually been
linked into a build in this phase** (see the final report — no native build capability exists in
this environment), so this is a pre-integration licensing analysis, not a post-hoc audit of
shipped code. It must be re-verified against the exact PJSIP version/build configuration actually
selected once native integration begins.

## 1. Applicable license

PJSIP ("PJPROJECT") is dual-licensed by Teluu Inc.:

- **GPLv2** for open-source use — any application linking PJSIP under this license must itself be
  distributed under GPL-compatible terms, including making its own source available. This is
  **incompatible** with SupremeOS's closed-source commercial distribution.
- **A commercial license from Teluu** — removes the GPL's copyleft/source-disclosure obligation
  for a closed-source product, in exchange for a license fee. This is the only viable path for
  SupremeOS.

**A commercial PJSIP license has not been procured for this project.** This is a business/legal
action item, unchanged since Phase 13.5's decision document flagged it, and remains unresolved.

## 2. Commercial redistribution requirements

Under Teluu's commercial license, redistributing PJSIP compiled into a closed-source binary is
permitted without a GPL source-disclosure obligation. The exact terms (per-app fee, per-deployment
fee, royalty structure, term length) are negotiated directly with Teluu and are **not public** —
SupremeOS's actual commercial terms cannot be stated here until that negotiation happens. This
document cannot substitute for that negotiation.

## 3. Source obligations

- **Under GPLv2** (not the path SupremeOS will take): distributing an app that links PJSIP would
  obligate SupremeOS to make its own combined-work source available under GPL-compatible terms —
  unacceptable for a commercial closed-source product.
- **Under the commercial license**: no source-disclosure obligation for SupremeOS's own code.
  PJSIP's own source remains available (Teluu publishes it regardless of license path), and any
  modifications SupremeOS makes *to PJSIP itself* (not to SupremeOS's own code) may carry separate
  obligations depending on the exact commercial agreement — must be confirmed in the actual
  contract, not assumed.

## 4. Binary redistribution obligations

Under the commercial license, PJSIP's compiled binary (a static `.a`/`.so` on Android, a static
library or `.xcframework` on iOS) may be embedded in a closed-source app binary and distributed
through the App Store / Play Store without further disclosure obligation. Attribution requirements
(§9) still apply regardless of license path.

## 5. Codec licensing implications

This is the part most likely to be silently overlooked, and is called out explicitly per the
phase brief's instruction not to assume "PJSIP is open source" settles everything:

- **G.711 (PCMU/PCMA)**: no patent/royalty concerns — this codec is old enough to be unencumbered.
  Free to use.
- **G.722**: unencumbered, free to use.
- **GSM, iLBC**: unencumbered, free to use (already permissively licensed upstream).
- **G.729**: **separately patent-encumbered** — historically required a per-unit royalty license
  from the G.729 patent pool (via Sipro Lab Telecom or similar licensing bodies), independent of
  PJSIP's own license. PJSIP's `pjmedia` includes G.729 support as an optional codec module;
  **if G.729 support is compiled in and shipped, SupremeOS would need its own separate G.729
  patent license** regardless of PJSIP's own commercial license, which does not cover this.
  Recommendation: **do not enable G.729** unless a specific door-station deployment requires it
  and a separate G.729 patent license has been obtained — this phase's implementation plan
  (§ native architecture doc) does not include G.729 in the codec set for exactly this reason.
- **AMR/AMR-WB**: also separately patent-encumbered (via VoiceAge and other patent holders) if
  ever enabled — same treatment as G.729: not included in this phase's codec set.
- **Opus**: royalty-free (RFC 6716, explicitly patent-unencumbered by design/agreement among
  major patent holders) — safe to include.
- **G.722.1/Siren**: proprietary/patent-encumbered — not included.

**Conclusion**: the codec set actually planned for this phase (PCMU, PCMA, G.722, Opus — per the
Phase 13.5 decision doc §12 and the native architecture doc's codec section) carries **no
additional codec-patent licensing burden** beyond PJSIP's own commercial license, provided the
native build explicitly excludes G.729/AMR/AMR-WB/Siren at compile time. This must be enforced as
a build-configuration decision (a `pjproject` build flag), not merely a runtime preference —
compiling in an unlicensed codec and simply not advertising it in SDP is not a safe posture.

## 6. Android implications

PJSIP for Android is built via the NDK into a `.so` embedded in the app's AAR/APK — this is
**static-at-build-time linking** in practice (PJSIP does not ship as a separate loadable system
library on Android). The commercial license's "closed-source binary redistribution" permission
covers this shape directly. No separate Android-specific PJSIP licensing wrinkle exists beyond
the general terms in §§1–4.

## 7. iOS implications

Same shape as Android: PJSIP for iOS is built as a static library or `.xcframework` and statically
linked into the app binary submitted to the App Store. Apple's own App Store review does not
impose additional SIP-specific licensing requirements, but does require accurate disclosure of any
encryption use (SRTP/TLS) in App Store Connect's export-compliance questionnaire — an operational
requirement, not a PJSIP-licensing one, but worth flagging here since it blocks App Store
submission if missed.

## 8. Static/dynamic linking implications

PJSIP is conventionally statically linked on both platforms (see §§6–7) — there is no realistic
dynamic-linking scenario for a mobile app bundling PJSIP, so the GPL's "dynamic linking may avoid
copyleft" argument (itself legally contested and not something SupremeOS should rely on) is moot:
**the commercial license is required regardless of linking strategy**, because static linking is
the only strategy in play.

## 9. Attribution requirements

Even under the commercial license, standard open-source attribution practice (and Teluu's own
license terms, to be confirmed in the actual signed agreement) typically expects PJSIP's copyright
notice to appear in the app's open-source-attribution/licenses screen (a "Legal"/"Open Source
Licenses" page — SupremeOS should add PJSIP to whatever such page exists once native integration
ships). This is a low-cost, standard obligation, not a blocker.

## 10. Is a commercial PJSIP license required?

**Yes, unambiguously.** SupremeOS is closed-source and commercially distributed; the GPLv2 path is
not viable. This was already the conclusion of the Phase 13.5 decision document and is reaffirmed
here after the deeper, codec-level inspection this phase's gate specifically requires.

## 11. What exactly the commercial license covers

Based on Teluu's publicly documented commercial-licensing model: removal of the GPL copyleft
obligation for the app that embeds PJSIP's core signaling/media engine. It does **not** cover:
patent-encumbered codecs not otherwise licensed (§5), any third-party library PJSIP itself links
against under its own separate license (§12), or export-compliance/App Store legal requirements
(§7). The exact scope of any specific agreement must be confirmed directly with Teluu at
negotiation time — this document is an engineering-side risk map, not a substitute for that
contract.

## 12. Additional third-party licenses required

- **OpenSSL** (or an equivalent TLS/crypto backend PJSIP is built against for SIP-TLS/SRTP): under
  the OpenSSL license (Apache-2.0-style since v3.0) — permissive, no additional commercial license
  needed, but its own attribution notice is required on the same "Open Source Licenses" screen
  as §9.
- **libsrtp** (if used for SRTP instead of PJSIP's own implementation): BSD-style, permissive, no
  additional commercial license needed, attribution required.
- **G.729/AMR patent pools**: NOT required if those codecs are excluded at build time, per §5's
  recommendation. Required (and currently NOT obtained) only if a future deployment mandates one
  of those codecs.

## Classification

**PRODUCTION HARDENING REQUIRED.** The licensing question is not silently resolved: a commercial
PJSIP license from Teluu has not been procured, and this is a business/legal action outside
engineering's ability to close inside this phase. Engineering's obligation — discharged here — is
to (a) determine precisely what is and isn't covered, (b) ensure the technical codec/build
configuration doesn't silently introduce an additional, unaddressed licensing burden (G.729/AMR
exclusion), and (c) keep this status visible rather than assumed away. Per the phase brief's own
instruction, implementation proceeds on the technical architecture (native bridge design,
domain-model integration) while this business item remains open and explicitly tracked.
