// Theme before first paint (same rule as src/providers/theme.tsx): a saved
// choice wins, otherwise follow the system. Avoids a white flash. Loaded by
// index.html as a file, not inline: the dashboard's CSP allows scripts from
// its own origin only (nginx-security-headers.conf).
try {
  const saved = localStorage.getItem("liveface.theme");
  if (saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch {
  // Storage blocked: the app's own provider decides once it runs.
}
