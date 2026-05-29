#!/usr/bin/env node
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.GP_CONFIG || join(rootDir, ".gp.env");

const args = new Set(process.argv.slice(2));
const debug = args.has("--debug");
const daemon = args.has("--daemon");
const prepareProfile = args.has("--prepare-profile");
const timeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--timeout="))?.split("=")[1] ||
    10 * 60,
) * 1000;
const authTimeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--auth-timeout="))?.split("=")[1] ||
    process.env.GP_PLAYWRIGHT_AUTH_TIMEOUT ||
    10 * 60,
) * 1000;
const pollMs = Number(
  process.argv.find((arg) => arg.startsWith("--poll-ms="))?.split("=")[1] ||
    process.env.GP_PLAYWRIGHT_POLL_MS ||
    250,
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

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function parseEnvFile(path) {
  const out = {};
  const text = run("bash", ["-lc", `set -a; source "$1"; env`, "bash", path], {
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout;

  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    if (/^(GP_|VPN_|CHROME_)/.test(key)) out[key] = line.slice(idx + 1);
  }
  return out;
}

function splitList(value) {
  return String(value || "")
    .split(/[, \n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const raw = String(value).trim();
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

const env = parseEnvFile(configPath);
const config = {
  onePasswordItem: process.env.GP_1P_ITEM || env.GP_1P_ITEM || "",
  onePasswordVault: process.env.GP_1P_VAULT || env.GP_1P_VAULT || "",
  mfaMethod: (process.env.GP_MFA_METHOD || env.GP_MFA_METHOD || "verification-code").toLowerCase(),
  staySignedIn: (process.env.GP_MS_STAY_SIGNED_IN || env.GP_MS_STAY_SIGNED_IN || "yes").toLowerCase(),
  chrome:
    process.env.CHROME_PATH ||
    env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  profileDir:
    process.env.GP_APP_PLAYWRIGHT_PROFILE ||
    join(rootDir, ".gp-app-playwright-profile"),
  callbackProtocol:
    process.env.GP_APP_CALLBACK_PROTOCOL ||
    env.GP_APP_CALLBACK_PROTOCOL ||
    "globalprotectcallback",
  callbackOrigins: [
    ...splitList(process.env.GP_APP_CALLBACK_ORIGINS || env.GP_APP_CALLBACK_ORIGINS),
    normalizeOrigin(process.env.VPN_HOST || env.VPN_HOST),
  ],
};
config.callbackOrigins = [...new Set(config.callbackOrigins.map(normalizeOrigin).filter(Boolean))];

function configureExternalProtocolAllowlist() {
  const defaultDir = join(config.profileDir, "Default");
  const preferencesPath = join(defaultDir, "Preferences");
  mkdirSync(defaultDir, { recursive: true });

  let preferences = {};
  if (existsSync(preferencesPath)) {
    preferences = JSON.parse(readFileSync(preferencesPath, "utf8"));
  }

  preferences.protocol_handler ||= {};
  preferences.protocol_handler.allowed_origin_protocol_pairs ||= {};
  preferences.protocol_handler.excluded_schemes ||= {};
  preferences.protocol_handler.policy ||= {};
  preferences.protocol_handler.excluded_schemes[config.callbackProtocol] = false;
  preferences.external_protocol_dialog ||= {};
  preferences.external_protocol_dialog.show_always_open_checkbox = true;

  let changed = false;
  for (const origin of config.callbackOrigins) {
    preferences.protocol_handler.allowed_origin_protocol_pairs[origin] ||= {};
    if (
      preferences.protocol_handler.allowed_origin_protocol_pairs[origin][config.callbackProtocol] !==
      true
    ) {
      preferences.protocol_handler.allowed_origin_protocol_pairs[origin][config.callbackProtocol] = true;
      changed = true;
    }
  }
  const policyAllowlist = [
    {
      protocol: config.callbackProtocol,
      allowed_origins: config.callbackOrigins,
    },
  ];
  if (
    JSON.stringify(preferences.protocol_handler.policy.auto_launch_protocols_from_origins) !==
    JSON.stringify(policyAllowlist)
  ) {
    preferences.protocol_handler.policy.auto_launch_protocols_from_origins = policyAllowlist;
    changed = true;
  }

  writeFileSync(preferencesPath, JSON.stringify(preferences, null, 2));
  debugLog(
    `${changed ? "configured" : "verified"} external protocol allowlist: ` +
      `${config.callbackProtocol} from ${config.callbackOrigins.join(", ")}`,
  );
}

function loadOnePasswordCredentials() {
  if (!config.onePasswordItem) throw new Error(`Missing GP_1P_ITEM in ${configPath}`);

  const opArgs = ["item", "get", config.onePasswordItem, "--format=json"];
  if (config.onePasswordVault) opArgs.push("--vault", config.onePasswordVault);
  const op = run("op", opArgs);
  if (op.status !== 0) throw new Error("Failed to read credentials from 1Password.\n" + op.stderr.trim());

  const item = JSON.parse(op.stdout);
  const fields = [
    ...(item.fields || []),
    ...(item.sections || []).flatMap((section) => section.fields || []),
  ];
  const byPurpose = (purpose) => fields.find((field) => field.purpose === purpose)?.value || "";
  const byName = (...names) => {
    const normalized = new Set(names.map((name) => name.toLowerCase()));
    return fields.find((field) => {
      const id = String(field.id || "").toLowerCase();
      const label = String(field.label || "").toLowerCase();
      return normalized.has(id) || normalized.has(label);
    })?.value || "";
  };

  const username = byPurpose("USERNAME") || byName("username", "email", "user", "login");
  const password = byPurpose("PASSWORD") || byName("password", "pass");
  if (!username || !password) throw new Error(`Could not find username/password in "${config.onePasswordItem}".`);
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

  const opArgs = ["item", "get", config.onePasswordItem, "--otp"];
  if (config.onePasswordVault) opArgs.push("--vault", config.onePasswordVault);
  const op = run("op", opArgs);
  return op.status === 0 ? op.stdout.trim() : "";
}

function osascript(script, scriptArgs = []) {
  return run("osascript", ["-e", script, ...scriptArgs]);
}

function listChromeTabs() {
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
      return { windowIndex, tabIndex, url: url || "", title: title || "" };
    });
}

function closeChromeTab(tab) {
  return osascript(
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

function closeChromeTabsByExactUrl(urlToClose) {
  const result = osascript(
    `
    on run argv
      set urlToClose to item 1 of argv
      set closedCount to 0
      tell application "Google Chrome"
        repeat with wi from (count of windows) to 1 by -1
          repeat with ti from (count of tabs of window wi) to 1 by -1
            set currentUrl to URL of tab ti of window wi
            if currentUrl is urlToClose then
              close tab ti of window wi
              set closedCount to closedCount + 1
            end if
          end repeat
        end repeat
      end tell
      return closedCount as string
    end run
  `,
    [urlToClose],
  );
  return Number(result.stdout.trim() || 0);
}

function closeAuthChromeTabs() {
  const result = osascript(`
    set closedCount to 0
    tell application "Google Chrome"
      repeat with wi from (count of windows) to 1 by -1
        repeat with ti from (count of tabs of window wi) to 1 by -1
          set currentUrl to URL of tab ti of window wi
          if currentUrl starts with "https://login.microsoftonline.com" or currentUrl starts with "http://login.microsoftonline.com" or currentUrl starts with "https://login.live.com" or currentUrl starts with "http://login.live.com" or currentUrl starts with "https://adfs." or currentUrl starts with "http://adfs." or currentUrl contains "://adfs." or currentUrl contains "/SAML20/SP/ACS" then
            close tab ti of window wi
            set closedCount to closedCount + 1
          end if
        end repeat
      end repeat
    end tell
    return closedCount as string
  `);
  return Number(result.stdout.trim() || 0);
}

function isAuthTab(tab) {
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return false;
    return (
      /(^|\.)login\.microsoftonline\.com$/i.test(url.hostname) ||
      /(^|\.)login\.live\.com$/i.test(url.hostname) ||
      /^adfs\./i.test(url.hostname) ||
      /\/SAML20\/SP\/ACS/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isStartAuthTab(tab) {
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return false;
    return (
      /(^|\.)login\.microsoftonline\.com$/i.test(url.hostname) ||
      /^adfs\./i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function isVpnConnected() {
  const defaultRoute = run("route", ["-n", "get", "default"]);
  if (defaultRoute.status !== 0 || !/interface:\s+utun\d+/i.test(defaultRoute.stdout)) return false;
  const routes = run("netstat", ["-rn", "-f", "inet"]);
  return routes.status === 0 && /\butun\d+\b/.test(routes.stdout);
}

function isSuccessfulAuthTab(tab) {
  try {
    const url = new URL(tab.url);
    return /^https?:$/.test(url.protocol) && /\/SAML20\/SP\/ACS/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function clickFirstVisible(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        await locator.click({ timeout: 800, ...options });
        return true;
      }
    } catch {
      // The Microsoft login DOM changes between steps.
    }
  }
  return false;
}

async function clickFirstVisibleLoose(page, selectors) {
  if (await clickFirstVisible(page, selectors, { force: true })) return true;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        await locator.evaluate((element) => element.click());
        return true;
      }
    } catch {
      // Continue to next selector.
    }
  }
  return false;
}

async function clickTextIfVisible(page, text) {
  try {
    const locator = page.getByText(text, { exact: false }).first();
    if ((await locator.count()) && (await locator.isVisible())) {
      await locator.click({ timeout: 800 });
      return true;
    }
  } catch {
    // Continue.
  }
  return false;
}

async function clickAnyTextIfVisible(page, texts) {
  for (const text of texts) {
    if (await clickTextIfVisible(page, text)) return true;
  }
  return false;
}

async function clickVisibleChoiceByExactText(page, choices) {
  return page.evaluate((choiceTexts) => {
    const normalizedChoices = choiceTexts.map((text) => text.toLowerCase());
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth
      );
    };
    const label = (element) =>
      [
        element.value,
        element.innerText,
        element.textContent,
        element.getAttribute("aria-label"),
        element.title,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const weight = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === "button" || tag === "input") return 3;
      if (element.getAttribute("role") === "button") return 2;
      return 1;
    };
    const candidates = Array.from(
      document.querySelectorAll('input,button,a,[role="button"],div,span'),
    )
      .filter(visible)
      .map((element) => ({ element, text: label(element), weight: weight(element) }))
      .filter(({ text }) => normalizedChoices.includes(text.toLowerCase()))
      .sort((a, b) => b.weight - a.weight || a.text.length - b.text.length);
    const target = candidates[0]?.element;
    if (!target) return "";

    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus?.();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    target.click();
    return candidates[0].text;
  }, choices).catch(() => "");
}

async function checkVisibleCheckboxByText(page, texts) {
  return page.evaluate((labelTexts) => {
    const normalizedLabels = labelTexts.map((text) => text.toLowerCase());
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth
      );
    };
    const textOf = (element) =>
      [element.innerText, element.textContent, element.getAttribute("aria-label"), element.title]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
    for (const checkbox of checkboxes) {
      const id = checkbox.id ? CSS.escape(checkbox.id) : "";
      const label =
        (id ? document.querySelector(`label[for="${id}"]`) : null) ||
        checkbox.closest("label") ||
        checkbox.parentElement;
      const labelText = textOf(label || checkbox);
      if (normalizedLabels.some((text) => labelText.includes(text)) && !checkbox.checked) {
        checkbox.scrollIntoView({ block: "center", inline: "center" });
        checkbox.click();
        return true;
      }
    }
    return false;
  }, texts).catch(() => false);
}

