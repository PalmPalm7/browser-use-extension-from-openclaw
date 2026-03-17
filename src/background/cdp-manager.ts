type EventCallback = (tabId: number, method: string, params: unknown) => void;
type DetachCallback = (tabId: number, reason: string) => void;

export class CDPManager {
  private attachedTabs = new Set<number>();
  private eventCallbacks: EventCallback[] = [];
  private detachCallbacks: DetachCallback[] = [];

  constructor() {
    chrome.debugger.onEvent.addListener(
      (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (source.tabId == null) return;
        for (const cb of this.eventCallbacks) {
          cb(source.tabId, method, params);
        }
      },
    );

    chrome.debugger.onDetach.addListener(
      (source: chrome.debugger.Debuggee, reason: string) => {
        if (source.tabId == null) return;
        this.attachedTabs.delete(source.tabId);
        for (const cb of this.detachCallbacks) {
          cb(source.tabId, reason);
        }
      },
    );
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    this.attachedTabs.add(tabId);

    await Promise.all([
      this.send(tabId, 'Accessibility.enable'),
      this.send(tabId, 'Page.enable'),
      this.send(tabId, 'Network.enable'),
    ]);
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.detach({ tabId }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    this.attachedTabs.delete(tabId);
  }

  async detachAll(): Promise<void> {
    const tabs = [...this.attachedTabs];
    await Promise.all(tabs.map((tabId) => this.detach(tabId)));
  }

  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result as T);
        }
      });
    });
  }

  onEvent(callback: EventCallback): void {
    this.eventCallbacks.push(callback);
  }

  onDetach(callback: DetachCallback): void {
    this.detachCallbacks.push(callback);
  }
}
