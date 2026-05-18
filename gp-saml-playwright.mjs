#!/usr/bin/env node
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

const config = {
  host: process.env.VPN_HOST || "vpn.example.com",
  user: process.env.VPN_USER || "",
  iface: process.env.GP_INTERFACE || "portal",
  clientos: process.env.GP_CLIENTOS || "Mac",
  ocOs: process.env.GP_OC_OS || "mac-intel",
  openconnect:
    process.env.OPENCONNECT_PATH ||
    spawnSync("which", ["openconnect"], { encoding: "utf8" }).stdout.trim() ||
    "openconnect",
  vpncScript:
    process.env.VPNC_SCRIPT ||
    spawnSync("brew", ["--prefix"], { encoding: "utf8" }).stdout.trim() +
      "/etc/vpnc/vpnc-script",
  chrome:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  profileDir:
    process.env.GP_BROWSER_PROFILE ||
    join(rootDir, ".gp-saml-browser-profile"),
  timeoutMs: Number(process.env.GP_LOGIN_TIMEOUT_MS || 10 * 60 * 1000),
  onePasswordItem: process.env.GP_1P_ITEM || "",
  onePasswordVault: process.env.GP_1P_VAULT || "",
  staySignedIn: (process.env.GP_MS_STAY_SIGNED_IN || "yes").toLowerCase(),
  authgroup: process.env.GP_AUTHGROUP ?? "",
  background: ["1", "true", "yes"].includes(
    (process.env.GP_BACKGROUND || "").toLowerCase(),
  ),
  pidFile:
    process.env.GP_PID_FILE ||
    `/tmp/gp-openconnect-${typeof process.getuid === "function" ? process.getuid() : "user"}.pid`,
};

const preloginPath = {
  portal: "global-protect/prelogin.esp",
  gateway: "ssl-vpn/prelogin.esp",
};

