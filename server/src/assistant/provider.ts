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

/** Provider che gestisce da sé il ciclo modello → strumenti (Claude Agent SDK). */
export interface AgentRunOptions {
  prompt: string;
  system: string;
  resume?: string;
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onReasoning: (delta: string) => void;
  onModel: (model: string) => void;
  runTool: (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>;
}

export interface Provider {
  id: 'claude' | 'openai' | 'local' | 'claudecode';
  model: string;
  label: string;
  userMessage(text: string): unknown;
  toolResults(results: { id: string; content: string; isError: boolean }[]): unknown[];
  run(history: unknown[], system: string, onText: (delta: string) => void, onReasoning?: (delta: string) => void, signal?: AbortSignal): Promise<{ turn: Turn; assistantMessage: unknown }>;
  describeError(err: unknown): { code: string; message: string } | undefined;
  agent?: { run(o: AgentRunOptions): Promise<{ sessionId?: string; error?: string }> };
}
