# GlobalProtect CLI Helper

This wraps `openconnect` + Microsoft SAML login + 1Password CLI autofill.

It does not bypass MFA. If your organization uses Microsoft Authenticator
number matching, you still approve that step on your phone.

## Setup

```bash
brew install openconnect node 1password-cli
npm install
```

Enable 1Password app integration:

```text
1Password > Settings > Developer > Integrate with 1Password CLI
```

Create a config:

```bash
./gp init
./gp doctor
```

The config is written to `.gp.env` by default and is intentionally ignored by
git. It contains your VPN host, username, and 1Password item name, but not your
password.

`./gp init` also enables Touch ID for sudo by default, because OpenConnect needs
administrator privileges to create the tunnel interface and update routes/DNS.
Skip that step with:

```bash
./gp init --no-sudo-touchid
```

## Use

```bash
./gp connect
./gp status
./gp disconnect
```

Foreground/debug mode:

```bash
./gp connect --fg
```

Reduce sudo friction:

```bash
./gp sudo-touchid
```

More convenient but more sensitive:

```bash
./gp sudo-nopasswd
```

## Files

Runtime code is intentionally small:

- `gp`: main CLI for setup, connect, status, disconnect, and sudo helpers.
- `gp-saml-playwright.mjs`: browser/SAML automation and OpenConnect launcher.
- `package.json` / `package-lock.json`: Node dependency metadata.
- `.gp.env.example`: config template. Your real `.gp.env` stays local.

## Notes

- The phone Microsoft Authenticator number-matching step is still manual.
- Keep the official GlobalProtect app disconnected while using this.
- `.gp.env` is local-only and should not be committed.
- `.gp-saml-browser-profile/` stores the helper browser profile and should not
  be committed.
- Confirm your organization allows OpenConnect/non-official VPN clients before
  using this broadly.

## Example Config

```bash
GP_1P_ITEM="Company VPN"
# GP_1P_VAULT="Private"

VPN_HOST="vpn.example.com"
GP_INTERFACE="gateway"
GP_AUTHGROUP=""

VPN_USER="your.name@example.com"
GP_MS_STAY_SIGNED_IN=yes
```
