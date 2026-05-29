# GlobalProtect App Login Helper

This repo automates the browser login step for the official macOS
`GlobalProtect.app`.

The recommended flow is:

1. GlobalProtect opens the Microsoft SAML login URL in Chrome.
2. This helper moves that URL into a Playwright-controlled Chrome profile.
3. Playwright fills username/password from 1Password.
4. Playwright selects `Use a verification code` and submits the current
   1Password one-time password.
5. Chrome hands the result back to `GlobalProtect.app`.

It does not bypass MFA. It automates the verification-code MFA method that you
already registered.

## Requirements

Required for the recommended official-app flow:

```bash
brew install node 1password-cli
npm install
```

Also required:

- macOS GlobalProtect app installed.
- Google Chrome installed.
- 1Password desktop app integration enabled:

```text
1Password > Settings > Developer > Integrate with 1Password CLI
```

`./gp setup` installs the Homebrew/npm dependencies for this flow.

## 1Password Item

Create or update a 1Password login item with:

- username
- password
- one-time password

For Microsoft work/school accounts, add the one-time password from:

```text
https://mysignins.microsoft.com/security-info
```

Choose Microsoft Authenticator, select manual code entry, then paste the secret
into the 1Password item's one-time password field.

Quick check:

```bash
op item get "Company VPN" --otp
```

## GlobalProtect App Setting

Make GlobalProtect use the default browser for SAML login:

```bash
sudo defaults write /Library/Preferences/com.paloaltonetworks.GlobalProtect.settings.plist '{"Palo Alto Networks" ={GlobalProtect={Settings={default-browser=yes;};};};}'
```

Then quit and reopen GlobalProtect if it was already running.

## Chrome Apple Events

The Playwright flow does not need Chrome's Apple Events JavaScript setting. The
older AppleScript fallback does. To check or enable it:

```bash
./gp chrome-js status
./gp chrome-js enable
```

Restart Chrome if Chrome's UI does not reflect the change immediately.

## Configure

Interactive config:

```bash
./gp init
./gp doctor
```

Or copy the example:

```bash
cp .gp.env.example .gp.env
```

Edit `.gp.env`:

```bash
GP_1P_ITEM="Company VPN"
# GP_1P_VAULT="Private"

GP_MFA_METHOD="verification-code"
GP_MS_STAY_SIGNED_IN=yes

VPN_HOST="vpn.example.com"
```

`VPN_HOST` is used as the callback origin hint. If your GlobalProtect portal is
different, set:

```bash
GP_APP_CALLBACK_ORIGINS="https://connect.example.com"
```

Your real `.gp.env` is ignored by git.

## Install Aliases

Install the Playwright flow as the default helper:

```bash
./gp app-playwright install
source ~/.zshrc
```

`install` also copies the Playwright runtime and a config snapshot into:

```text
~/Library/Application Support/gp-app-login-helper/
```

This avoids macOS LaunchAgent permission issues with repos under `Documents`.
Run `./gp app-playwright install` again after changing `.gp.env` or updating the
repo.

Aliases:

```bash
gpauto      # Playwright flow
gpautopw    # same as gpauto, kept for compatibility
gpautofill  # older AppleScript fallback
```

## Daily Use

Foreground/debug watcher:

```bash
gpauto
```

Then click Connect in the GlobalProtect app.

Background watcher:

```bash
./gp app-playwright install
./gp app-playwright start
./gp app-playwright status
./gp app-playwright stop
```

When the background watcher is running, just click Connect in the GlobalProtect
app. The helper runs as a macOS LaunchAgent, waits for the SAML URL without an
open terminal, completes the browser login, then keeps waiting for the next
connection.

## Status

Check current VPN state:

```bash
./gp status
```

Disconnect the official GlobalProtect app from the app UI.

## Commands

```bash
./gp init                         # create .gp.env
./gp doctor                       # check local setup
./gp status                       # show official app route state

./gp app-playwright run --debug   # foreground Playwright watcher
./gp app-playwright install       # install LaunchAgent + aliases
./gp app-playwright start         # start background watcher
./gp app-playwright stop          # stop background watcher
./gp app-playwright status        # show watcher status
./gp app-playwright uninstall     # remove watcher + aliases

./gp app-autofill run --debug     # AppleScript fallback
./gp chrome-js status             # check Chrome Apple Events JS fallback setting
./gp chrome-js enable             # enable Chrome Apple Events JS fallback setting
```

## Files

- `gp`: main CLI for config, status, and the app watcher.
- `gp-app-playwright`: wrapper for the official-app Playwright flow.
- `gp-app-playwright.mjs`: watches for the app-opened SAML URL and completes it
  in Playwright-controlled Chrome.
- `gp-app-autofill`: wrapper for the AppleScript fallback.
- `gp-app-autofill.mjs`: older Chrome AppleScript autofill automation.
- `.gp.env.example`: config template.
- `.gitignore`: excludes local config, browser profiles, logs, and deps.

## Troubleshooting

`gpauto: command not found`

```bash
source ~/.zshrc
```

Chrome does not open when GlobalProtect Connect is clicked:

- Re-run the GlobalProtect default-browser setting above.
- Quit and reopen GlobalProtect.

1Password CLI says no account is configured:

- Enable desktop app integration in 1Password settings.
- Or sign in manually with `op account add`.

The final `Open GlobalProtect.app?` prompt appears:

- The Playwright profile preconfigures `globalprotectcallback` for the portal
  origin.
- If Chrome still asks once, tick Always allow and click Open. Future runs
  should skip it.
- If your portal host differs, set `GP_APP_CALLBACK_ORIGINS`.

`./gp status` shows a `10.x` utun address but `default route: en0`:

- That utun address is stale or inactive.
- Treat it as connected only when default route or VPN routes point to `utun`.

AppleScript fallback does nothing:

- Run:

```bash
./gp chrome-js enable
```

- Or enable Chrome's macOS menu option:

```text
View > Developer > Allow JavaScript from Apple Events
```