async function handleStaySignedInPrompt(page) {
  const promptVisible =
    /DeviceAuthTls\/reprocess|kmsi/i.test(page.url()) ||
    (await hasVisible(page, [
      'text="Stay signed in?"',
      'text="로그인 상태를 유지"',
      'text="로그인 상태 유지"',
    ]));
  if (!promptVisible) return false;

  const accept = config.staySignedIn !== "no";
  if (accept) {
    await checkVisibleCheckboxByText(page, [
      "don't show this again",
      "do not show this again",
      "다시 표시하지 않음",
      "다시 묻지 않음",
    ]);
  }

  const choices = accept ? ["Yes", "예"] : ["No", "아니요", "아니오"];
  const clickedText = await clickVisibleChoiceByExactText(page, choices);
  if (clickedText) {
    log(`${accept ? "Accepted" : "Declined"} stay-signed-in prompt.`);
    await sleep(500);
    return true;
  }

  const selectors = accept
    ? [
        'input#idSIButton9',
        'button#idSIButton9',
        'input[type="submit"][value="Yes"]',
        'input[type="button"][value="Yes"]',
        'input[type="submit"][value="예"]',
        'input[type="button"][value="예"]',
        '[role="button"]:has-text("Yes")',
        '[role="button"]:has-text("예")',
        'button:has-text("Yes")',
        'button:has-text("예")',
      ]
    : [
        'input#idBtn_Back',
        'button#idBtn_Back',
        'input[type="button"][value="No"]',
        'input[type="submit"][value="No"]',
        'input[type="button"][value="아니요"]',
        'input[type="submit"][value="아니요"]',
        '[role="button"]:has-text("No")',
        '[role="button"]:has-text("아니요")',
        'button:has-text("No")',
        'button:has-text("아니요")',
      ];
  if (await clickFirstVisibleLoose(page, selectors)) {
    log(`${accept ? "Accepted" : "Declined"} stay-signed-in prompt.`);
    await sleep(500);
    return true;
  }

  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        const current = await locator.inputValue().catch(() => "");
        if (current !== value) await locator.fill(value, { timeout: 800 });
        return true;
      }
    } catch {
      // Continue.
    }
  }
  return false;
}

