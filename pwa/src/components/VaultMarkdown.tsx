import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  lang?: string;
  children?: MarkdownNode[];
};

const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;
const WIKI_URL_PREFIX = "#dome-wiki:";

/** Render inert vault Markdown. Raw HTML and remote images are never activated. */
export function VaultMarkdown({ content }: { readonly content: string }): React.ReactElement {
  return (
    <div className="source-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkFrontmatter, remarkGfm, remarkVaultSyntax]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith(WIKI_URL_PREFIX)) {
              return <span className="source-wikilink">{children}</span>;
            }
            if (href !== undefined && /^https?:\/\//i.test(href)) {
              return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            }
            return <span className="source-link-label">{children}</span>;
          },
          img: ({ alt }) => (
            <span className="source-image-label">Image: {alt?.trim() || "attachment"}</span>
          ),
          input: ({ checked, type }) => type === "checkbox"
            ? <input type="checkbox" checked={Boolean(checked)} readOnly disabled aria-label={checked ? "Completed task" : "Open task"} />
            : null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Keep Obsidian-specific syntax behind the Markdown renderer's private seam:
 * frontmatter remains readable as YAML and wiki-links become inert labels.
 */
function remarkVaultSyntax(): (tree: unknown) => void {
  return (tree: unknown) => transformNode(tree as MarkdownNode);
}

function transformNode(node: MarkdownNode): void {
  if (node.children === undefined || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "yaml") {
      return [{ type: "code", lang: "yaml", value: child.value ?? "" }];
    }
    if (child.type === "text" && child.value !== undefined) return wikiLinkNodes(child.value);
    transformNode(child);
    return [child];
  });
}

function wikiLinkNodes(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  WIKI_LINK.lastIndex = 0;
  for (let match = WIKI_LINK.exec(value); match !== null; match = WIKI_LINK.exec(value)) {
    if (match.index > cursor) nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    const target = match[1] ?? "";
    nodes.push({
      type: "link",
      url: `${WIKI_URL_PREFIX}${encodeURIComponent(target)}`,
      children: [{ type: "text", value: wikiLinkLabel(target) }],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes.length === 0 ? [{ type: "text", value }] : nodes;
}

function wikiLinkLabel(target: string): string {
  const separator = target.indexOf("|");
  const alias = separator >= 0 ? target.slice(separator + 1).trim() : "";
  if (alias.length > 0) return alias;
  const withoutHeading = target.startsWith("#") ? target.slice(1) : target.split("#", 1)[0] ?? target;
  const basename = withoutHeading.includes("/") ? withoutHeading.slice(withoutHeading.lastIndexOf("/") + 1) : withoutHeading;
  return basename.replace(/\.md$/i, "").trim() || target.trim();
}
