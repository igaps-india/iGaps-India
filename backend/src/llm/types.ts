export type LLMTask = 'rubric' | 'agent' | 'general';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequestOptions {
  task?: LLMTask;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /** If true, response is parsed as JSON and validated */
  jsonMode?: boolean;
}

export interface LLMResponse {
  text: string;
  /** Parsed JSON if jsonMode was true */
  json?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
  provider: string;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], opts?: LLMRequestOptions): Promise<LLMResponse>;
  readonly providerName: string;
  readonly defaultModel: string;
}
