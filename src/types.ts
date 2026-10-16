export type Provider = "anthropic" | "openai";

/** Provider-neutral usage line, ready to upsert into usage_events. */
export interface UsageRecord {
  provider: Provider;
  model: string;
  /** Deterministic per source line, so re-importing the same export is a no-op. */
  externalId: string;
  /** The provider's identifier for who made the calls (API key, account, project), if any. */
  principal: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  occurredAt: Date;
}

/** Maps provider principals (api key ids, account ids, project ids) to user uuids in this system. */
export type PrincipalMap = Record<string, string>;
