export type Provider = "anthropic" | "openai";

/**
 * Token categories kept separate all the way to the database, because each
 * is billed at a different rate.
 *
 *   uncachedInput       ordinary prompt tokens
 *   cacheWrite          tokens written to the provider's short-lived cache
 *                       (Anthropic ephemeral 5m; OpenAI input_cache_write_tokens)
 *   cacheWriteExtended  tokens written to a longer-lived cache
 *                       (Anthropic ephemeral 1h; OpenAI input_cache_write_12h_tokens)
 *   cacheRead           tokens served from cache
 *   output              generated tokens
 */
export interface TokenBreakdown {
  uncachedInput: number;
  cacheWrite: number;
  cacheWriteExtended: number;
  cacheRead: number;
  output: number;
}

export const TOKEN_CATEGORIES = ["uncachedInput", "cacheWrite", "cacheWriteExtended", "cacheRead", "output"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/** Provider-neutral usage line, ready to upsert into usage_events. */
export interface UsageRecord {
  provider: Provider;
  model: string;
  /** Deterministic per source line, so re-importing the same export is a no-op. */
  externalId: string;
  /** The provider's identifier for who made the calls (API key, account, project), if any. */
  principal: string | null;
  tokens: TokenBreakdown;
  occurredAt: Date;
  /**
   * The provider's service tier as exported ("standard", "batch", "priority",
   * "flex", ...), or null when the export was not grouped by it. Batch is
   * billed at a discount and priority at a premium, so pricing needs it.
   */
  serviceTier: string | null;
  /**
   * The provider's context-window bucket as exported ("0-200k", "200k-1M"),
   * or null when not grouped by it or the provider has no such field.
   * Long prompts are billed at a higher rate, so pricing needs it too.
   */
  contextWindow: string | null;
}

/** Maps provider principals (api key ids, account ids, project ids) to user uuids in this system. */
export type PrincipalMap = Record<string, string>;
