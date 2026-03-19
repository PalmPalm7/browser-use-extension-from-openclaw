import { CDPManager } from './cdp-manager';
import type { HybridSnapshot, RefEntry, RefMap } from './types';

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
  'switch', 'tab', 'textbox', 'treeitem',
]);

const CONTENT_ROLES = new Set([
  'heading', 'img', 'listitem', 'cell', 'row', 'table', 'list',
  'paragraph', 'blockquote', 'code', 'contentinfo', 'navigation',
  'banner', 'main', 'complementary', 'form', 'region', 'alert',
  'dialog', 'status', 'tooltip',
]);

const VALUE_ROLES = new Set([
  'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton',
]);

interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

interface AXTreeResponse {
  nodes: AXNode[];
}

interface ScreenshotResponse {
  data: string;
}

export class SnapshotEngine {
  private cdp: CDPManager;
  private maxDepth: number;
  private maxChars: number;

  constructor(cdp: CDPManager, maxDepth = 10, maxChars = 30000) {
    this.cdp = cdp;
    this.maxDepth = maxDepth;
    this.maxChars = maxChars;
  }

  async takeSnapshot(tabId: number): Promise<HybridSnapshot> {
    const [axTree, screenshotResult] = await Promise.all([
      this.cdp.send<AXTreeResponse>(tabId, 'Accessibility.getFullAXTree'),
      this.cdp.send<ScreenshotResponse>(tabId, 'Page.captureScreenshot', {
        format: 'png',
      }),
    ]);

    const pageInfo = await this.cdp.send<{ result: { value: string } }>(
      tabId,
      'Runtime.evaluate',
      { expression: 'JSON.stringify({url: location.href, title: document.title})', returnByValue: true },
    );

    const { url, title } = JSON.parse(pageInfo.result.value) as { url: string; title: string };

    const refMap: RefMap = new Map();
    let refCounter = 0;
    let totalElements = 0;
    let visibleElements = 0;
    let truncated = false;

    // Build node lookup by nodeId
    const nodeMap = new Map<string, AXNode>();
    for (const node of axTree.nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // Find root node (first node is typically root)
    const rootNode = axTree.nodes[0];
    if (!rootNode) {
      return {
        text: `Page: "${title}" | URL: ${url}\n\n[empty accessibility tree]`,
        screenshotBase64: screenshotResult.data,
        refMap,
        metadata: { url, title, truncated: false, totalElements: 0, visibleElements: 0 },
      };
    }

    // Build text output
    let text = `Page: "${title}" | URL: ${url}\n\n`;
    let charCount = text.length;

    const walkNode = (nodeId: string, depth: number): void => {
      if (depth > this.maxDepth) return;
      if (truncated) return;

      const node = nodeMap.get(nodeId);
      if (!node) return;
      if (node.ignored) {
        // Still walk children of ignored nodes
        if (node.childIds) {
          for (const childId of node.childIds) {
            walkNode(childId, depth);
          }
        }
        return;
      }

      totalElements++;

      const role = node.role?.value ?? '';
      const name = node.name?.value ?? '';
      const value = node.value?.value ?? '';
      const backendNodeId = node.backendDOMNodeId;

      // Determine if this node gets a ref
      let ref: string | null = null;
      const isInteractive = INTERACTIVE_ROLES.has(role);
      const isContent = CONTENT_ROLES.has(role);

      if (isInteractive || (isContent && name)) {
        refCounter++;
        ref = `e${refCounter}`;
        visibleElements++;

        if (backendNodeId != null) {
          const properties: Record<string, unknown> = {};
          if (node.properties) {
            for (const prop of node.properties) {
              properties[prop.name] = prop.value.value;
            }
          }

          const entry: RefEntry = {
            backendNodeId,
            role,
            name,
            properties,
          };
          if (value) {
            entry.value = value;
          }

          refMap.set(ref, entry);
        }
      }

      // Format the line if this node has a ref
      if (ref) {
        const indent = '  '.repeat(depth);
        let line = `${indent}[${ref}] ${role}`;
        if (name) {
          line += ` "${name}"`;
        }
        if (value && VALUE_ROLES.has(role)) {
          line += ` value="${value}"`;
        }

        // Annotate states
        const states = this.getStates(node);
        if (states) {
          line += ` ${states}`;
        }

        line += '\n';

        if (charCount + line.length > this.maxChars) {
          truncated = true;
          return;
        }

        text += line;
        charCount += line.length;
      }

      // Walk children
      if (node.childIds) {
        const childDepth = ref ? depth + 1 : depth;
        for (const childId of node.childIds) {
          walkNode(childId, childDepth);
        }
      }
    };

    // Start walking from root's children (root is usually "RootWebArea")
    if (rootNode.childIds) {
      for (const childId of rootNode.childIds) {
        walkNode(childId, 0);
      }
    } else {
      walkNode(rootNode.nodeId, 0);
    }

    if (truncated) {
      const remaining = totalElements - visibleElements;
      text += `\n[truncated - ${remaining} more elements not shown]\n`;
    }

    return {
      text,
      screenshotBase64: screenshotResult.data,
      refMap,
      metadata: { url, title, truncated, totalElements, visibleElements },
    };
  }

  private getStates(node: AXNode): string {
    if (!node.properties) return '';

    const states: string[] = [];
    for (const prop of node.properties) {
      if (prop.name === 'focused' && prop.value.value === true) {
        states.push('focused');
      }
      if (prop.name === 'checked' && prop.value.value === true) {
        states.push('checked');
      }
      if (prop.name === 'disabled' && prop.value.value === true) {
        states.push('disabled');
      }
    }

    return states.length > 0 ? `(${states.join(', ')})` : '';
  }
}
