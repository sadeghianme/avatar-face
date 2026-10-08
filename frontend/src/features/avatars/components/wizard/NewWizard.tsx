import { type ReactNode, useState } from "react";

import { FooterSlot } from "@/features/avatars/components/wizard/Footer";
import { ProgressHeader } from "@/features/avatars/components/wizard/ProgressHeader";
import { WizardStep } from "@/features/avatars/components/wizard/WizardStep";
import { useNewWizard } from "@/features/avatars/hooks/useNewWizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/**
 * The creation wizard: 1 Model · 2 Photo · 3 Prepare · 4 Publish (the
 * owner's flow; wizard.ts has the rules, services.wizard the server side).
 *
 * Steps 1 and 2 are this page (`/avatars/new`, `?model=` once one is
 * chosen), so the browser's Back goes from the photo to the model. "Create
 * my avatar" makes a creation and its id goes into the URL
 * (`/avatars/new/:id`, `?step=publish` on step 4): a reload, a shared tab
 * or the resume list lands where it should, and the creation's own state
 * decides what step 4 may show (wizard.screenFor). Back from step 3 goes
 * to step 2 as it was filled in; the draft left behind is deleted (a new
 * one is made with the next "Create").
 *
 * One heading per screen, focused on every change of screen, and one live
 * region, always mounted, for what the server is doing. Every error has a
 * next action beside it. The state is useNewWizard's, the screen
 * WizardStep's; this is the frame around them.
 */
export function NewWizard({
  orgId,
  creationId,
  children,
}: {
  orgId: string;
  creationId?: string;
  /** Shown under the step, inside its scroll area (the other ways to add an avatar). */
  children?: ReactNode;
}) {
  const { t } = useT();
  const wizard = useNewWizard(orgId, creationId);
  // The action bar's element: the screens portal their buttons into it.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <FooterSlot value={slot}>
      {/* The progress stays at the top of the content area, full-bleed
          across it (the main column's padding undone), the steps centred.
          On a short screen (a phone on its side) it scrolls away instead:
          the step needs the height more. */}
      <div
        className={cx(
          "sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 px-4 [@media(max-height:520px)]:static",
          "border-b border-black/[0.06] bg-white/85 backdrop-blur-xl dark:border-white/[0.06] dark:bg-ink/85"
        )}
      >
        <ProgressHeader screen={wizard.screen} />
      </div>

      <WizardStep wizard={wizard}>{children}</WizardStep>

      {/* The step's actions: Back on the left, the primary one on the
          right. A landmark, after the step in the DOM (Tab reaches it last),
          fixed over the content area beside the rail. */}
      <div
        role="region"
        aria-label={t("wzActionsLabel")}
        className="fixed bottom-0 end-0 start-0 z-30 border-t border-black/[0.07] bg-white/90 backdrop-blur-xl dark:border-white/[0.08] dark:bg-ink/90 lg:start-[232px]"
        // Fixed, so the body's side insets do not reach it: its own, and
        // the home indicator's below.
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        <div ref={setSlot} className="flex min-h-[72px] items-center px-4 py-3" />
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {wizard.reconnecting ? t("createReconnecting") : wizard.announcement}
      </p>
      {wizard.consent.dialog}
    </FooterSlot>
  );
}
