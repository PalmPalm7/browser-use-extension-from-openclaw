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

interface ScreenshotOptions {
  fullPage?: boolean;
}

interface FillField {
  ref: string;
  type: string;
  value: string;
}

interface WaitConditions {
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  fn?: string;
  timeoutMs?: number;
}

interface CookieSetParams {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

const KEY_CODE_MAP: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
};

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

  async screenshot(
    tabId: number,
    options?: ScreenshotOptions,
  ): Promise<ActionResult> {
    const params: Record<string, unknown> = { format: 'png' };
    if (options?.fullPage) {
      params.captureBeyondViewport = true;
    }

    const result = await this.cdp.send<{ data: string }>(
      tabId,
      'Page.captureScreenshot',
      params,
    );

    return { success: true, data: { base64: result.data } };
  }

  async press(tabId: number, key: string): Promise<ActionResult> {
    const code = KEY_CODE_MAP[key] ?? `Key${key.toUpperCase()}`;

    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
    });
    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
    });

    return { success: true };
  }

  async scroll(tabId: number, ref: string): Promise<ActionResult> {
    const entry = this.resolveRef(ref);
    await this.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: entry.backendNodeId,
    });
    return { success: true };
  }

  async hover(tabId: number, ref: string): Promise<ActionResult> {
    const entry = this.resolveRef(ref);
    const { x, y } = await this.getElementCenter(tabId, entry.backendNodeId);

    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });

    return { success: true };
  }

  async drag(
    tabId: number,
    startRef: string,
    endRef: string,
  ): Promise<ActionResult> {
    const startEntry = this.resolveRef(startRef);
    const endEntry = this.resolveRef(endRef);

    await this.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: startEntry.backendNodeId,
    });

    const start = await this.getElementCenter(tabId, startEntry.backendNodeId);
    const end = await this.getElementCenter(tabId, endEntry.backendNodeId);

    // Move to start position
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x,
      y: start.y,
    });

    // Press at start position
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    });

    // Interpolate movement in ~10 steps
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
      });
    }

    // Release at end position
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      clickCount: 1,
    });

    return { success: true };
  }

  async select(
    tabId: number,
    ref: string,
    values: string[],
  ): Promise<ActionResult> {
    const entry = this.resolveRef(ref);
    const objectId = await this.resolveObjectId(tabId, entry.backendNodeId);

    const result = await this.cdp.send<{ result: { value: string[] } }>(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(values) {
          var selected = [];
          for (var i = 0; i < this.options.length; i++) {
            var opt = this.options[i];
            if (values.indexOf(opt.value) !== -1) {
              opt.selected = true;
              selected.push(opt.value);
            } else {
              opt.selected = false;
            }
          }
          this.dispatchEvent(new Event('change', {bubbles: true}));
          this.dispatchEvent(new Event('input', {bubbles: true}));
          return selected;
        }`,
        arguments: [{ value: values }],
        returnByValue: true,
      },
    );

    return { success: true, data: { selected: result.result.value } };
  }

  async fill(
    tabId: number,
    fields: FillField[],
  ): Promise<ActionResult> {
    let filled = 0;

    for (const field of fields) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        const entry = this.resolveRef(field.ref);
        const objectId = await this.resolveObjectId(tabId, entry.backendNodeId);

        const checkResult = await this.cdp.send<{ result: { value: boolean } }>(
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: 'function() { return this.checked; }',
            returnByValue: true,
          },
        );

        const isChecked = checkResult.result.value;
        const desired = field.value === 'true' || field.value === '1';

        if (isChecked !== desired) {
          await this.click(tabId, field.ref);
        }
      } else if (field.type === 'select') {
        await this.select(tabId, field.ref, [field.value]);
      } else {
        await this.type(tabId, field.ref, field.value);
      }

      filled++;
    }

    return { success: true, data: { filled } };
  }

  async wait(
    tabId: number,
    conditions: WaitConditions,
  ): Promise<ActionResult> {
    const timeoutMs = conditions.timeoutMs ?? 10000;
    const pollIntervalMs = 200;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      let conditionMet = true;

      if (conditions.text !== undefined) {
        const result = await this.cdp.send<{ result: { value: boolean } }>(
          tabId,
          'Runtime.evaluate',
          {
            expression: `document.body.innerText.includes(${JSON.stringify(conditions.text)})`,
            returnByValue: true,
          },
        );
        if (!result.result.value) conditionMet = false;
      }

      if (conditionMet && conditions.textGone !== undefined) {
        const result = await this.cdp.send<{ result: { value: boolean } }>(
          tabId,
          'Runtime.evaluate',
          {
            expression: `!document.body.innerText.includes(${JSON.stringify(conditions.textGone)})`,
            returnByValue: true,
          },
        );
        if (!result.result.value) conditionMet = false;
      }

      if (conditionMet && conditions.selector !== undefined) {
        const result = await this.cdp.send<{ result: { value: boolean } }>(
          tabId,
          'Runtime.evaluate',
          {
            expression: `document.querySelector(${JSON.stringify(conditions.selector)}) !== null`,
            returnByValue: true,
          },
        );
        if (!result.result.value) conditionMet = false;
      }

      if (conditionMet && conditions.url !== undefined) {
        const result = await this.cdp.send<{ result: { value: string } }>(
          tabId,
          'Runtime.evaluate',
          {
            expression: 'location.href',
            returnByValue: true,
          },
        );
        const pattern = conditions.url.replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        if (!regex.test(result.result.value)) conditionMet = false;
      }

      if (conditionMet && conditions.fn !== undefined) {
        const result = await this.cdp.send<{ result: { value: unknown } }>(
          tabId,
          'Runtime.evaluate',
          {
            expression: conditions.fn,
            returnByValue: true,
          },
        );
        if (!result.result.value) conditionMet = false;
      }

      if (conditionMet) {
        return { success: true };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      success: false,
      error: `Wait timed out after ${timeoutMs}ms`,
    };
  }

  async evaluate(
    tabId: number,
    fn: string,
    ref?: string,
  ): Promise<ActionResult> {
    if (ref) {
      const entry = this.resolveRef(ref);
      const objectId = await this.resolveObjectId(tabId, entry.backendNodeId);

      const result = await this.cdp.send<{
        result: { value: unknown };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fn,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        const msg =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Unknown evaluation error';
        return { success: false, error: msg };
      }

      return { success: true, data: result.result.value };
    }

    const result = await this.cdp.send<{
      result: { value: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(tabId, 'Runtime.evaluate', {
      expression: fn,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Unknown evaluation error';
      return { success: false, error: msg };
    }

    return { success: true, data: result.result.value };
  }

  async tabList(): Promise<ActionResult> {
    const tabs = await chrome.tabs.query({});
    const data = tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
    }));
    return { success: true, data };
  }

  async tabOpen(url: string): Promise<ActionResult> {
    const tab = await chrome.tabs.create({ url });
    return {
      success: true,
      data: { id: tab.id, title: tab.title, url: tab.url, active: tab.active },
    };
  }

  async tabClose(tabId: number): Promise<ActionResult> {
    if (this.cdp.isAttached(tabId)) {
      await this.cdp.detach(tabId);
    }
    await chrome.tabs.remove(tabId);
    return { success: true };
  }

  async tabFocus(tabId: number): Promise<ActionResult> {
    await chrome.tabs.update(tabId, { active: true });
    if (!this.cdp.isAttached(tabId)) {
      await this.cdp.attach(tabId);
    }
    return {
      success: true,
      data: { tabId },
    };
  }

  async cookiesGet(tabId: number): Promise<ActionResult> {
    const urlResult = await this.cdp.send<{ result: { value: string } }>(
      tabId,
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
    );
    const currentUrl = urlResult.result.value;

    const result = await this.cdp.send<{ cookies: CookieEntry[] }>(
      tabId,
      'Network.getCookies',
      { urls: [currentUrl] },
    );

    return { success: true, data: result.cookies };
  }

  async cookiesSet(tabId: number, params: CookieSetParams): Promise<ActionResult> {
    if (!params.url) {
      const urlResult = await this.cdp.send<{ result: { value: string } }>(
        tabId,
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
      );
      params.url = urlResult.result.value;
    }

    await this.cdp.send(tabId, 'Network.setCookie', {
      name: params.name,
      value: params.value,
      url: params.url,
      domain: params.domain,
      path: params.path,
      secure: params.secure,
      httpOnly: params.httpOnly,
    });

    return { success: true };
  }

  async setViewport(
    tabId: number,
    width: number,
    height: number,
  ): Promise<ActionResult> {
    await this.cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { success: true };
  }

  async pdf(tabId: number): Promise<ActionResult> {
    const result = await this.cdp.send<{ data: string }>(
      tabId,
      'Page.printToPDF',
      {},
    );
    return { success: true, data: { base64: result.data } };
  }

  async cookiesClear(tabId: number): Promise<ActionResult> {
    const urlResult = await this.cdp.send<{ result: { value: string } }>(
      tabId,
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
    );
    const currentUrl = urlResult.result.value;

    const result = await this.cdp.send<{ cookies: CookieEntry[] }>(
      tabId,
      'Network.getCookies',
      { urls: [currentUrl] },
    );

    for (const cookie of result.cookies) {
      await this.cdp.send(tabId, 'Network.deleteCookies', {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      });
    }

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
        case 'screenshot':
          return await this.screenshot(tabId, {
            fullPage: args.fullPage as boolean | undefined,
          });
        case 'press':
          return await this.press(tabId, args.key as string);
        case 'scroll':
          return await this.scroll(tabId, args.ref as string);
        case 'hover':
          return await this.hover(tabId, args.ref as string);
        case 'drag':
          return await this.drag(
            tabId,
            args.startRef as string,
            args.endRef as string,
          );
        case 'select':
          return await this.select(
            tabId,
            args.ref as string,
            args.values as string[],
          );
        case 'fill':
          return await this.fill(
            tabId,
            args.fields as FillField[],
          );
        case 'wait':
          return await this.wait(tabId, {
            text: args.text as string | undefined,
            textGone: args.textGone as string | undefined,
            selector: args.selector as string | undefined,
            url: args.url as string | undefined,
            fn: args.fn as string | undefined,
            timeoutMs: args.timeoutMs as number | undefined,
          });
        case 'evaluate':
          return await this.evaluate(
            tabId,
            args.fn as string,
            args.ref as string | undefined,
          );
        case 'tab_list':
          return await this.tabList();
        case 'tab_open':
          return await this.tabOpen(args.url as string);
        case 'tab_close':
          return await this.tabClose(args.tabId as number);
        case 'tab_focus':
          return await this.tabFocus(args.tabId as number);
        case 'cookies_get':
          return await this.cookiesGet(tabId);
        case 'cookies_set':
          return await this.cookiesSet(tabId, {
            name: args.name as string,
            value: args.value as string,
            url: args.url as string | undefined,
            domain: args.domain as string | undefined,
            path: args.path as string | undefined,
            secure: args.secure as boolean | undefined,
            httpOnly: args.httpOnly as boolean | undefined,
          });
        case 'cookies_clear':
          return await this.cookiesClear(tabId);
        case 'set_viewport':
          return await this.setViewport(
            tabId,
            args.width as number,
            args.height as number,
          );
        case 'pdf':
          return await this.pdf(tabId);
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
