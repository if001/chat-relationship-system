import { RelationshipPlanningModel } from "../../domain/types";

export class OllamaRelationshipPlanningClient
  implements RelationshipPlanningModel
{
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    let response: Response;
    console.log("call llm");
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          format: "json",
          stream: false,
          thinking: false,
          think: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw new Error(
        `ollama relationship planning fetch failed baseUrl=${this.baseUrl} model=${this.model} api=${this.apiKey}: ${message}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `ollama relationship planning request failed baseUrl=${this.baseUrl} model=${this.model} status=${response.status}`,
      );
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error("ollama relationship planning returned empty content");
    }
    return parseJsonResponse<T>(content);
  }
}

export const createOllamaRelationshipPlanningModel = (
  baseUrl: string,
  model: string,
  apiKey?: string,
): RelationshipPlanningModel => {
  return new OllamaRelationshipPlanningClient(baseUrl, model, apiKey);
};

const parseJsonResponse = <T>(raw: string): T => {
  const normalized = unwrapJsonFence(raw.trim());
  try {
    return JSON.parse(normalized) as T;
  } catch {
    const extracted = extractJsonCandidate(normalized);
    return JSON.parse(extracted) as T;
  }
};

const unwrapJsonFence = (value: string): string => {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return value;
};

const extractJsonCandidate = (value: string): string => {
  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");
  const startCandidates = [objectStart, arrayStart].filter(
    (index) => index >= 0,
  );
  if (startCandidates.length === 0) {
    return value;
  }
  const start = Math.min(...startCandidates);
  const objectEnd = value.lastIndexOf("}");
  const arrayEnd = value.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  if (end < start) {
    return value.slice(start);
  }
  return value.slice(start, end + 1).trim();
};
