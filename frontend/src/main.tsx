import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "@/app/App";
import "@/i18n";
import "@/index.css";
import { AuthProvider } from "@/providers/auth";
import { OrgProvider } from "@/providers/org";
import { ThemeProvider } from "@/providers/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      // Don't pause queries on flaky onLine signals (embedded webviews and
      // headless browsers misreport connectivity); let fetch itself fail.
      networkMode: "always",
    },
  },
});
// Dev aid: lets the console inspect query state (harmless in prod).
(window as unknown as { __queryClient: QueryClient }).__queryClient = queryClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <OrgProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </OrgProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