async function hasVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) return true;
    } catch {
      // Continue.
    }
  }
  return false;
}

async function pressEnterFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        await locator.press("Enter", { timeout: 800 });
        return true;
      }
    } catch {
      // Continue.
    }
  }
  return false;
}

async function submitVisibleLoginForm(page, submitSelectors, passwordSelectors) {
  if (await pressEnterFirstVisible(page, passwordSelectors)) return "enter";
  if (await clickFirstVisibleLoose(page, submitSelectors)) return "click";

  const submitted = await page.evaluate(() => {
    const active = document.activeElement;
    const password =
      document.querySelector('input[type="password"]') ||
      document.querySelector("#passwordInput") ||
      document.querySelector("#password");
    const form = password?.closest("form") || active?.closest?.("form");
    if (!form) return false;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  }).catch(() => false);
  return submitted ? "form-submit" : "";
}

async function submitVerificationCode(page, verifySelectors, codeSelectors) {
  if (await clickFirstVisibleLoose(page, verifySelectors)) return "click";
  if (await pressEnterFirstVisible(page, codeSelectors)) return "enter";
  return "";
}

async function maybeUseVerificationCodeMfa(page, codeSelectors, verifySelectors) {
  if (await hasVisible(page, codeSelectors)) {
    const otp = loadOnePasswordOtp();
    if (!otp) throw new Error(`No one-time password field found in "${config.onePasswordItem}".`);
    if (await fillFirstVisible(page, codeSelectors, otp)) {
      const submitMethod = await submitVerificationCode(page, verifySelectors, codeSelectors);
      if (submitMethod) {
        log(`Submitted verification code from 1Password (${submitMethod}).`);
        await sleep(500);
        return true;
      }
    }
  }

  if (
    await clickAnyTextIfVisible(page, [
      "I can't use my Microsoft Authenticator app right now",
      "지금은 Microsoft Authenticator 앱을 사용할 수 없습니다",
      "Use a verification code",
      "Use verification code",
      "Enter a verification code",
      "확인 코드 사용",
      "확인 코드",
      "인증 코드",
    ])
  ) {
    log("Selected verification code MFA option.");
    await sleep(500);
    return true;
  }

  return false;
}