if (!preloginPath[config.iface]) {
  fail(`GP_INTERFACE must be "gateway" or "portal", got "${config.iface}"`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function decodeBase64(text) {
  return Buffer.from(text, "base64").toString("utf8");
}

function findXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : "";
}

function normalizeHost(host) {
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOnePasswordCredentials() {
  if (!config.onePasswordItem) {
    return null;
  }

  const args = ["item", "get", config.onePasswordItem, "--format=json"];
  if (config.onePasswordVault) {
    args.push("--vault", config.onePasswordVault);
  }

  const op = spawnSync("op", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (op.error?.code === "ENOENT") {
    fail(
      "1Password CLI is not installed or not in PATH.\n" +
        "Install it with: brew install 1password-cli",
    );
  }
  if (op.status !== 0) {
    fail(
      "Failed to read credentials from 1Password.\n" +
        op.stderr.trim() +
        "\n\nCheck that the 1Password app CLI integration is enabled and you are signed in.",
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
    byPurpose("USERNAME") ||
    byName("username", "email", "user", "login") ||
    config.user;
  const password = byPurpose("PASSWORD") || byName("password", "pass");

  if (!password) {
    fail(
      `Could not find a password field in 1Password item "${config.onePasswordItem}".`,
    );
  }

  console.error(`Loaded login credentials from 1Password item "${item.title}".`);
  return { username, password };
}

async function getSamlEntry() {
  const host = normalizeHost(config.host);
  const endpoint = `https://${host}/${preloginPath[config.iface]}`;
  const body = new URLSearchParams({
    tmp: "tmp",
    "kerberos-support": "yes",
    "ipv6-support": "yes",
    clientVer: "4100",
    clientos: config.clientos,
  });

  console.error(`Requesting GlobalProtect ${config.iface} SAML prelogin...`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "User-Agent": "PAN GlobalProtect",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const xml = await res.text();

  if (!res.ok) {
    fail(`Prelogin failed with HTTP ${res.status}\n${xml}`);
  }

  const status = findXmlTag(xml, "status");
  const msg = findXmlTag(xml, "msg");
  if (status && status !== "Success") {
    fail(`Prelogin status: ${status}${msg ? `\n${msg}` : ""}`);
  }

  const method = findXmlTag(xml, "saml-auth-method");
  const request = findXmlTag(xml, "saml-request");
  if (!method || !request) {
    fail(
      `Prelogin response did not contain SAML data. Try editing .gp.env ` +
        `and set GP_INTERFACE=portal.\n\n` +
        xml,
    );
  }

  const decoded = decodeBase64(request);
  if (method === "REDIRECT") {
    return { method, url: decoded, html: "" };
  }
  if (method === "POST") {
    return { method, url: endpoint, html: decoded };
  }

  fail(`Unsupported SAML method: ${method}`);
}

function readSamlFieldsFromText(text) {
  const fields = {};
  const comments = text.match(/<!--([\s\S]*?)-->/g) || [];
  for (const raw of comments) {
    const comment = raw.replace(/^<!--/, "").replace(/-->$/, "");
    for (const tag of [
      "prelogin-cookie",
      "portal-userauthcookie",
      "saml-username",
      "saml-auth-status",
      "saml-slo",
      "saml-SessionNotOnOrAfter",
    ]) {
      const value = findXmlTag(comment, tag);
      if (value) fields[tag] = value;
    }
  }
  return fields;
}

function interestingHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("saml-") ||
      lower === "prelogin-cookie" ||
      lower === "portal-userauthcookie"
    ) {
      out[lower] = value;
    }
  }
  return out;
}

function isComplete(result) {
  return Boolean(
    result["saml-username"] &&
      (result["prelogin-cookie"] || result["portal-userauthcookie"]),
  );
}

async function loginAndCapture(entry) {
  mkdirSync(config.profileDir, { recursive: true });
  const credentials = loadOnePasswordCredentials();

  console.error(`Opening Chrome for Microsoft SAML login...`);
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    executablePath: config.chrome,
    viewport: { width: 1180, height: 820 },
    userAgent: "PAN GlobalProtect",
  });

  const result = {};
  let settled = false;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out waiting for SAML login result."));
      }
    }, config.timeoutMs);

    context.on("response", async (response) => {
      if (settled) return;

      const headers = interestingHeaders(response.headers());
      if (Object.keys(headers).length) {
        Object.assign(result, headers);
        try {
          result.server = new URL(response.url()).host;
        } catch {
          result.server = normalizeHost(config.host);
        }
      }

      if (!isComplete(result)) {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("text") || contentType.includes("html")) {
          try {
            const textFields = readSamlFieldsFromText(await response.text());
            if (Object.keys(textFields).length) {
              Object.assign(result, textFields);
              result.server ||= new URL(response.url()).host;
            }
          } catch {
            // Some browser responses are not readable by Playwright; ignore them.
          }
        }
      }

      if (isComplete(result)) {
        clearTimeout(timer);
        settled = true;
        resolve(result);
      }
    });

    context.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("Browser closed before SAML login completed."));
      }
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  if (entry.html) {
    await page.setContent(entry.html, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(entry.url, { waitUntil: "domcontentloaded" });
  }

  const autofill = credentials
    ? automateMicrosoftLogin(page, credentials, () => settled)
    : Promise.resolve();

  try {
    return await done;
  } finally {
    await autofill?.catch(() => {});
    await context.close().catch(() => {});
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        await locator.click({ timeout: 1000 });
        return true;
      }
    } catch {
      // The Microsoft login DOM changes between steps; retry on the next pass.
    }
  }
  return false;
}

async function clickTextIfVisible(page, text) {
  try {
    const locator = page.getByText(text, { exact: false }).first();
    if ((await locator.count()) && (await locator.isVisible())) {
      await locator.click({ timeout: 1000 });
      return true;
    }
  } catch {
    // The account picker may not be present; continue with the normal form flow.
  }
  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) && (await locator.isVisible())) {
        const current = await locator.inputValue().catch(() => "");
        if (current !== value) {
          await locator.fill(value, { timeout: 1000 });
        }
        return true;
      }
    } catch {
      // The Microsoft login DOM changes between steps; retry on the next pass.
    }
  }
  return false;
}

async function clickAnyTextIfVisible(page, texts) {
  for (const text of texts) {
    if (await clickTextIfVisible(page, text)) {
      return true;
    }
  }
  return false;
}

