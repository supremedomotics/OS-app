# Aureon Use-Case Catalogue

Companion to `AUREON-ARCHITECTURE.md`. 150+ concrete use cases, grouped per the task brief's 40
categories. Columns: **Request** (what the user says/what triggers it) · **Context needed** ·
**Devices/systems** · **Reasoning** (what Aureon must work out) · **Actions** · **Verification**
· **Safety level** (0-3, see architecture doc §3.7) · **Mode** (automatic / proactive /
confirm-first) · **Dependencies / Future flag**.

Every action listed uses only the 10 real capability kinds
(`onoff, brightness, color, temperature, position, media, lock, fan, vacuum, sensor`) unless
marked **[future capability]**. Nothing here assumes a subsystem the architecture doc's §1.15
lists as absent, except where explicitly flagged as future work.

---

## 1. Natural-language control
| # | Request | Context | Devices | Reasoning | Actions | Verification | Safety | Mode | Deps |
|---|---|---|---|---|---|---|---|---|---|
|1|"Turn off the living room lights"|active room|lighting devices in room|resolve room+capability|onoff off, all matching|re-read state|1|confirm-first (MVP), auto after trust|Home Graph room membership|
|2|"Dim the kitchen a bit"|active/named room|dimmable lights|relative adjustment, default step|brightness -15%|re-read level|1|auto|—|
|3|"Make it warmer in here"|current room, current temp|thermostat in room|relative setpoint nudge (+2°C default)|temperature set|re-read ambient/target|1|auto|—|
|4|"Turn that off"|last-referenced device|resolved via conversation ref|pronoun resolution|onoff off|re-read|0-1|auto|Conversation turn history|
|5|"Is the garage door open?"|—|garage cover device|read-only query|none|sensor/position read|0|auto|—|
|6|"Close all the blinds"|home-wide|all `position` covers|scope resolution ("all")|position=0|re-read position|1|confirm-first|—|
|7|"Set the AC to 22"|active room|thermostat|absolute setpoint|temperature set targetC=22|re-read target/ambient|1|auto|—|
|8|"Lock the front door"|—|lock device|explicit named device|lock.lock|re-read locked state|3|confirm-first always|—|
|9|"What's the temperature in the bedroom?"|—|thermostat/sensor|read-only|none|sensor read|0|auto|—|
|10|"Play some music in the living room"|room, media devices|media_player|source/default playlist ambiguity|media play|playback state|1|confirm if source ambiguous|**[future]** streaming service selection beyond `media` capability's `source` field|
|11|"Stop everything"|home-wide|all active media/automations|scope = all active media|media stop, all|playback state|1|auto|—|
|12|"Increase the volume a little"|last media device|media_player|relative step|media volume +|re-read volume|1|auto|—|

## 2. Lighting
|13|"Cozy lighting in the living room"|room, time of day|lights, dimmers|map "cozy" to warm color temp + low brightness|color kelvin↓, brightness↓|re-read|1|auto|Requires `color` capability present; else brightness-only fallback, stated honestly|
|14|"Brighten the kitchen for cooking"|room|lights|map task to full brightness|brightness=100|re-read|1|auto|—|
|15|"Turn on the hallway light when I'm walking through"|motion/occupancy|hallway light, presence sensor|proposes automation|create automation (device_state trigger)|confirm creation|1|confirm-first|Uses existing automation DSL, `aiGenerated:true`|
|16|"Match the lights to the movie mood"|room, media state|lights + media_player|infer dim+warm during playback|brightness↓, color kelvin↓|re-read|1|confirm-first (novel combo)|**[future]** true "mood" inference beyond static rule|
|17|"Turn off lights in unoccupied rooms"|occupancy per room|all lights|loop over rooms via occupancy context|onoff off per empty room|re-read each|1|auto (opt-in) or proactive suggestion|Occupancy signal freshness required|
|18|"Set morning lighting"|time, saved preference|lights|recall stored preference (Memory)|brightness/color per memory record|re-read|1|auto|Memory: preference category|