async function automate(page, credentials, deadline) {
  const usernameSelectors = [
    'input[name="loginfmt"]',
    'input[name="UserName"]',
    'input[name="username"]',
    'input[type="email"]',
    'input#i0116',
    'input#userNameInput',
    'input#username',
    'input[autocomplete="username"]',
  ];
  const passwordSelectors = [
    'input[name="passwd"]',
    'input[name="Password"]',
    'input[name="password"]',
    'input[type="password"]',
    'input#i0118',
    'input#passwordInput',
    'input#password',
    'input[autocomplete="current-password"]',
  ];
  const submitSelectors = [
    '#submitButton',
    '[id="submitButton"]',
    '.submit',
    '[role="button"]:has-text("Sign in")',
    '[role="button"]:has-text("로그인")',
    'input[type="submit"]',
    'input[type="button"]',
    'button[type="submit"]',
    'input[value="Sign in"]',
    'input[value="로그인"]',
    'button:has-text("Sign in")',
    'button:has-text("로그인")',
  ];
  const nextSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Next")',
    'button:has-text("다음")',
  ];
  const codeSelectors = [
    'input[name="otc"]',
    'input[name="code"]',
    'input[name="verificationCode"]',
    'input#idTxtBx_SAOTCC_OTC',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="number"]',
  ];
  const verifySelectors = [
    'input#idSubmit_SAOTCC_Continue',
    'button#idSubmit_SAOTCC_Continue',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("확인")',
    'button:has-text("다음")',
    'button:has-text("계속")',
  ];

  let lastUrl = "";
  let lastPasswordSubmitAt = 0;
  while ((deadline === 0 || Date.now() < deadline) && !isVpnConnected()) {
    if (page.isClosed()) return false;
    const url = page.url();
    if (debug && url !== lastUrl) {
      debugLog(`Playwright page: ${url}`);
      lastUrl = url;
    }

    if (await handleStaySignedInPrompt(page)) {
      continue;
    }

    if (config.mfaMethod === "verification-code" && (await maybeUseVerificationCodeMfa(page, codeSelectors, verifySelectors))) {
      continue;
    }

    if ((await hasVisible(page, passwordSelectors)) && Date.now() - lastPasswordSubmitAt > 1000) {
      await fillFirstVisible(page, usernameSelectors, credentials.username);
      if (await fillFirstVisible(page, passwordSelectors, credentials.password)) {
        lastPasswordSubmitAt = Date.now();
        const method = await submitVisibleLoginForm(page, submitSelectors, passwordSelectors);
        if (method) {
          log(`Submitted password from 1Password (${method}).`);
          await sleep(500);
          continue;
        }
      }
    }

    if (await clickTextIfVisible(page, credentials.username)) {
      log("Selected Microsoft account from existing browser session.");
      await sleep(500);
      continue;
    }

    if (await fillFirstVisible(page, usernameSelectors, credentials.username)) {
      await clickFirstVisibleLoose(page, nextSelectors);
      log("Submitted username from 1Password.");
      await sleep(500);
      continue;
    }

    if (await clickAnyTextIfVisible(page, ["Yes", "예", "OK", "확인", "Continue", "계속", "Next", "다음", "Done", "완료"])) {
      await sleep(500);
      continue;
    }

    await sleep(200);
  }

  return isVpnConnected();
}

