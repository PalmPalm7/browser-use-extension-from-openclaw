import { CDPManager } from './cdp-manager';
import type { ActionResult, RefEntry, RefMap } from './types';

interface BoxModelResponse {
  model: {
    content: number[];
    padding: number[];
    border: number[];
    margin: number[];
    width: number;
    height: number;
  };
}

interface ResolveNodeResponse {
  object: {
    objectId: string;
  };
}

type MouseButton = 'left' | 'right' | 'middle';

interface ClickOptions {
  doubleClick?: boolean;
  button?: MouseButton;
  modifiers?: number;
}

interface TypeOptions {
  submit?: boolean;
  slowly?: boolean;
}

export class ActionExecutor {
  private cdp: CDPManager;
  private refMap: RefMap = new Map();

  constructor(cdp: CDPManager) {
    this.cdp = cdp;
  }

  setRefMap(refMap: RefMap): void {
    this.refMap = refMap;
  }

  resolveRef(ref: string): RefEntry {
    const entry = this.refMap.get(ref);
    if (!entry) {
      throw new Error(
        `ref ${ref} not found — element may have changed, take a new snapshot`,
      );
    }
    return entry;
  }

  async getElementCenter(
    tabId: number,
    backendNodeId: number,
  ): Promise<{ x: number; y: number }> {
    const boxModel = await this.cdp.send<BoxModelResponse>(
      tabId,
      'DOM.getBoxModel',
      { backendNodeId },
    );

    const quad = boxModel.model.content;
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    return { x, y };
  }

  async resolveObjectId(tabId: number, backendNodeId: number): Promise<string> {
    const result = await this.cdp.send<ResolveNodeResponse>(
      tabId,
      'DOM.resolveNode',
      { backendNodeId },
    );
    return result.object.objectId;
  }

  async click(
    tabId: number,
    ref: string,
    options?: ClickOptions,
  ): Promise<ActionResult> {
    const entry = this.resolveRef(ref);
    const { backendNodeId } = entry;

    await this.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });

    const { x, y } = await this.getElementCenter(tabId, backendNodeId);

    const button = options?.button ?? 'left';
    const clickCount = options?.doubleClick ? 2 : 1;
    const modifiers = options?.modifiers ?? 0;

    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers,
    });

    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
      modifiers,
    });

    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
      modifiers,
    });

    return { success: true };
  }

  async type(
    tabId: number,
    ref: string,
    text: string,
    options?: TypeOptions,
  ): Promise<ActionResult> {
    const entry = this.resolveRef(ref);
    const { backendNodeId } = entry;

    // Focus the element
    await this.cdp.send(tabId, 'DOM.focus', { backendNodeId });

    // Clear existing value
    const objectId = await this.resolveObjectId(tabId, backendNodeId);
    await this.cdp.send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}))}",
    });

    // Type text
    if (options?.slowly) {
      for (const char of text) {
        await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: char,
          text: char,
        });
        await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: char,
        });
      }
    } else {
      await this.cdp.send(tabId, 'Input.insertText', { text });
    }

    // Submit if requested
    if (options?.submit) {
      await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
      });
      await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
      });
    }

    return { success: true };
  }

  async navigate(tabId: number, url: string): Promise<ActionResult> {
    // Validate URL
    try {
      new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    const response = await this.cdp.send<{ frameId: string; errorText?: string }>(
      tabId,
      'Page.navigate',
      { url },
    );

    if (response.errorText) {
      return { success: false, error: `Navigation failed: ${response.errorText}` };
    }

    // Wait for page load by polling document.readyState
    const maxWaitMs = 15000;
    const pollIntervalMs = 200;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      try {
        const evalResult = await this.cdp.send<{ result: { value: string } }>(
          tabId,
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
        );
        if (evalResult.result.value === 'complete') {
          return { success: true, data: { url } };
        }
      } catch {
        // Page may not be ready for evaluation yet, keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timed out but navigation did start
    return { success: true, data: { url } };
  }

  async execute(
    tabId: number,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ActionResult> {
    try {
      switch (toolName) {
        case 'click':
          return await this.click(tabId, args.ref as string, {
            doubleClick: args.doubleClick as boolean | undefined,
            button: args.button as MouseButton | undefined,
            modifiers: args.modifiers as number | undefined,
          });
        case 'type':
          return await this.type(
            tabId,
            args.ref as string,
            args.text as string,
            {
              submit: args.submit as boolean | undefined,
              slowly: args.slowly as boolean | undefined,
            },
          );
        case 'navigate':
          return await this.navigate(tabId, args.url as string);
        default:
          return { success: false, error: `Unknown action: ${toolName}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
