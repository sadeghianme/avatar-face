/** en: settings strings. A key lives in exactly one file; add new ones here. */
export const settings = {
  orgSettings: "Organization",
  orgName: "Organization name",
  aiSwitchTitle: "Allow third-party AI (Google)",
  aiSwitchHint:
    "Lets members send photos and descriptions to Google (Gemini) to create and adjust an avatar’s picture in a chosen style, find an animal’s points, and make a realistic person’s own teeth and mouth shapes when their avatar is published. Each member agrees before their first use, and again if the wording changes. When off, avatars can still be made from a realistic photo, with standard teeth and mouth shapes, and nothing is sent.",
  aiSwitchOn: "On: members can use the AI steps.",
  aiSwitchOff: "Off: no picture is sent to Google.",
  aiSwitchAdminsOnly: "Only owners and admins can change this.",
  aiSwitchNotAllowed: "Only owners and admins can change this.",
  usageAiImages: "AI images: {{used}} / {{limit}}",
  usageAiPoints: "AI point finding: {{used}} / {{limit}}",
  sessionsTitle: "Signed-in devices",
  sessionsHint:
    "Signed in on a computer you no longer use, or think someone else has your password? Log out everywhere ends every session of your account, this one included. Setting a new password does the same.",
  logoutEverywhere: "Log out everywhere",
  logoutEverywhereAsk: "Log out on every device, this one too?",
  logoutEverywhereFailed: "Could not log out everywhere. Try again.",
} as const;
