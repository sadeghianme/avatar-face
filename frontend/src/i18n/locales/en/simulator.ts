/** en: simulator strings. A key lives in exactly one file; add new ones here. */
export const simulator = {
  simSubtitle:
    "Paste the embed snippet from any avatar and run it here, on a page of its own, exactly as a visitor's browser would. If it works here it works on your site.",
  simPasteLabel: "Embed snippet",
  simNoScript: "No Liveface script tag found in that paste.",
  simMissing: "Missing required attribute: {{fields}}",
  simInvalid: "Not a valid value: {{fields}}. Copy the snippet again from the avatar's page.",
  simRun: "Run snippet",
  simRerun: "Run again",
  simStarting: "loading the snippet on a blank page…",
  simChecking: "Checking…",
  simWorking: "Working",
  simFailed: "Failed",
  simPreview: "Result",
  simIdle: "Paste a snippet and press Run to see it load.",
  simModeLabel: "Key to run with",
  simModeToken: "Use a test key",
  simModeOwn: "Use my own key",
  simModeTokenHint:
    "Runs with a short-lived key minted for this page. Proves the avatar, voice and widget work — but not that your own key is configured correctly.",
  simModeOwnHint:
    "Runs with the key in the snippet, so it also proves the key itself works. The test page has no domain of its own, so a key locked to domains is refused here: test that one on its own site.",
  simPlaceholderKey: "Replace YOUR_API_KEY with a real key, or switch to a test key.",
  simTokenFailed: "Could not get a test key:",
  simRenewed: "Test key expired — renewed automatically.",
} as const;
