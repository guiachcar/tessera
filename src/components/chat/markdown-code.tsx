'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { CodeBlock } from './code-block';
import { useChatWorkspaceFileTarget } from './use-chat-file-link';

interface MarkdownCodeProps {
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

interface RenderMarkdownCodeOptions {
  inlineClassName: string;
}

function extractInlineText(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') {
    return children[0];
  }
  return null;
}

/**
 * Inline code span that becomes clickable when its text resolves to a
 * workspace file: click previews the file tab, double-click pins it.
 */
function InlineCode({ inlineClassName, children, ...props }: MarkdownCodeProps & {
  inlineClassName: string;
}) {
  const target = useChatWorkspaceFileTarget(extractInlineText(children));

  if (!target) {
    return (
      <code className={inlineClassName} {...props}>
        {children}
      </code>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') target.preview();
  };

  return (
    <code
      className={`${inlineClassName} cursor-pointer underline-offset-2 hover:underline`}
      role="link"
      tabIndex={0}
      title={`Open ${target.relativePath}`}
      onClick={target.preview}
      onDoubleClick={target.openPinned}
      onKeyDown={handleKeyDown}
      data-testid="chat-inline-file-link"
      {...props}
    >
      {children}
    </code>
  );
}

export function renderMarkdownCode(
  { className, children, ...props }: MarkdownCodeProps,
  { inlineClassName }: RenderMarkdownCodeOptions,
) {
  const match = /language-(\w+)/.exec(className || '');
  const isBlock = match || (typeof children === 'string' && children.includes('\n'));

  if (isBlock) {
    const language = match?.[1] || 'text';
    const code = String(children).replace(/\n$/, '');
    return <CodeBlock code={code} language={language} />;
  }

  return (
    <InlineCode className={className} inlineClassName={inlineClassName} {...props}>
      {children}
    </InlineCode>
  );
}

export function renderMarkdownPre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
