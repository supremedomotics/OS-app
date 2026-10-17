# KNX Secure — Specification Acquisition Plan

Goal: obtain the normative documents, exact revisions and lawful conformance material that `knx-secure-requirements-matrix.md`
§0.3 lists, through channels the KNX Association itself provides. Nothing here involves bypassing licensing.

**Basis and limits.** The only statement about access terms is the one supplied by the project from the KNX Specifications page:
the full specifications are available **to KNX members**, and the Navigator is an aid, not an authority. Everything about
*which* membership category, price, licence conditions, or whether test material is included is **UNKNOWN** and is a question
for the KNX Association, not something to assume. This environment cannot reach any KNX site, so none of it was checked here.

## Shortest legitimate route (in order)

1. **Check what Supreme Domotics already holds (days, no cost).** Ask whoever manages KNX tooling whether the company already
   has a **MyKNX account**, a **KNX membership** of any category, or ETS licences. ETS users commonly already have a MyKNX login;
   whether that login exposes the specifications and application notes is **U** — try it with the page "KNX Specifications".
2. **If the existing login shows the specs:** download the documents in matrix §0.3 into a **restricted location outside the
   repository** (licence), record exact title / number / revision / date, then do the "On receipt" steps below. This is the
   fastest possible outcome.
3. **If not: ask the KNX Association directly** through its official contact/membership channel (via knx.org). Ask the
   questions in the box below. Request a written answer, because licence terms govern what may be implemented, quoted or
   reproduced in tests.
4. **Join at the category the Association confirms gives specification access for product development.** Do not guess the
   category; fees and lead time are **U**.
5. **In parallel (do not wait on 1–4):** obtain an **ETS licence** able to create a *secure* test project and export a keyring
   with test credentials, and source a **KNX IP Secure interface/router** and **Data Secure devices** for a bench. Both are needed
   at the hardware-validation stage regardless of the documents.

### Questions for the KNX Association (copy into the request)
1. Which membership category gives access to the full KNX Specifications including **AN 158, 163, 177, 170, 193, 194, 159, 183,
   184, 185**, the **keyring file format** description, and the base specification volumes those ANs reference? Cost and timeline?
2. What are the **current revisions** of each, and is any superseded or merged into a Standard release? Minimum revisions for a
   new Secure implementation (the "Updating stack for KNX Secure" page)?
3. Under what licence may a company implement KNX Secure **from the specifications in its own stack** (not a licensed third-party
   stack), including patent/IPR terms, and are there restrictions on quoting spec text or test vectors in an internal test suite?
4. Are **conformance test specifications and test vectors** for IP Secure and Data Secure available, to whom, and do they require
   an accredited test lab or certification process? What certification is required to ship a product claiming KNX Secure?
5. Are there **interoperability test events** or reference devices for developers?
6. Does an implementation that talks to ETS-produced keyrings require any additional agreement?

## On receipt (before any code)
- Keep documents out of git; log them in the matrix by number/revision/section only.
- Turn each §0.3 row into verified requirements: set Source to **C** with `AN nnn rev x §y`, fill unresolved items as **U**.
- Re-check the existing `native/` classic tunnelling against AN 183/184/185 (IPS-11) *before* building secure sessions on it.
- Derive test vectors only as the licence allows; author negative/property tests independently; never use `knxultimate` as the oracle.
- Then, and only then, start plan stage S3/S4 (`knx-secure-implementation-plan.md`).

## Fallback if membership/licensing proves impractical (decision for the product owner, not made here)
A KNX-certified licensed Secure stack from a vendor would satisfy "Secure supported" sooner but conflicts with the clean-room,
no-third-party goal and has its own licence/cost; reference open-source implementations may be read only to understand
interoperability, subject to their licences, and never copied. This trade-off needs an explicit decision if step 3–4 stall.

## Owner / status
| Step | Owner | Status |
|---|---|---|
| Inventory existing MyKNX/membership/ETS | project owner | **open — needs a human** |
| Retrieve documents (if accessible) | person with login | open |
| Membership enquiry | project owner | open |
| ETS licence + secure bench hardware | project owner | open |