## 3. HVAC
|19|"I'm freezing"|current room, current temp|thermostat|infer discomfort → raise setpoint, check windows/covers if sensor exists|temperature set +2°C|re-read ambient trend|1|auto (bounded delta)|—|
|20|"Why is the bedroom so warm?"|bedroom thermostat, recent commands|thermostat, automation history|diagnostic: check mode, recent automation runs, driver diagnostics|none (query)|read state+run history+diagnostics|0|auto|Automation run-history ring buffer, DriverDiagnosticsTracker|
|21|"Get the house ready before I arrive"|ETA, away mode, weather|thermostats, lights|precondition rooms 20-30 min before ETA|temperature set, lights on schedule|re-read on completion|1|confirm-first until trusted|Needs arrival-ETA context source — **[future]** if no calendar/geofence integration exists yet|
|22|"Turn off AC if a window is open"|window/contact sensor if present|thermostat, sensor|conditional safety rule|temperature off|re-read|1|confirm-first to create as automation|Requires a `sensor`-capability contact device; else explicitly unavailable, not fabricated|
|23|"Set a sleep temperature schedule"|bedroom, saved preference|thermostat|convert to automation with time trigger|create automation|confirm creation|1|confirm-first|—|

## 4. Curtains / shading
|24|"Open the curtains"|room|position covers|scope resolution|position=100|re-read|1|auto|—|
|25|"Close the blinds at sunset"|solar context|position covers|create solar-trigger automation|create automation (existing solar.ts wrapper)|confirm|1|confirm-first|Reuses existing `solar.ts`|
|26|"It's too bright in here"|room, time, sun position|covers|infer partial closure|position=40|re-read|1|auto|—|

## 5. AV
|27|"Turn on the TV and switch to the right input"|room, media_player capability config|AVR/TV device|resolve named input via driver's declared inputs|media source set|re-read source|1|auto|Uses existing `getAvrInputs` driver extension where present|
|28|"Set up movie night"|room|TV, AVR, lights, curtains|multi-device plan across categories|media on+source, lights dim, curtains close|re-read all|1|confirm-first|Cross-protocol plan — MVP may restrict to single room|
|29|"Rename this AVR input"|installer/admin context|AVR|maps to existing `setAvrInputCustomName`|driver command via existing tool, not new capability|re-read via `getAvrInputs`|1|confirm-first|Existing driver feature — Aureon just exposes it conversationally|

## 6. TV
|30|"Pause the TV"|active media device|media_player|resolve default/last-used TV|media pause|playback state|0|auto|—|
|31|"What's playing in the living room?"|room|media_player|read-only|none|media state (title/artist)|0|auto|—|

## 7. Security
|32|"Arm the house"|occupancy, all doors/windows if sensors exist|SecurityService|check for open doors/windows before arming (if sensor capability present); explain if unknown|security arm|re-read security mode|3|confirm-first always|Existing SecurityService state machine|
|33|"Is everything secure?"|security mode, locks, sensors|SecurityService, lock devices|aggregate read across security+locks; report unknowns honestly|none|read only|0|auto|Must say "can't verify X" per brief's core mandate, not assume|
|34|"Disarm for the cleaner"|guest/staff schedule|SecurityService|check requesting user's role/grant validity window|security disarm|re-read|3|confirm-first, role-gated|Staff `expiresAt`/grant window enforcement|
|35|"Why did the alarm trigger?"|recent security events|SecurityService, audit log|diagnostic explanation|none|read audit log + security history|0|auto|Audit log is real+hash-chained today|

## 8. Access / locks
|36|"Unlock the front door for my guest"|guest identity, time window|lock device|check role/grant, time-bound|lock.unlock|re-read locked state|3|confirm-first always, never auto|—|
|37|"Did I lock the back door?"|—|lock device|read-only|none|sensor/lock state read|0|auto|—|
|38|"Auto-lock all doors at night"|time, saved preference|lock devices|propose automation|create automation|confirm creation|2 (creation) / 3 (execution)|confirm-first|—|

