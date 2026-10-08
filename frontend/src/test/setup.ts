/**
 * Runs before every rendering test file (vitest.config.ts): Testing
 * Library's matchers, the app's strings (English), jsdom's missing pieces
 * (dom-shims.ts), and a clean page, storage and network after each test.
 */
import "@testing-library/jest-dom/vitest";
import "@/i18n";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { installDomShims, resetMedia } from "@/test/dom-shims";

installDomShims();

// React Router 6 announces its v7 changes on every router it mounts; the
// app's router (main.tsx) has the same settings, so they are noise here.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("React Router Future Flag Warning")) return;
  warn(...args);
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  resetMedia();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
