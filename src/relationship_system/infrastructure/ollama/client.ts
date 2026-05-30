import { RelationshipPlanningModel } from "../../domain/types";

export class OllamaRelationshipPlanningClient implements RelationshipPlanningModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`ollama relationship planning request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error("ollama relationship planning returned empty content");
    }
    return JSON.parse(content) as T;
  }
}

export const createOllamaRelationshipPlanningModel = (
  baseUrl: string,
  model: string,
  apiKey?: string,
): RelationshipPlanningModel =>
  new OllamaRelationshipPlanningClient(baseUrl, model, apiKey);
