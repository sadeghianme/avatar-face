/**
 * Runs before every rendering test file (vitest.config.ts): Testing
 * Library's matchers, the app's strings (English), jsdom's missing pieces
 * (dom-shims.ts), and a clean page, session, storage and network after
 * each test.
 */
import "@testing-library/jest-dom/vitest";
import "@/i18n";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { setAccessToken } from "@/lib/api";
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
  // The session: the token in lib/api's memory, and the API's cookies.
  setAccessToken(null);
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
  localStorage.clear();
  sessionStorage.clear();
  resetMedia();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
