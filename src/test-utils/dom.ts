/**
 * jsdom environment for component tests.
 *
 * IMPORTANT: this module must be imported *before* `react-dom/client`.
 * React DOM decides at module-evaluation time whether DOM APIs exist
 * (`canUseDOM`); if jsdom is installed afterwards, React treats the test as a
 * server render and never wires up input/change event delegation.
 *
 * No testing-library dependency: React's own `act` plus jsdom is enough.
 */

import { JSDOM } from "jsdom";

type GlobalWithAct = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
});

const { window } = dom;

(globalThis as GlobalWithAct).IS_REACT_ACT_ENVIRONMENT = true;

const globals: Record<string, unknown> = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLSelectElement: window.HTMLSelectElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Event: window.Event,
  InputEvent: (window as unknown as { InputEvent?: unknown }).InputEvent ?? window.Event,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  DOMException: window.DOMException,
  getComputedStyle: window.getComputedStyle.bind(window),
};

for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

/**
 * The component delays object-URL revocation by a minute (correct for browsers,
 * but it would keep the test process alive). Run those callbacks immediately.
 */
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
  const timer = setTimeout(() => {
    if (typeof handler === "function") handler(...(args as []));
  }, 0);
  timer.unref?.();
  return timer as unknown as number;
}) as typeof window.setTimeout;

export type ClickRecord = { href: string; download: string };

const clicks: ClickRecord[] = [];

// jsdom tries to navigate on anchor clicks; record them instead.
window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
  clicks.push({ href: this.href, download: this.download });
};

let objectUrlCounter = 0;
const objectUrls = new Set<string>();

Object.defineProperty(window.URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: () => {
    objectUrlCounter += 1;
    const url = `blob:mock-${objectUrlCounter}`;
    objectUrls.add(url);
    return url;
  },
});

Object.defineProperty(window.URL, "revokeObjectURL", {
  configurable: true,
  writable: true,
  value: (url: string) => {
    objectUrls.delete(url);
  },
});

export type DomHarness = {
  window: JSDOM["window"];
  document: Document;
  container: HTMLElement;
  cleanup: () => void;
  setTextareaValue: (id: string, value: string) => void;
  selectOption: (id: string, value: string) => void;
  submitForm: () => void;
  statusText: () => string;
  button: () => HTMLButtonElement;
  clicks: ClickRecord[];
  liveObjectUrls: () => string[];
};

const setNativeValue = (element: HTMLElement, value: string, prototype: object) => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
};

export function setupDom(): DomHarness {
  window.document.body.innerHTML = '<div id="root"></div>';
  clicks.length = 0;

  const container = window.document.getElementById("root");
  if (!container) throw new Error("missing #root");

  return {
    window,
    document: window.document,
    container,
    cleanup: () => {
      window.document.body.innerHTML = "";
      clicks.length = 0;
    },
    setTextareaValue: (id, value) => {
      const element = window.document.getElementById(id) as (HTMLTextAreaElement & { value: string }) | null;
      if (!element) throw new Error(`textarea #${id} not found`);
      setNativeValue(element, value, window.HTMLTextAreaElement.prototype);
    },
    selectOption: (id, value) => {
      const element = window.document.getElementById(id) as (HTMLSelectElement & { value: string }) | null;
      if (!element) throw new Error(`select #${id} not found`);
      setNativeValue(element, value, window.HTMLSelectElement.prototype);
    },
    submitForm: () => {
      const form = window.document.querySelector("form");
      if (!form) throw new Error("form not found");
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    },
    statusText: () => window.document.getElementById("download-status")?.textContent ?? "",
    button: () => window.document.querySelector("button") as HTMLButtonElement,
    clicks,
    liveObjectUrls: () => Array.from(objectUrls),
  };
}
