/** en: settings strings. A key lives in exactly one file; add new ones here. */
export const settings = {
  orgSettings: "Organization",
  orgName: "Organization name",
  aiSwitchTitle: "Allow third-party AI (Google)",
  aiSwitchHint: "Lets members send pictures to Google (Gemini) to touch them up, redraw or generate them, find an animal’s points, or make a person’s teeth and mouth shapes. Each member agrees before their first use; after that, the wizard also touches up lips parted over the teeth, and makes a person’s teeth and mouth shapes when their avatar is finished, without asking again. When off, avatars are still made by hand, with standard teeth and mouth shapes, and nothing is sent.",
  aiSwitchOn: "On: members can use the AI steps.",
  aiSwitchOff: "Off: no picture is sent to Google.",
  aiSwitchAdminsOnly: "Only owners and admins can change this.",
  aiSwitchNotAllowed: "Only owners and admins can change this.",
  usageAiImages: "AI images: {{used}} / {{limit}}",
  usageAiPoints: "AI point finding: {{used}} / {{limit}}",
} as const;
