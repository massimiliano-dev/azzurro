/** Interfaccia comune ai provider: la cronologia resta nel formato nativo di ciascuno. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  stop: 'tool_use' | 'end' | 'refusal' | 'max_tokens';
  model: string;
  fallbackModel?: string;
  refusal?: string;
  reasoning?: string;
}

export interface Provider {
  id: 'claude' | 'openai' | 'local';
  model: string;
  label: string;
  userMessage(text: string): unknown;
  toolResults(results: { id: string; content: string; isError: boolean }[]): unknown[];
  run(history: unknown[], system: string, onText: (delta: string) => void, onReasoning?: (delta: string) => void): Promise<{ turn: Turn; assistantMessage: unknown }>;
  describeError(err: unknown): { code: string; message: string } | undefined;
}