async function waitForAuthUrl() {
  log("Watching Chrome for GlobalProtect SAML URL. Press Ctrl-C to stop.");
  const waitForever = daemon || timeoutMs === 0;
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (waitForever || Date.now() < deadline) {
    const tab = listChromeTabs().find(isStartAuthTab);
    if (tab) {
      if (tab.url !== lastUrl) debugLog(`captured auth URL: ${tab.url}`);
      return tab;
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for GlobalProtect SAML URL in Chrome.");
}

async function runOnce() {
  const sourceTab = await waitForAuthUrl();
  const sourceUrl = sourceTab.url;
  const credentials = loadOnePasswordCredentials();

  const closedOriginalTabs = closeChromeTabsByExactUrl(sourceUrl);
  if (closedOriginalTabs > 0) debugLog(`closed original GlobalProtect SAML tab(s): ${closedOriginalTabs}`);

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chrome,
    headless: false,
    viewport: null,
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.on("dialog", async (dialog) => {
      debugLog(`accepted browser dialog: ${dialog.type()} ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    log("Moved GlobalProtect SAML login to Playwright Chrome.");

    const connected = await automate(page, credentials, authTimeoutMs === 0 ? 0 : Date.now() + authTimeoutMs);
    if (connected) {
      log("VPN connected. Closing Playwright auth window.");
      await context.close();
      const closedAuthTabs = closeAuthChromeTabs();
      if (closedAuthTabs > 0) debugLog(`closed remaining auth tab(s): ${closedAuthTabs}`);
      return true;
    }
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  configureExternalProtocolAllowlist();
  if (prepareProfile) return;

  if (!daemon) {
    await runOnce();
    return;
  }

  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      log(error.message || String(error));
      await sleep(5000);
    }
    await sleep(1000);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