async function automateMicrosoftLogin(page, credentials, isSettled) {
  let enteredUsername = false;
  let enteredPassword = false;
  let handledStaySignedIn = false;
  let clickedPostPasswordPrompt = false;
  const deadline = Date.now() + Math.min(config.timeoutMs, 120_000);

  while (!isSettled() && Date.now() < deadline) {
    const url = page.url();
    if (!/login\.microsoftonline\.com|login\.live\.com|microsoft/i.test(url)) {
      await sleep(500);
      continue;
    }

    if (!enteredUsername) {
      if (await clickTextIfVisible(page, credentials.username)) {
        enteredUsername = true;
        console.error("Selected Microsoft account from existing browser session.");
        await sleep(1200);
        continue;
      }

      const filled = await fillFirstVisible(
        page,
        [
          'input[name="loginfmt"]',
          'input[type="email"]',
          'input#i0116',
          'input[autocomplete="username"]',
        ],
        credentials.username,
      );
      if (filled) {
        enteredUsername = await clickFirstVisible(page, [
          'input[type="submit"]',
          'button[type="submit"]',
          'button:has-text("Next")',
          'button:has-text("다음")',
        ]);
        console.error("Submitted Microsoft username from 1Password.");
        await sleep(1200);
        continue;
      }
    }

    if (!enteredPassword) {
      const filled = await fillFirstVisible(
        page,
        [
          'input[name="passwd"]',
          'input[type="password"]',
          'input#i0118',
          'input[autocomplete="current-password"]',
        ],
        credentials.password,
      );
      if (filled) {
        await clickFirstVisible(page, [
          'input[type="submit"]',
          'button[type="submit"]',
          'button:has-text("Sign in")',
          'button:has-text("로그인")',
        ]);
        enteredPassword = true;
        console.error("Submitted Microsoft password from 1Password.");
        await sleep(1200);
        continue;
      }
    }

    if (enteredPassword && !handledStaySignedIn) {
      if (config.staySignedIn === "yes") {
        handledStaySignedIn = await clickFirstVisible(page, [
          'input#idSIButton9',
          'input[type="submit"][value="Yes"]',
          'button:has-text("Yes")',
          'button:has-text("예")',
        ]);
      } else if (config.staySignedIn === "no") {
        handledStaySignedIn = await clickFirstVisible(page, [
          'input#idBtn_Back',
          'input[type="button"][value="No"]',
          'button:has-text("No")',
          'button:has-text("아니요")',
        ]);
      } else {
        handledStaySignedIn = true;
      }
    }

    if (enteredPassword && !clickedPostPasswordPrompt) {
      clickedPostPasswordPrompt = await clickAnyTextIfVisible(page, [
        "Yes",
        "예",
        "OK",
        "확인",
        "Continue",
        "계속",
        "Next",
        "다음",
        "Done",
        "완료",
      ]);
      if (clickedPostPasswordPrompt) {
        await sleep(1000);
        continue;
      }
    }

    await sleep(700);
  }
}

function runOpenConnect(saml) {
  const cookieName = saml["prelogin-cookie"]
    ? "prelogin-cookie"
    : "portal-userauthcookie";
  const cookie = saml[cookieName];
  const user = saml["saml-username"] || config.user;
  const server = saml.server || normalizeHost(config.host);
  const usergroup = `${config.iface}:${cookieName}`;

  console.error(`SAML login complete for ${user}`);
  console.error(`Starting OpenConnect tunnel to ${server} (${usergroup})...`);

  const sudo = spawnSync("sudo", ["-v"], { stdio: "inherit" });
  if (sudo.status !== 0) {
    process.exit(sudo.status ?? 1);
  }

  const args = [
    config.openconnect,
    "--protocol=gp",
    `--user=${user}`,
    `--os=${config.ocOs}`,
    `--usergroup=${usergroup}`,
    "--passwd-on-stdin",
    "--script",
    config.vpncScript,
  ];

  if (config.authgroup) {
    args.push(`--authgroup=${config.authgroup}`);
  }

  if (config.background) {
    args.push("--background", "--pid-file", config.pidFile);
    console.error(`OpenConnect will run in background. PID file: ${config.pidFile}`);
  }

  args.push(server);

  const child = spawn("sudo", args, {
    stdio: ["pipe", "inherit", "inherit"],
  });

  child.stdin.end(`${cookie}\n`);

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

const entry = await getSamlEntry();
const saml = await loginAndCapture(entry);
runOpenConnect(saml);
