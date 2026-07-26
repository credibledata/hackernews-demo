// Renders assistant answers as markdown. The backend model emits markdown
// (bold, bullet lists, the occasional table), so we parse it rather than dump
// the raw string. GFM adds tables/strikethrough/autolinks. Safe under streaming
// — react-markdown re-parses on each token and tolerates half-written markup.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
