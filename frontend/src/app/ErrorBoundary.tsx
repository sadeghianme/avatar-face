import { Component, ErrorInfo, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";

function Fallback() {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white px-6 text-center dark:bg-ink"
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
        <Icon name="alert" className="h-6 w-6" />
      </span>
      <div>
        <h1 className="text-[20px] font-semibold text-gray-950 dark:text-white">{t("error")}</h1>
        <p className="mt-1.5 text-[15px] text-gray-500 dark:text-gray-400">{t("errorPageBody")}</p>
      </div>
      <button type="button" onClick={() => window.location.reload()} className="btn-primary px-5 py-2.5">
        {t("reloadPage")}
      </button>
    </div>
  );
}

/**
 * Last line of defence: a render error or an unloadable screen shows a way
 * out instead of a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Liveface crashed:", error, info.componentStack);
  }

  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
