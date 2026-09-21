/** Reproducible local UI check and actual audiovisual comparison export.
 * PLAYWRIGHT_MODULE may point to the bundled desktop runtime installation.
 * REFERENCE_USER / REFERENCE_PASSWORD identify a disposable local test account.
 */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.REFERENCE_URL || "http://127.0.0.1:5178";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error("This test is restricted to the local disposable workspace.");
if (!process.env.REFERENCE_USER || !process.env.REFERENCE_PASSWORD) throw new Error("Set the disposable test account credentials.");
const out = resolve(process.env.REFERENCE_OUTPUT || "../output/reference-proof");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${base}/login`);
  if (page.url().includes("login")) {
    await page.getByRole("textbox", { name: "Username or email" }).fill(process.env.REFERENCE_USER);
    await page.getByLabel("Password", { exact: true }).fill(process.env.REFERENCE_PASSWORD);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes("login"));
    await page.goto(`${base}/reference-avatar`);
  }
  const aa = page.getByRole("button", { name: "AA", exact: true });
  await aa.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "AA" && !b.disabled));
  await page.getByRole("button", { name: "Mouth close-up", exact: true }).click();
  for (const [label, name] of [["Rest", "rest"], ["P / B / M", "closed"], ["AA", "aa"], ["EE", "ee"], ["OO", "oo"], ["OH", "oh"], ["F / V", "fv"], ["TH", "th"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(350);
    await page.getByRole("region", { name: "Mouth rendering comparison" }).screenshot({ path: `${out}/pose-${name}.png` });
  }
  console.log("All eight poses captured.");
  const frames = await page.evaluate(() => new Promise(resolve => {
    const times = []; let last;
    const tick = now => { if (last !== undefined) times.push(now - last); last = now;
      if (times.length < 120) requestAnimationFrame(tick); else resolve(times); };
    requestAnimationFrame(tick);
  }));
  frames.sort((a, b) => a - b);
  const report = { viewport: { width: 1440, height: 1000 },
    static_paired_preview_frame_interval_ms: { median: frames[60], p95: frames[114], max: frames[119] },
    errors };
  let speech;
  const response = page.waitForResponse(r => r.url().includes("/lab/lip-sync/synthesize") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Generate and compare", exact: true }).click();
  speech = await (await response).json();
  if (!speech.audio_b64) throw new Error(`Speech synthesis failed: ${JSON.stringify(speech)}`);
  await page.getByRole("button", { name: "Record comparison", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "Record comparison" && !b.disabled));
  await writeFile(`${out}/speech.wav`, Buffer.from(speech.audio_b64, "base64"));
  await writeFile(`${out}/speech-timing.json`, JSON.stringify({ duration_ms: speech.duration_ms, timing_source: speech.timing_source, cues: speech.cues }, null, 2));
  for (const mode of ["mouth", "portrait"]) {
    if (mode === "portrait") await page.getByRole("button", { name: "Whole portrait", exact: true }).click();
    await page.getByRole("button", { name: "Record comparison", exact: true }).click();
    const downloadButton = page.getByRole("link", { name: "Download video", exact: true });
    await downloadButton.waitFor({ timeout: 45000 });
    const download = page.waitForEvent("download");
    await downloadButton.click();
    await (await download).saveAs(`${out}/comparison-${mode}.webm`);
    console.log(`Recorded ${mode} comparison with audio.`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/mobile.png`, fullPage: true });
  report.mobile_overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  report.audio_duration_ms = speech.duration_ms;
  report.timing_source = speech.timing_source;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || report.mobile_overflow) process.exitCode = 1;
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
  console.error("Failed at", page.url(), errors);
  throw error;
} finally { await browser.close(); }
