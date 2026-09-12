import { z } from "zod";

/**
 * Aureon wire contracts, MVP slice (§ AUREON-ARCHITECTURE.md, brief Step 18).
 * Additive — does not change {@link AiAssistRequest}/`/v1/ai/assistant` in phase3.ts.
 */
export const AureonConverseRequest = z.object({
  utterance: z.string().min(1),
  /** True once the user has explicitly accepted a previously-returned proposal for a
   * MODERATE/HIGH_RISK plan (§ AUREON-ARCHITECTURE.md §3.7/§5). */
  confirm: z.boolean().optional(),
});
export type AureonConverseRequest = z.infer<typeof AureonConverseRequest>;