## 9. Energy
|39|"How much energy is the AC using?"|energy module|thermostat, energy REST|read-only aggregate|none|read `/v1/energy/device-watts`|0|auto|Existing energy intelligence module|
|40|"Reduce energy use this evening"|energy budget, device states|all high-load devices|identify deferrable/idle loads|dim/off low-priority devices|re-read + energy delta|1|confirm-first|Reuses existing `deferrable-loads`/`load-shift` energy suggestions|
|41|"Why is my bill high this month?"|energy history|energy service|diagnostic over time-series|none|read energy history|0|auto|**[future]** — no confirmed persisted energy time-series beyond current summary; flag if `services/analytics` lacks it|

## 10. Presence
|42|"Who's home?"|presence/occupancy context|presence sensors, user location if available|aggregate read|none|read occupancy context|0|auto|Depends on existing presence intelligence module coverage|
|43|"Notify me when my kid gets home"|presence, household roles|presence sensor, notification service|create proactive rule|create automation w/ notify action|confirm creation|1|confirm-first|Existing `notify` automation action|

## 11. Scenes
|44|"Save this as my evening setup"|current device states across active room(s)|all touched devices|snapshot current state into scene steps|create Scene|confirm + re-read scene contents|1|confirm-first|Reuses existing Scene/SceneStep model directly|
|45|"Activate evening scene"|—|Scene|resolve named scene|scene_activate|re-read post-activation device states|1|auto (once scene trusted)|Existing SceneService.activate()|
|46|"Update my evening scene to also dim the hallway"|existing scene|Scene, hallway light|merge new step into existing scene|update Scene steps|confirm + re-read|1|confirm-first|—|

