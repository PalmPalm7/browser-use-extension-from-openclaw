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
