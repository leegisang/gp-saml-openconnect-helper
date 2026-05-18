# GlobalProtect CLI Helper

This wraps `openconnect` + Microsoft SAML login + 1Password CLI autofill.

The default flow uses a 1Password one-time password field to choose
`Use a verification code` during Microsoft MFA and submit the current code.
It does not bypass MFA; it automates the verification-code method you already
registered.

## Setup

```bash
brew install openconnect node 1password-cli
npm install
```

Enable 1Password app integration:

```text
1Password > Settings > Developer > Integrate with 1Password CLI
```

Create or update your 1Password login item so it contains:

- username
- password
- one-time password

For Microsoft work/school accounts, add the one-time password from
`mysignins.microsoft.com/security-info` by choosing Microsoft Authenticator and
manual code entry. Paste the secret into the 1Password item's one-time password
field.

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
- If you cannot register a one-time password in 1Password, set
  `GP_MFA_METHOD="push"` and approve the number-matching prompt manually.

## Example Config

```bash
GP_1P_ITEM="Company VPN"
# GP_1P_VAULT="Private"

VPN_HOST="vpn.example.com"
GP_INTERFACE="gateway"
GP_AUTHGROUP=""

VPN_USER="your.name@example.com"
GP_MFA_METHOD="verification-code"
GP_MS_STAY_SIGNED_IN=yes
```

Set `GP_MFA_METHOD="push"` if your organization only allows Microsoft
Authenticator push/number matching. In that mode, the phone approval step remains
manual.
