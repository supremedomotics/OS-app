# SupremeOS fonts

Both families are licensed under the SIL Open Font License 1.1 (texts alongside).

| Flutter family | Face | Source | Use |
|---|---|---|---|
| `SOSSerif` | Cormorant Garamond Light (300) | google/fonts `ofl/cormorantgaramond` (variable font, instanced at wght=300) | names, titles, the state sentence, control values |
| `SOSSans`  | Jost Light (300), Jost Regular (400) | google/fonts `ofl/jost` (variable font, instanced at wght=300 and 400) | everything functional |

These are the families the SupremeOS-10 Golden Master embeds (as "SOS Serif" / "SOS Sans");
the Golden Master carries Latin subsets, these are the full static instances so localized
text does not fall back. Static instances are used because Flutter loads static TTF/OTF files
reliably, and the Golden Master only ever uses weights 300 and 400.
