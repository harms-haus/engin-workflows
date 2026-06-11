/**
 * jsdom setup for bun test.
 *
 * Initializes a jsdom window and exposes the browser globals that
 * @testing-library/react and @testing-library/jest-dom expect.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});

const w = dom.window;

// Expose jsdom globals so React Testing Library can find document, window, etc.
globalThis.window = w as unknown as typeof globalThis.window;
globalThis.document = w.document;
globalThis.navigator = w.navigator;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Node = w.Node;
globalThis.DocumentFragment = w.DocumentFragment;
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);

// DOM constructors needed by tests (new Event, new CustomEvent, etc.)
globalThis.Event = w.Event;
globalThis.CustomEvent = w.CustomEvent;
globalThis.EventTarget = w.EventTarget;
globalThis.MutationObserver = w.MutationObserver;
globalThis.ResizeObserver = w.ResizeObserver;
globalThis.URL = w.URL;
globalThis.Blob = w.Blob;
globalThis.File = w.File;
globalThis.FormData = w.FormData;
globalThis.XMLHttpRequest = w.XMLHttpRequest;
globalThis.AbortController = w.AbortController;
globalThis.TextEncoder = w.TextEncoder;
globalThis.TextDecoder = w.TextDecoder as typeof TextDecoder;
globalThis.DOMParser = w.DOMParser;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
