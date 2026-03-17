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

  async execute(
    tabId: number,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ActionResult> {
    try {
      switch (toolName) {
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
