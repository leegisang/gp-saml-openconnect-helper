#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const rootDir = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.GP_CONFIG || join(rootDir, ".gp.env");

const args = new Set(process.argv.slice(2));
const debug = args.has("--debug");
const once = args.has("--once");
const daemon = args.has("--daemon");
const checkOnly = args.has("--check");
const timeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--timeout="))?.split("=")[1] ||
    (daemon ? 0 : 10 * 60),
) * 1000;
const pollMs = Number(
  process.argv.find((arg) => arg.startsWith("--poll-ms="))?.split("=")[1] ||
    process.env.GP_AUTOFILL_POLL_MS ||
    250,
);
const retryMs = Number(
  process.argv.find((arg) => arg.startsWith("--retry-ms="))?.split("=")[1] ||
    process.env.GP_AUTOFILL_RETRY_MS ||
    250,
);
const maxActionsPerTab = Number(
  process.argv.find((arg) => arg.startsWith("--max-actions="))?.split("=")[1] ||
    process.env.GP_AUTOFILL_MAX_ACTIONS ||
    4,
);

function log(message) {
  console.error(message);
}

function debugLog(message) {
  if (debug) log(`[debug] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvFile(path) {
  const out = {};
  const text = spawnSync("bash", ["-lc", `set -a; source "$1"; env`, "bash", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout;

  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    if (/^(GP_|VPN_)/.test(key)) {
      out[key] = line.slice(idx + 1);
    }
  }
  return out;
}

const env = parseEnvFile(configPath);
const onePasswordItem = process.env.GP_1P_ITEM || env.GP_1P_ITEM || "";
const onePasswordVault = process.env.GP_1P_VAULT || env.GP_1P_VAULT || "";
const mfaMethod = process.env.GP_MFA_METHOD || env.GP_MFA_METHOD || "verification-code";

function splitList(value) {
  return String(value || "")
    .split(/[, \n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHost(value) {
  if (!value) return "";
  try {
    const raw = String(value).trim();
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

const callbackHosts = new Set(
  [
    ...splitList(process.env.GP_APP_CALLBACK_ORIGINS || env.GP_APP_CALLBACK_ORIGINS),
    process.env.VPN_HOST || env.VPN_HOST,
  ]
    .map(normalizeHost)
    .filter(Boolean),
);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function osascript(script, scriptArgs = []) {
  return run("osascript", ["-e", script, ...scriptArgs]);
}

function assertChromeJsEnabled() {
  if (!isChromeRunning()) {
    log("Chrome is not running; skipping AppleScript JavaScript check.");
    return;
  }

  const result = osascript(`
    tell application "Google Chrome"
      if (count of windows) is 0 then return "no-windows"
      tell active tab of front window to return execute javascript "location.href"
    end tell
  `);

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("Executing JavaScript through AppleScript is turned off")) {
      throw new Error(
        "Chrome AppleScript JavaScript is disabled.\n" +
          "Enable it in Chrome: View > Developer > Allow JavaScript from Apple Events",
      );
    }
    throw new Error(stderr || "Failed to execute JavaScript in Chrome.");
  }
}

function isChromeRunning() {
  return run("pgrep", ["-x", "Google Chrome"]).status === 0;
}

function loadOnePasswordCredentials() {
  if (!onePasswordItem) {
    throw new Error(`Missing GP_1P_ITEM in ${configPath}`);
  }

  const opArgs = ["item", "get", onePasswordItem, "--format=json"];
  if (onePasswordVault) opArgs.push("--vault", onePasswordVault);
  const op = run("op", opArgs);
  if (op.status !== 0) {
    throw new Error(
      "Failed to read credentials from 1Password.\n" + op.stderr.trim(),
    );
  }

  const item = JSON.parse(op.stdout);
  const fields = [
    ...(item.fields || []),
    ...(item.sections || []).flatMap((section) => section.fields || []),
  ];
  const byPurpose = (purpose) =>
    fields.find((field) => field.purpose === purpose)?.value || "";
  const byName = (...names) => {
    const normalized = new Set(names.map((name) => name.toLowerCase()));
    return (
      fields.find((field) => {
        const id = String(field.id || "").toLowerCase();
        const label = String(field.label || "").toLowerCase();
        return normalized.has(id) || normalized.has(label);
      })?.value || ""
    );
  };

  const username =
    byPurpose("USERNAME") || byName("username", "email", "user", "login");
  const password = byPurpose("PASSWORD") || byName("password", "pass");
  if (!username || !password) {
    throw new Error(`Could not find username/password in "${onePasswordItem}".`);
  }

  log(`Loaded login credentials from 1Password item "${item.title}".`);
  return { username, password };
}

function loadOnePasswordOtp() {
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % 30;
  if (secondsIntoWindow >= 24) {
    const waitSeconds = 31 - secondsIntoWindow;
    log(`Waiting ${waitSeconds}s for a fresh one-time password window...`);
    spawnSync("sleep", [String(waitSeconds)]);
  }

  const opArgs = ["item", "get", onePasswordItem, "--otp"];
  if (onePasswordVault) opArgs.push("--vault", onePasswordVault);
  const op = run("op", opArgs);
  if (op.status !== 0) return "";
  return op.stdout.trim();
}

function listChromeTabs() {
  if (!isChromeRunning()) return [];

  const result = osascript(`
    set delim to (ASCII character 9)
    set output to ""
    tell application "Google Chrome"
      repeat with wi from 1 to count of windows
        repeat with ti from 1 to count of tabs of window wi
          set currentUrl to URL of tab ti of window wi
          set currentTitle to title of tab ti of window wi
          set output to output & wi & delim & ti & delim & currentUrl & delim & currentTitle & linefeed
        end repeat
      end repeat
    end tell
    return output
  `);
  if (result.status !== 0) return [];

  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, tabIndex, url, title] = line.split("\t");
      return {
        windowIndex,
        tabIndex,
        url: url || "",
        title: title || "",
      };
    });
}

function closeChromeTab(tab) {
  osascript(
    `
    on run argv
      tell application "Google Chrome"
        close tab ((item 2 of argv) as integer) of window ((item 1 of argv) as integer)
      end tell
    end run
  `,
    [String(tab.windowIndex), String(tab.tabIndex)],
  );
}

function isVpnConnected() {
  const defaultRoute = run("route", ["-n", "get", "default"]);
  if (defaultRoute.status !== 0 || !/interface:\s+utun\d+/i.test(defaultRoute.stdout)) {
    return false;
  }

  const routes = run("netstat", ["-rn", "-f", "inet"]);
  return routes.status === 0 && /\butun\d+\b/.test(routes.stdout);
}

function executeJavaScript(tab, js) {
  const dir = mkdtempSync(join(tmpdir(), "gp-app-autofill."));
  const jsPath = join(dir, "script.js");
  writeFileSync(jsPath, js, { mode: 0o600 });
  try {
    const result = osascript(
      `
      on run argv
        set windowIndex to (item 1 of argv) as integer
        set tabIndex to (item 2 of argv) as integer
        set jsPath to item 3 of argv
        set jsSource to read POSIX file jsPath as «class utf8»
        tell application "Google Chrome"
          tell tab tabIndex of window windowIndex
            return execute javascript jsSource
          end tell
        end tell
      end run
    `,
      [String(tab.windowIndex), String(tab.tabIndex), jsPath],
    );
    if (result.status !== 0) {
      debugLog(result.stderr.trim());
      return "";
    }
    return result.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildAutomationScript({ username, password, otp, mfaMethod }) {
  return `
(() => {
  const USERNAME = ${JSON.stringify(username)};
  const PASSWORD = ${JSON.stringify(password)};
  const OTP = ${JSON.stringify(otp || "")};
  const MFA_METHOD = ${JSON.stringify(mfaMethod || "verification-code")};

  const visible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth
    );
  };
  const textOf = (element) => [element.value, element.textContent, element.getAttribute("aria-label"), element.title]
    .filter(Boolean).join(" ").trim();
  const setValue = (element, value) => {
    const proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const inputs = Array.from(document.querySelectorAll("input, textarea")).filter(visible);
  const attr = (element) => [
    element.name,
    element.id,
    element.type,
    element.autocomplete,
    element.placeholder,
    element.getAttribute("aria-label"),
  ].filter(Boolean).join(" ");
  const usernameField = inputs.find((element) =>
    /loginfmt|username|userName|user|email|UPN/i.test(attr(element)) ||
    element.type === "email"
  );
  const passwordField = inputs.find((element) =>
    element.type === "password" || /password|passwd/i.test(attr(element))
  );
  const codeField = inputs.find((element) =>
    /^(|text|tel|number)$/i.test(element.type || "") &&
    (
      /otp|code|verification|one-time|idTxtBx_SAOTCC_OTC/i.test(attr(element)) ||
      element.inputMode === "numeric"
    )
  );
  const clickByText = (pattern) => {
    const candidates = Array.from(document.querySelectorAll("input, button, a, [role='button'], [onclick], div, span"))
      .filter(visible)
      .map((element) => ({ element, text: textOf(element) }))
      .filter(({ text }) => pattern.test(text))
      .sort((a, b) => {
        const weight = (item) =>
          /^(INPUT|BUTTON|A)$/i.test(item.element.tagName) || item.element.getAttribute("role") === "button"
            ? 0
            : 1;
        return weight(a) - weight(b) || a.text.length - b.text.length;
      });
    const target = candidates[0]?.element;
    if (!target) return false;
    clickElement(target);
    return true;
  };
  const clickElement = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    element.click();
    return true;
  };
  const clickSubmit = () =>
    (primarySubmit && clickElement(primarySubmit)) ||
    clickByText(/^(sign in|log in|submit|next|verify|continue|yes|ok|로그인|로그온|확인|다음|계속|예)$/i) ||
    clickByText(/sign in|log in|submit|next|verify|continue|yes|ok|로그인|로그온|확인|다음|계속|예/i);
  const primarySubmit = Array.from(document.querySelectorAll("input[type='submit'], button"))
    .filter(visible)
    .find((element) => /idSIButton9|submit|primary/i.test(attr(element))) ||
    Array.from(document.querySelectorAll("input[type='submit'], button")).filter(visible)[0];
  const primaryText = primarySubmit ? textOf(primarySubmit) : "";
  const submitForm = () => {
    const form =
      document.querySelector("#loginForm") ||
      passwordField?.closest("form") ||
      codeField?.closest("form") ||
      primarySubmit?.closest("form") ||
      document.querySelector("form");
    if (!form) return false;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  };
  const clickOtherSignInWay = () => {
    const target =
      document.querySelector("#signInAnotherWay") ||
      document.querySelector("#idDiv_SAOTCS_HavingTrouble") ||
      Array.from(document.querySelectorAll("a, button, [role='button'], div, span"))
        .filter(visible)
        .map((element) => ({ element, text: textOf(element) }))
        .filter(({ text }) =>
          /I can't use my Microsoft Authenticator app right now|지금은 Microsoft Authenticator 앱을 사용할 수 없습니다|다른 방법|다른 방법으로 로그인|sign in another way/i.test(text)
        )
        .sort((a, b) => {
          const weight = (item) =>
            /^(A|BUTTON)$/i.test(item.element.tagName) || item.element.getAttribute("role") === "button"
              ? 0
              : 1;
          return weight(a) - weight(b) || a.text.length - b.text.length;
        })[0]?.element;
    if (!target || !visible(target)) return false;
    clickElement(target);
    return true;
  };
  const clickProofOption = (pattern) => {
    const roots = Array.from(document.querySelectorAll("#idDiv_SAOTCS_Proofs [role='button'], #idDiv_SAOTCS_Proofs [role='listitem'], #idDiv_SAOTCS_Proofs .row, #idDiv_SAOTCS_Proofs .table"));
    const target = roots
      .map((element) => ({ element, text: textOf(element) }))
      .filter(({ text }) => pattern.test(text))
      .sort((a, b) => {
        const roleWeight = (item) => item.element.getAttribute("role") === "button" ? 0 : 1;
        return roleWeight(a) - roleWeight(b) || a.text.length - b.text.length;
      })[0]?.element;
    if (!target) return false;
    clickElement(target);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  };

  if (MFA_METHOD === "verification-code" && clickOtherSignInWay()) {
    return "selected_other_signin_way";
  }

  if (
    MFA_METHOD === "verification-code" &&
    clickProofOption(/확인 코드 사용|Use a verification code|Use verification code|verification code/i)
  ) {
    return "selected_verification_code";
  }

  if (usernameField && (!passwordField || /^(next|다음)$/i.test(primaryText))) {
    if (usernameField.value !== USERNAME) {
      setValue(usernameField, USERNAME);
      usernameField.focus();
      usernameField.blur();
      return "filled_username";
    }
    clickSubmit();
    return "clicked_username_submit";
  }

  if (passwordField) {
    if (usernameField && usernameField.value !== USERNAME) setValue(usernameField, USERNAME);
    if (passwordField.value !== PASSWORD) {
      setValue(passwordField, PASSWORD);
      passwordField.focus();
      passwordField.blur();
      return "filled_password";
    }
    if (!clickSubmit()) submitForm();
    else if (location.hostname.startsWith("adfs.")) setTimeout(submitForm, 300);
    return "clicked_password_submit";
  }

  if (codeField) {
    if (!OTP) return "needs_otp";
    const currentCode = String(codeField.value || "").replace(/\\D/g, "");
    const desiredCode = String(OTP || "").replace(/\\D/g, "");
    if (currentCode !== desiredCode && currentCode.length < 6) {
      setValue(codeField, OTP);
      codeField.focus();
      codeField.blur();
      return "filled_otp";
    }
    if (!clickSubmit()) submitForm();
    return "clicked_otp_submit";
  }

  if (
    clickByText(/I can't use my Microsoft Authenticator app right now|지금은 Microsoft Authenticator 앱을 사용할 수 없습니다|Use a verification code|Use verification code|Enter a verification code|다른 방법|확인 코드|인증 코드|일회성 코드/i)
  ) {
    return "selected_verification_code";
  }

  if (clickByText(/^(yes|ok|continue|next|done|예|확인|계속|다음|완료)$/i)) {
    return "clicked_prompt";
  }

  return "no_action";
})()
`;
}

function isLoginTab(tab) {
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return false;
    return (
      /(^|\.)login\.microsoftonline\.com$/i.test(url.hostname) ||
      /(^|\.)login\.live\.com$/i.test(url.hostname) ||
      /(^|\.)access\.mcas\.ms$/i.test(url.hostname) ||
      /(^|\.)device\.login\.microsoftonline\.com$/i.test(url.hostname) ||
      /^adfs\./i.test(url.hostname) ||
      /\/SAML20\/SP\/ACS/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isPrivacyTab(tab) {
  try {
    const url = new URL(tab.url);
    return /^https?:$/.test(url.protocol) && /(^|\.)microsoft\.com$/i.test(url.hostname) && /privacy/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isSuccessfulAuthTab(tab) {
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return false;
    return (
      /\/SAML20\/SP\/ACS/i.test(url.pathname) ||
      callbackHosts.has(url.hostname.toLowerCase()) ||
      /(^|\.)gpcloudservice\.com$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

async function main() {
  if (checkOnly) {
    assertChromeJsEnabled();
    return;
  }

  let credentials;
  const getCredentials = () => {
    credentials ||= loadOnePasswordCredentials();
    return credentials;
  };

  log("Watching Chrome tabs opened by GlobalProtect. Press Ctrl-C to stop.");

  const seen = new Map();
  const startedAt = Date.now();
  while (timeoutMs === 0 || Date.now() - startedAt < timeoutMs) {
    const tabs = listChromeTabs();
    if (isVpnConnected()) {
      for (const tab of tabs.filter((tab) => isLoginTab(tab) || isSuccessfulAuthTab(tab))) {
        debugLog(`closing auth tab after VPN connection: ${tab.url}`);
        closeChromeTab(tab);
      }
      if (once) return;
      await sleep(3000);
      continue;
    }

    for (const tab of tabs.filter(isPrivacyTab)) {
      log("Closing Microsoft privacy statement tab.");
      closeChromeTab(tab);
    }

    for (const tab of tabs.filter(isLoginTab)) {
      const key = `${tab.windowIndex}:${tab.tabIndex}`;
      const previousUrl = seen.get(key);
      if (previousUrl !== tab.url) {
        debugLog(`tab ${key}: ${tab.url}`);
        seen.set(key, tab.url);
      }

      for (let attempt = 0; attempt < maxActionsPerTab; attempt++) {
        let action = executeJavaScript(
          tab,
          buildAutomationScript({ ...getCredentials(), mfaMethod }),
        );
        if (action === "needs_otp") {
          const otp = loadOnePasswordOtp();
          action = executeJavaScript(
            tab,
            buildAutomationScript({ ...getCredentials(), otp, mfaMethod }),
          );
        }
        if (!action || action === "no_action") break;
        log(`Chrome autofill: ${action}`);
        if (attempt < maxActionsPerTab - 1) await sleep(retryMs);
      }
    }

    if (once) return;
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