## 12. Automation
|47|"Every evening around sunset, make the living room comfortable"|solar context, room|lights, HVAC, curtains|conversational automation creation (brief's flagship example)|create Automation (trigger=time/solar, conditions=occupied, actions=multi-step)|confirm draft before creating|2|confirm-first always|Existing DSL, `aiGenerated:true`|
|48|"Turn off that automation"|named/recent automation|Automation|resolve reference|disable automation|re-read enabled flag|1|confirm-first|—|
|49|"Why didn't the AC turn on?"|automation, run history|Automation, run-history ring buffer, SIL|diagnostic trace: condition failed? driver offline? disabled?|none|read run history + diagnostics|0|auto|Existing `AutomationRun` history — Aureon's Explainability directly consumes this|

## 13. Comfort
|50|"Make the house comfortable before dinner guests arrive"|guest ETA, dining/living rooms|lights, HVAC, AV|multi-room plan preserving private areas|see Planning Engine example in brief|re-read all touched|2|confirm-first|Cross-room plan; "preserve private areas" = exclude bedrooms from Home Graph traversal|
|51|"Make it quieter"|room, media/HVAC noise sources|media_player, fan|infer noise reduction targets|media volume down, fan speed down|re-read|1|auto|—|
|52|"Make this room cozy"|room, time|lights, HVAC, curtains|composite comfort mapping|see #13 lighting + minor temp nudge|re-read|1|confirm-first (novel combo)|—|

## 14. Sleep
|53|"I can't sleep, make the room comfortable"|bedroom (brief's flagship example)|lights, HVAC, curtains|evaluate temp/light/curtains per brief's example plan|adjust as needed|re-read|1|auto (bounded) or confirm|—|
|54|"Goodnight"|bedroom, household mode|lights, locks, security, HVAC|composite "sleep" routine incl. LEVEL 3 items|lights off, lock doors, arm security, HVAC to sleep setpoint|re-read all, esp. locks/security|3 (contains lock/arm steps)|confirm-first (whole plan, due to LEVEL 3 component)|—|
|55|"Wake me up gently"|bedroom, alarm time|lights (dimmable)|gradual brightness ramp automation|create automation using `fadeMs`/ramped brightness steps|confirm creation|1|confirm-first|Requires driver-level fade support (e.g. Casambi) — else explicit "not supported by current driver"|

## 15. Morning routines
|56|"Good morning"|time, bedroom/kitchen|lights, curtains, HVAC, media|composite routine|curtains open, lights up, temp to day setpoint|re-read|1|confirm-first until trusted, then auto|—|
|57|"Skip today's morning routine"|scheduled automation|Automation|one-off disable, not permanent|temporarily suppress trigger (no state change)|confirm suppression|1|confirm-first|Needs a "skip once" affordance not in current DSL — **[future]** minor DSL extension|

## 16. Evening routines
|58|"I'm home"|arrival, evening|lights, HVAC, security|arrival routine|lights on, disarm if appropriate, temp to evening setpoint|re-read|2 (touches security)|confirm-first|—|
|59|"Movie night" (see #28)|—|—|—|—|—|—|—|—|

## 17. Entertainment
|60|"Set up for a party"|living/dining rooms|lights, AV, media|multi-room energetic scene|brighten+color, media on, volume up|re-read|1|confirm-first|—|
|61|"What can I watch right now?"|media_player capability|media_player|read-only capability/source query|none|read available sources|0|auto|Limited to driver-declared `source` options — no content catalog **[future]**|

## 18. Guests
|62|"Guests are arriving"|brief's flagship example|multiple rooms|full multi-room plan (§4 execution flow example)|entrance/living/dining prep, preserve private areas|re-read all|2|confirm-first|—|
|63|"Give my guest temporary access"|guest user record|permissions/Grant|create time-bound Grant via existing ABAC|create Grant (existing repo, not new logic)|confirm|2|confirm-first|Reuses existing `Grant`/`validUntil`|
|64|"The guests have left"|presence, household mode|security, HVAC, lights|revert to normal mode, offer to re-arm|composite revert plan|re-read|2|confirm-first|—|

## 19. Travel
|65|"I'm traveling next week, put the house in away mode"|calendar/date range if available|HVAC, lights, security|schedule away-mode window|create automation w/ time-window condition|confirm|2|confirm-first|Calendar context **[future]** if no calendar source integrated; date range can be manually specified meanwhile|
|66|"Simulate occupancy while I'm away"|away schedule|lights|random/pattern-based light automation|create automation|confirm|1|confirm-first|—|

## 20. Away mode
|67|"Set the house to away"|—|HVAC, lights, security|composite: setback temp, lights off, arm away|see actions|re-read all|3 (includes arm)|confirm-first|—|
|68|"Did I leave anything on?"|away mode active|all `onoff`/`media` devices|read-only sweep|none|read state of all active-capable devices|0|auto|—|

## 21. Arrival
|69|"Make the house ready for my arrival" (brief example)|ETA|HVAC, lights|precondition per §HVAC #21|see #21|re-read|1|confirm-first|ETA context source needed|
|70|"Welcome home" trigger|geofence/presence if available|lights, HVAC, security disarm|arrival composite|see #58|re-read|2|confirm-first|Geofence **[future]** unless presence sensor suffices|

## 22. Departure
|71|"I'm leaving"|—|lights, HVAC, security|departure composite (opposite of arrival)|lights off, setback temp, arm away (if house empty)|re-read, esp. occupancy before arming|3 (arm)|confirm-first|Must verify home is actually vacant before arming — occupancy context required|

## 23. Family
|72|"Set a bedtime routine for the kids' rooms"|child user, rooms|lights, media|role-aware routine (child profile)|dim lights, media off at set time|confirm creation|1|confirm-first|Household role model already supports `child` type|
|73|"Can my kid unlock the door?"|child role, grants|PolicyEngine|read-only policy explanation|none|read PolicyEngine.decide() result|0|auto|Directly surfaces existing RBAC/ABAC decision|

## 24. Staff
|74|"Let the cleaner in between 9 and 11"|staff user, time window|lock, Grant|time-bound access grant|create Grant with `ScheduleWindow`|confirm|3|confirm-first, admin-only|Existing Grant schema supports this exactly|
|75|"What can the service technician access?"|service_engineer role|PolicyEngine|read-only|none|read baseline role policy|0|auto|—|

## 25. Safety
|76|"Is the stove still on?"|kitchen sensor if present|sensor/onoff capability device|read-only|none|read state|0|auto|Depends on a real stove-monitoring device existing — else explicit "no device configured"|
|77|"The garage has been open for 25 minutes" (brief example)|cover position + duration|garage cover|proactive threshold detection|notify only, or offer to close|notify; close only on confirm|1|proactive|Needs a duration-tracking rule over existing position state — new logic, no new capability|
|78|"Alert me if a door is left unlocked at night"|time, lock state|lock devices|proactive rule|create automation w/ notify|confirm creation|1 (alert) |confirm-first|—|

## 26. Anomaly detection
|79|"Three Casambi devices have had repeated failures" (brief example)|driver diagnostics|Casambi devices|threshold over `DriverDiagnosticsTracker` reconnect/error counts|notify (WARNING classification)|none (detection only)|0|proactive|Existing diagnostics tracker/health-monitor is the real data source|
|80|"Energy consumption is significantly above normal"|energy history vs. baseline|energy module|statistical deviation over recent vs. historical average|notify|none|0|proactive|Needs historical energy time-series depth — verify via `services/analytics` before promising|
|81|"An automation has failed repeatedly"|automation run history|Automation|threshold over run-history failures|notify + explain via #49's diagnostic path|none|0|proactive|Existing run-history ring buffer|

## 27. Predictive maintenance
|82|"This gateway's latency has been rising"|driver diagnostics|CoolMaster/Casambi driver|trend detection over `avg latency` field|notify (homeowner + installer channel)|none|0|proactive|Existing DriverDiagnosticsTracker fields|
|83|"A device is showing early battery degradation"|sensor/diagnostics if reported|battery-reporting device|threshold detection|notify|none|0|proactive|**[future]** — depends on whether any driver reports battery level today; verify before building|

## 28. Diagnostics
|84|"Why isn't the living room AC working?" (brief example)|CoolMaster chain|CoolMaster driver, gateway, indoor unit|full diagnostic trace per brief's flow|none|read diagnostics/trace/last error|0|auto|Existing CoolMaster diagnostics modules (`coolmaster-errors.ts` etc.)|
|85|"Run a health check on the Casambi network"|Casambi UDP diagnostics|Casambi driver|aggregate `CasambiUdpDetail`|none|read diagnostics|0|auto|Existing `casambi/diagnostics.ts`|

## 29. Installer workflows
|86|"Show me all devices with driver errors"|devMode|all devices|aggregate diagnostics across drivers|none|read per-device diagnostics|0|auto|devMode-gated, matches existing DiagnosticsSection scope|
|87|"Explain this device's commissioning history"|audit log|specific device|read-only trace|none|read audit log filtered by resourceId|0|auto|Existing hash-chained audit log|

## 30. Commissioning
|88|"Suggest a room for this newly discovered device"|discovery result (e.g. Casambi group name)|discovered device|reuse existing `raw.room` auto-mapping hint|suggest, never auto-assign|confirm before binding|1|confirm-first|Existing Room Assignment Engine already produces this hint — Aureon just verbalizes it|
|89|"What kind of device is this?"|discovery `raw.suggestedKind`|discovered device|surface driver's non-authoritative guess, never assert as fact|none|—|0|auto|Must state it's a guess, not verified — matches brief's anti-hallucination rule|

## 31. System health
|90|"Is everything working normally?"|system-wide diagnostics|all drivers|aggregate health rollup|none|read diagnostics + automation health() + audit|0|auto|—|
|91|"Any pending system updates?"|installer/system service|system-update service|read-only|none|read system status|0|auto|Existing `system-update.ts` route|

## 32. Explanations
|92|"Why did you do that?"|last Aureon transaction|AureonTransaction|reconstruct from transaction entries + originating intent|none|read transaction record|0|auto|Core Explainability requirement, §4 step 9 output persisted|
|93|"What are you currently doing?"|active plan/transaction|AureonPlan|read-only status|none|read in-flight transaction status|0|auto|—|
|94|"What changed in the last hour?"|audit log + transactions|home-wide|aggregate timeline query|none|read audit log + Aureon transactions|0|auto|No unified activity timeline exists today — Aureon composes one at query time from audit log + its own transactions, does not claim a device-level timeline SupremeOS itself lacks|

## 33. Memory
|95|"Remember that I like the bedroom at 24°C"|explicit preference statement|Memory|create preference record|write AureonMemory(category=preference)|confirm + show stored record|0|auto (explicit user statement)|—|
|96|"What do you remember about me?"|user's memory records|Memory|read-only, filtered to requesting user|none|read Memory|0|auto|Must respect `visibility` field|
|97|"Forget that"|last-created memory|Memory|delete by reference|delete AureonMemory|confirm deletion|0|auto|Every memory user-deletable per §3.4|

## 34. Personalization
|98|"Set my personal preferences for lighting"|user profile|Memory|structured preference capture|write Memory|confirm|0|auto|—|
|99|"Use my usual settings"|user, room|Memory (pattern/preference)|recall + apply|apply stored device commands|re-read|1|confirm-first until trusted|—|

## 35. Proactive intelligence
|100|"The living room will become uncomfortable in ~20 minutes" (brief example)|HVAC trend, occupancy|thermostat|extrapolate from ambient trend + setpoint|notify (offer pre-emptive adjustment)|none unless confirmed|1|proactive|Needs a simple trend-projection rule over existing ambient readings — no ML|
|101|"The house appears ready for your arrival" (brief example)|precondition plan status|multiple|confirm plan §21 completed and verified|notify|already verified in #69's flow|0|proactive|—|

## 36. Multimodal AI (extension points only — mostly future)
|102|"Recognize who's at the door"|camera device|camera|**[future capability]** — no vision pipeline exists|—|—|—|—|Architecture reserves a `sources.vision` Context Engine slot; not built in MVP/V1|
|103|"Respond to my voice directly"|microphone|**[future capability]**|—|—|—|—|—|Same — reserved extension point only|

## 37. Spatial intelligence
|104|"Which room gets the most afternoon sun?" (brief's "home knowledge" example)|solar orientation + historical lux if sensor exists|lux sensors if present|infer from `sensor` capability history, or flag unknown|none|read sensor history|0|auto|**[future]** if no lux sensors are commissioned — must say so, not guess|
|105|"Understand that these devices are all part of the living-room environment" (brief's Home Graph example)|Home Graph|multiple devices|`function_zone` grouping|none (background modeling)|—|0|automatic (background)|Core Home Graph feature, §3.3|

## 38. Energy optimization
|106|"Shift the dishwasher to off-peak hours"|tariff schedule, deferrable load|switch/appliance device|reuse existing `deferrable-loads`/`load-shift` suggestions|create automation w/ time trigger|confirm|1|confirm-first|Existing energy REST endpoints|
|107|"Am I on the cheapest tariff option?"|tariff config|energy service|read-only comparison|none|read `/v1/energy/tariff`|0|auto|—|

## 39. Sustainability
|108|"How much CO2 did we save this month?"|energy history + tariff/provider carbon data if available|energy service|aggregate calc|none|read energy history|0|auto|**[future]** — no carbon-intensity data source confirmed in repo; flag before promising|
|109|"Suggest ways to reduce our footprint"|energy + device usage patterns|Memory (pattern), energy module|combine idle-device suggestions with usage patterns|notify with suggestions|none unless acted on|0|proactive|Reuses existing energy decision engine's `Suggestion` type|

## 40. Future autonomous-home capabilities
|110|"Just handle my home the way I like it, always"|full Memory + Learning Engine maturity|everything|fully autonomous operation without per-action confirmation|—|—|—|**[future]**|Explicitly V3+ and gated by sustained LEVEL 0-1 trust; LEVEL 2/3 confirmation is never removable per §5|
|111|"Negotiate with my neighbor's home for shared solar"|inter-home data sharing|**[future capability]**|—|—|—|—|—|Out of scope indefinitely — no multi-home data-sharing architecture exists or is proposed here|

---

### Remaining entries (112-151) — compact list to reach full coverage

To satisfy the ≥150 requirement without padding the tables above with repetitive variants, the
remaining entries are natural minor variations of the patterns already fully specified (same
reasoning/verification/safety shape, different device or room):

112. "Turn on porch light at dusk" (Lighting, solar trigger, safety 1, confirm-first)
113. "Set all bedrooms to night mode" (Sleep, multi-room, safety 1, confirm-first)
114. "Increase bathroom fan speed" (HVAC/fan, safety 1, auto)
115. "Close the garage door" (Access, safety 2 — treated as consequential not high-risk unless tagged security-gate, confirm-first)
116. "What's the humidity in the wine cellar?" (Sensors, safety 0, auto)
117. "Turn off the TV if no one's in the room for 10 minutes" (Proactive automation, safety 1, confirm-first creation)
118. "Set the pool pump schedule" (Automation, safety 1, confirm-first) — **[future]** if no pool-pump device type exists; verify `SupremeDeviceType` coverage first
119. "Dim the office lights during video calls" (Lighting+context, safety 1, confirm-first) — needs a call-in-progress context source, **[future]**
120. "Turn on outdoor lights when the alarm triggers" (Security composite, safety 3, confirm-first for creation, auto for execution once created since it's a security *response* not a new arm/disarm)
121. "Notify me if a window sensor stays open in the rain" (Proactive, needs weather+sensor, safety 1, proactive) — **[future]** if no window sensors exist
122. "Set the thermostat schedule for the whole week" (HVAC automation, safety 1, confirm-first)
123. "Which lights are currently on?" (Query, safety 0, auto)
124. "Turn off standby power devices overnight" (Energy, safety 1, confirm-first)
125. "Set up a 'reading' scene in the study" (Scenes, safety 1, confirm-first)
126. "Increase the pool heater temperature" (HVAC-adjacent, safety 1, confirm-first) — **[future]** if pool heating isn't a modeled device type
127. "Alert the installer if the KNX gateway disconnects" (Predictive maintenance, safety 0, proactive)
128. "Show me all automations Aureon created" (Explainability/Memory, safety 0, auto) — filters `Automation.aiGenerated`
129. "Undo my last three changes" (Transaction/Undo, safety = max of undone entries, confirm-first)
130. "Cancel that" mid-execution (Action Engine cancellation, safety 0, auto)
131. "Pause, I need to think" (Conversation interruption, safety 0, auto)
132. "Ask me before doing anything to the security system, always" (Personalization of confirmation policy, safety 0 to set the preference — but never lowers LEVEL 3's mandatory confirm)
133. "What's my energy budget status?" (Energy, safety 0, auto)
134. "Turn the guest room into a home office for the week" (Scene/automation compound, safety 1, confirm-first)
135. "Recommend an evening routine based on my habits" (Learning Engine proposal, safety 0 to propose / relevant tier to create, confirm-first)
136. "Did the automation actually run last night?" (Explainability, safety 0, auto) — reads run-history
137. "Show me devices that haven't reported state in 24 hours" (Diagnostics, safety 0, auto)
138. "Set a quiet hours mode for notifications" (Personalization, safety 0, confirm-first)
139. "Who has access to the front door?" (Permissions query, safety 0, admin-only, auto)
140. "Revoke the guest's access now" (Grant deletion, safety 2, confirm-first)
141. "Explain what 'armed away' actually does in this house" (Explainability, safety 0, auto)
142. "Set up arrival detection for my partner's car" (Presence, safety 1, confirm-first) — **[future]** if no vehicle/geofence presence source exists
143. "Reduce all lights to 50% for a movie" (Lighting, safety 1, auto)
144. "Is the house child-safe right now?" (Safety aggregate query, safety 0, auto) — checks lock states, pool safety devices if modeled
145. "Log this as a maintenance issue for the installer" (Diagnostics/ticketing, safety 0, confirm-first) — **[future]** if no installer-ticketing system exists in repo; verify before building
146. "What would happen if I asked you to arm the house right now?" (Dry-run / explain-without-executing, safety 0, auto) — uses Planning Engine's dry-run mode
147. "Set a maximum brightness for night hours" (Personalization/policy, safety 0, confirm-first)
148. "Tell me every time a LEVEL 3 action happens" (Personalization of proactive notifications, safety 0, confirm-first)
149. "Compare this month's energy use to last month" (Energy, safety 0, auto) — depends on time-series depth, same caveat as #41/#80
150. "Reset Aureon's memory about me" (Privacy/Memory, safety 0, auto, user-initiated only)
151. "Show me the full reasoning trace for that last decision" (Explainability, safety 0, auto) — surfaces intent→plan→policy-decision→execution→verification chain end to end
