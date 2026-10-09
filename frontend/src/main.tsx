import "@/i18n";
import "@/index.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "@/app/App";
import { createQueryClient } from "@/lib/queryClient";
import { AuthProvider } from "@/providers/auth";
import { OrgProvider } from "@/providers/org";
import { ThemeProvider } from "@/providers/theme";

const queryClient = createQueryClient();
// The dev server only: the console can read the query cache. Vite drops
// this from a production build (import.meta.env.DEV is false there).
if (import.meta.env.DEV) {
  (window as unknown as { __queryClient: typeof queryClient }).__queryClient = queryClient;
}

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
