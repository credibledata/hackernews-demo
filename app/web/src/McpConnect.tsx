// The "point your own agent at this" snippet. Shown in the empty state and,
// once the thread has started, in the How-it-works modal — so the command
// stays reachable instead of disappearing after the first message.

import { CopyButton } from './CopyButton';

export const mcpCommand = () =>
  `claude mcp add --transport http hn ${location.origin}/mcp`;

export function McpConnect({ lead }: { lead: string }) {
  const command = mcpCommand();
  return (
    <div className="mcp-connect">
      {lead}
      <div className="mcp-cmd">
        <code>{command}</code>
        <CopyButton text={command} className="copy-btn mcp-copy" />
      </div>
    </div>
  );
}
