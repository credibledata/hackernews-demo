// Central config for the chat backend. All overridable by env so the same build
// runs locally and in the container.

export const config = {
  port: Number(process.env.PORT || 8787),
  // Publisher endpoints (internal — the backend talks to them over loopback).
  mcpUrl: process.env.PUBLISHER_MCP_URL || 'http://127.0.0.1:4040/mcp',
  restUrl: process.env.PUBLISHER_REST_URL || 'http://127.0.0.1:4000/api/v0',
  // The single package this demo serves.
  environmentName: process.env.HN_ENV || 'hn',
  packageName: process.env.HN_PACKAGE || 'hacker-news',
  modelPath: process.env.HN_MODEL_PATH || 'hn.malloy',
  // OpenAI.
  model: process.env.HN_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6-luna',
  maxTokens: Number(process.env.HN_MAX_TOKENS || 8000),
};

// Fixed arguments injected into every MCP tool call so the model never has to
// supply (or hallucinate) the environment / package / model coordinates.
export const toolDefaults = {
  environmentName: config.environmentName,
  packageName: config.packageName,
  modelPath: config.modelPath,
};
