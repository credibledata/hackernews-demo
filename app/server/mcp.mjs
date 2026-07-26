// MCP client to the Malloy Publisher server. Discovers the malloy_* tools and
// exposes them in a neutral shape for the LLM driver (with the fixed
// environment/package/model coordinates stripped out and injected at call time),
// and forwards tool calls to Publisher.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, toolDefaults } from './config.mjs';

// Injected server-side; never exposed to the model.
const INJECTED = new Set(['environmentName', 'packageName', 'modelPath']);

/** Drop the injected coordinate params from a tool's JSON Schema. */
function strip(schema) {
  if (!schema?.properties) return schema;
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    if (!INJECTED.has(k)) properties[k] = v;
  }
  const required = (schema.required || []).filter((k) => !INJECTED.has(k));
  return { ...schema, properties, required };
}

export async function connectMcp() {
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl));
  const client = new Client({ name: 'hn-chat', version: '0.1.0' });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  // Expose the read-only tools the analyst needs: discover the model
  // (getContext), learn Malloy syntax (searchDocs), validate a query without
  // running it (compile), and run it (executeQuery).
  const EXPOSE = ['malloy_getContext', 'malloy_searchDocs', 'malloy_compile', 'malloy_executeQuery'];
  const exposed = mcpTools.filter((t) => EXPOSE.includes(t.name));

  // Per tool, only inject the coordinate params the tool actually declares —
  // e.g. searchDocs (global Malloy docs) takes none; compile needs modelPath.
  const injectFor = new Map(
    exposed.map((t) => {
      const props = t.inputSchema?.properties || {};
      const inject = {};
      for (const [k, v] of Object.entries(toolDefaults)) if (k in props) inject[k] = v;
      return [t.name, inject];
    })
  );

  // Neutral tool shape (name/description/parameters); the LLM driver formats it.
  const tools = exposed.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: strip(t.inputSchema),
  }));

  async function callTool(name, input) {
    const res = await client.callTool({
      name,
      arguments: { ...(injectFor.get(name) || {}), ...input },
    });
    // Publisher returns tool output as `text` blocks or `resource` blocks whose
    // payload sits in resource.text — collect both.
    const text = (res.content || [])
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'resource' && c.resource?.text) return c.resource.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return { text, isError: !!res.isError };
  }

  async function close() {
    await client.close().catch(() => {});
  }

  return { tools, callTool, close };
}
