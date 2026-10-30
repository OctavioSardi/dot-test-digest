import {
  JevRequestSchema,
  JevResponseSchema,
  type JevQuestion,
  type JevResponse,
} from "../types/schema.js";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_TIMEOUT_MS = 1200;

export interface JevClientConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class JevClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JevClientConfig = {}) {
    const env = process.env;
    this.baseUrl = (config.baseUrl ?? env["TYPESAFE_API_URL"] ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? env["TYPESAFE_API_KEY"] ?? env["JEV_API_KEY"];
    this.model = config.model ?? JEV_MODEL;
    this.timeoutMs = config.timeoutMs ?? JEV_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async ask(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
  ): Promise<JevResponse> {
    if (!this.isConfigured()) {
      throw new Error("Jev API key missing: set TYPESAFE_API_KEY (or pass --no-jev)");
    }

    const body = JevRequestSchema.parse({ model: this.model, state, questions });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey ?? ""}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
      return JevResponseSchema.parse(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
