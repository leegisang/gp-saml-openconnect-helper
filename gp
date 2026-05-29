#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$DIR/.gp.env"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gp-app-login/config.env"
CONFIG_FILE="${GP_CONFIG:-}"

usage() {
  cat <<'USAGE'
Usage:
  gp init [--global]        Create a config file
  gp setup                  Install Homebrew/npm dependencies
  gp doctor                 Check local setup
  gp status                 Show VPN status
  gp app-playwright run     Complete GP app browser login in Playwright Chrome
  gp app-playwright install Install background Playwright agent and gpauto alias
  gp app-playwright start   Start background Playwright agent
  gp app-playwright stop    Stop background Playwright agent
  gp app-playwright status  Show background Playwright agent status
  gp app-playwright uninstall
                             Remove background agent and gpauto alias
  gp app-autofill run       Fallback: AppleScript Chrome autofill watcher
  gp chrome-js status       Optional: check Chrome Apple Events JS setting
  gp chrome-js enable       Optional: enable Chrome Apple Events JS fallback

Config lookup:
  GP_CONFIG, then ./.gp.env next to this script, then ~/.config/gp-app-login/config.env
USAGE
}

find_config() {
  if [[ -n "$CONFIG_FILE" ]]; then
    echo "$CONFIG_FILE"
  elif [[ -f "$LOCAL_CONFIG" ]]; then
    echo "$LOCAL_CONFIG"
  else
    echo "$GLOBAL_CONFIG"
  fi
}

quote_env() {
  printf "%q" "$1"
}

prompt() {
  local label="$1"
  local default_value="$2"
  local value
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    echo "${value:-$default_value}"
  else
    read -r -p "$label: " value
    echo "$value"
  fi
}

load_config() {
  local config
  config="$(find_config)"
  if [[ ! -f "$config" ]]; then
    echo "Missing config: $config"
    echo "Run: $0 init"
    exit 1
  fi

  local override_gp_1p_item="${GP_1P_ITEM:-}"
  local override_gp_1p_vault="${GP_1P_VAULT:-}"
  local override_vpn_host="${VPN_HOST:-}"
  local override_gp_mfa_method="${GP_MFA_METHOD:-}"
  local override_gp_ms_stay_signed_in="${GP_MS_STAY_SIGNED_IN:-}"

  set -a
  # shellcheck disable=SC1090
  source "$config"
  set +a

  [[ -n "$override_gp_1p_item" ]] && export GP_1P_ITEM="$override_gp_1p_item"
  [[ -n "$override_gp_1p_vault" ]] && export GP_1P_VAULT="$override_gp_1p_vault"
  [[ -n "$override_vpn_host" ]] && export VPN_HOST="$override_vpn_host"
  [[ -n "$override_gp_mfa_method" ]] && export GP_MFA_METHOD="$override_gp_mfa_method"
  [[ -n "$override_gp_ms_stay_signed_in" ]] && export GP_MS_STAY_SIGNED_IN="$override_gp_ms_stay_signed_in"

  return 0
}

require_config() {
  local missing=0
  for name in VPN_HOST GP_1P_ITEM; do
    if [[ -z "${!name:-}" ]]; then
      echo "Missing config value: $name"
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    echo "Run: $0 init"
    exit 1
  fi
}

cmd_init() {
  local target="$LOCAL_CONFIG"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --global)
        target="$GLOBAL_CONFIG"
        ;;
      *)
        echo "Unknown init option: $1"
        exit 1
        ;;
    esac
    shift
  done

  mkdir -p "$(dirname "$target")"

  echo "Creating config: $target"
  local item vault host mfa_method
  item="$(prompt "1Password item name" "Company VPN")"
  vault="$(prompt "1Password vault name (blank is okay)" "")"
  host="$(prompt "GlobalProtect portal host" "vpn.example.com")"
  mfa_method="$(prompt "MFA method (verification-code/push)" "verification-code")"

  {
    echo "# GlobalProtect helper config"
    echo "GP_1P_ITEM=$(quote_env "$item")"
    if [[ -n "$vault" ]]; then
      echo "GP_1P_VAULT=$(quote_env "$vault")"
    else
      echo "# GP_1P_VAULT="
    fi
    echo "GP_MFA_METHOD=$(quote_env "$mfa_method")"
    echo "GP_MS_STAY_SIGNED_IN=yes"
    echo "VPN_HOST=$(quote_env "$host")"
    echo "# GP_APP_CALLBACK_PROTOCOL=globalprotectcallback"
    echo "# GP_APP_CALLBACK_ORIGINS="
  } >"$target"

  chmod 600 "$target"
  echo "Config created."

  echo
  echo "Done. Next:"
  echo "  $0 doctor"
  echo "  $0 app-playwright install"
}

cmd_setup() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required: https://brew.sh"
    exit 1
  fi

  brew install node 1password-cli
  (cd "$DIR" && npm install)
}

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf "  ok   %s\n" "$label"
  else
    printf "  fail %s\n" "$label"
    return 1
  fi
}

cmd_doctor() {
  local failed=0
  echo "Checking dependencies:"
  check "brew" command -v brew || failed=1
  check "node" command -v node || failed=1
  check "npm" command -v npm || failed=1
  check "1Password CLI (op)" command -v op || failed=1
  check "Google Chrome" test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" || failed=1
  check "GlobalProtect app" test -d "/Applications/GlobalProtect.app" || failed=1
  check "npm dependencies" test -d "$DIR/node_modules/playwright-core" || failed=1

  local config
  config="$(find_config)"
  echo
  echo "Config: $config"
  if [[ -f "$config" ]]; then
    load_config
    require_config
    echo "  ok   config loaded"
    echo "  host: ${VPN_HOST}"
    echo "  MFA method: ${GP_MFA_METHOD:-verification-code}"
    echo "  1Password item: ${GP_1P_ITEM}"
    local op_args=("item" "get" "$GP_1P_ITEM")
    if [[ -n "${GP_1P_VAULT:-}" ]]; then
      op_args+=("--vault" "$GP_1P_VAULT")
    fi
    if op "${op_args[@]}" >/dev/null 2>&1; then
      echo "  ok   1Password item readable"
    else
      echo "  fail 1Password item is not readable"
      failed=1
    fi
  else
    echo "  fail config missing"
    echo "  run: $0 init"
    failed=1
  fi

  return "$failed"
}

cmd_status() {
  echo "GlobalProtect status:"

  local gp_app gp_service gp_ui gp_daemon
  if pgrep -f "/Applications/GlobalProtect.app/Contents/MacOS/GlobalProtect" >/dev/null 2>&1; then
    gp_app="running"
  else
    gp_app="not running"
  fi
  if pgrep -f "/Applications/GlobalProtect.app/Contents/Resources/PanGPS" >/dev/null 2>&1; then
    gp_service="running"
  else
    gp_service="not running"
  fi
  launchctl print "gui/$(id -u)/com.paloaltonetworks.gp.pangpa" >/dev/null 2>&1 && gp_ui="loaded" || gp_ui="missing"
  launchctl print "gui/$(id -u)/com.paloaltonetworks.gp.pangps" >/dev/null 2>&1 && gp_daemon="loaded" || gp_daemon="missing"

  echo "  official app: $gp_app"
  echo "  official service: $gp_service"
  echo "  launch agents: pangpa=$gp_ui pangps=$gp_daemon"

  local default_route
  default_route="$(
    route -n get default 2>/dev/null | awk '
      $1 == "gateway:" { gateway=$2 }
      $1 == "interface:" { iface=$2 }
      END {
        if (iface) {
          if (gateway) print iface " via " gateway
          else print iface
        }
      }
    '
  )"
  if [[ -n "$default_route" ]]; then
    echo "  default route: $default_route"
  else
    echo "  default route: unknown"
  fi

  local vpn_routes
  vpn_routes="$(
    netstat -rn -f inet 2>/dev/null | awk '
      $NF ~ /^utun[0-9]+$/ &&
      $1 != "127" &&
      $1 !~ /^224\./ &&
      $1 !~ /^255\./ {
        count[$NF]++
      }
      END {
        for (iface in count) print iface " " count[iface]
      }
    '
  )"
  if [[ -n "$vpn_routes" ]]; then
    while read -r iface count; do
      echo "  vpn routes: $count route(s) via $iface"
    done <<<"$vpn_routes"
  else
    echo "  vpn routes: none"
  fi

  local vpn_ips
  vpn_ips="$(
    ifconfig 2>/dev/null | awk '
      /^utun[0-9]+:/ {
        iface=$1
        sub(":", "", iface)
      }
      iface && $1 == "inet" && $2 ~ /^10\./ {
        print iface " " $2
      }
    '
  )"

  if [[ -n "$vpn_ips" ]]; then
    local iface ip
    while read -r iface ip; do
      if netstat -rn -f inet 2>/dev/null | awk -v iface="$iface" '
        $NF == iface && $1 != "127" && $1 !~ /^224\./ && $1 !~ /^255\./ {
          found=1
        }
        END { exit found ? 0 : 1 }
      '; then
        echo "  utun address: $ip on $iface (active route)"
      else
        echo "  utun address: $ip on $iface (stale/no route)"
      fi
    done <<<"$vpn_ips"
  else
    echo "  utun address: none"
  fi
}

app_autofill_label() {
  echo "com.gpapp.login.playwright"
}

app_autofill_plist() {
  echo "$HOME/Library/LaunchAgents/$(app_autofill_label).plist"
}

app_support_dir() {
  echo "$HOME/Library/Application Support/gp-app-login-helper"
}

app_runtime_dir() {
  echo "$(app_support_dir)/runtime"
}

app_runtime_config() {
  echo "$(app_support_dir)/config.env"
}

app_runtime_profile() {
  echo "$(app_support_dir)/playwright-profile"
}

app_runtime_program() {
  echo "$(app_runtime_dir)/gp-app-playwright"
}

reset_app_playwright_logs() {
  mkdir -p "$HOME/Library/Logs"
  : >"$HOME/Library/Logs/gp-app-playwright.out.log"
  : >"$HOME/Library/Logs/gp-app-playwright.err.log"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf "%s" "$value"
}

install_app_playwright_runtime() {
  local support runtime config runtime_config
  support="$(app_support_dir)"
  runtime="$(app_runtime_dir)"
  config="$(find_config)"
  runtime_config="$(app_runtime_config)"

  if [[ ! -f "$config" ]]; then
    echo "Missing config: $config"
    echo "Run: $0 init"
    exit 1
  fi

  if [[ ! -x "$DIR/gp-app-playwright" || ! -f "$DIR/gp-app-playwright.mjs" ]]; then
    echo "Missing gp-app-playwright files in $DIR"
    exit 1
  fi

  if [[ ! -d "$DIR/node_modules/playwright-core" ]]; then
    echo "Missing dependency: playwright-core"
    echo "Run: npm install"
    exit 1
  fi

  mkdir -p "$runtime" "$(app_runtime_profile)"
  install -m 0600 "$config" "$runtime_config"
  install -m 0755 "$DIR/gp-app-playwright" "$runtime/gp-app-playwright"
  install -m 0644 "$DIR/gp-app-playwright.mjs" "$runtime/gp-app-playwright.mjs"
  install -m 0644 "$DIR/package.json" "$runtime/package.json"
  [[ -f "$DIR/package-lock.json" ]] && install -m 0644 "$DIR/package-lock.json" "$runtime/package-lock.json"

  rm -rf "$runtime/node_modules"
  ditto "$DIR/node_modules" "$runtime/node_modules"

  chmod 700 "$support" "$runtime" "$(app_runtime_profile)" 2>/dev/null || true
  xattr -dr com.apple.quarantine "$support" 2>/dev/null || true
}

write_app_autofill_plist() {
  local plist config label program out_log err_log profile path_value
  plist="$(app_autofill_plist)"
  config="$(app_runtime_config)"
  label="$(app_autofill_label)"
  program="$(xml_escape "$(app_runtime_program)")"
  config="$(xml_escape "$config")"
  profile="$(xml_escape "$(app_runtime_profile)")"
  out_log="$(xml_escape "$HOME/Library/Logs/gp-app-playwright.out.log")"
  err_log="$(xml_escape "$HOME/Library/Logs/gp-app-playwright.err.log")"
  path_value="$(xml_escape "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"
  mkdir -p "$(dirname "$plist")" "$HOME/Library/Logs"

  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
    <string>--daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_value</string>
    <key>GP_CONFIG</key>
    <string>$config</string>
    <key>GP_APP_PLAYWRIGHT_PROFILE</key>
    <string>$profile</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$out_log</string>
  <key>StandardErrorPath</key>
  <string>$err_log</string>
</dict>
</plist>
PLIST
}

install_gpauto_alias() {
  local zshrc tmp_file
  zshrc="$HOME/.zshrc"
  tmp_file="$(mktemp)"
  touch "$zshrc"

  awk '
    $0 == "# >>> gp-app-login-helper >>>" { skip=1; next }
    $0 == "# <<< gp-app-login-helper <<<" { skip=0; next }
    skip != 1 { print }
  ' "$zshrc" >"$tmp_file"

  {
    cat "$tmp_file"
    echo
    echo "# >>> gp-app-login-helper >>>"
    printf "alias gpauto=%q\n" "cd $DIR && ./gp app-playwright run --debug"
    printf "alias gpautopw=%q\n" "cd $DIR && ./gp app-playwright run --debug"
    printf "alias gpautofill=%q\n" "cd $DIR && ./gp app-autofill run --debug --daemon"
    echo "# <<< gp-app-login-helper <<<"
  } >"$zshrc"
  rm -f "$tmp_file"
}

remove_gpauto_alias() {
  local zshrc tmp_file
  zshrc="$HOME/.zshrc"
  [[ -f "$zshrc" ]] || return 0
  tmp_file="$(mktemp)"
  awk '
    $0 == "# >>> gp-app-login-helper >>>" { skip=1; next }
    $0 == "# <<< gp-app-login-helper <<<" { skip=0; next }
    skip != 1 { print }
  ' "$zshrc" >"$tmp_file"
  cat "$tmp_file" >"$zshrc"
  rm -f "$tmp_file"
}

cmd_app_autofill_run() {
  export GP_CONFIG
  GP_CONFIG="$(find_config)"
  exec "$DIR/gp-app-autofill" "$@"
}

cmd_app_autofill_install() {
  cmd_app_autofill_stop >/dev/null 2>&1 || true
  install_app_playwright_runtime
  write_app_autofill_plist
  install_gpauto_alias

  echo "Installed LaunchAgent:"
  echo "  $(app_autofill_plist)"
  echo "Installed runtime:"
  echo "  $(app_runtime_dir)"
  echo "Installed zsh alias:"
  echo "  gpauto      -> Playwright flow"
  echo "  gpautopw    -> Playwright flow"
  echo "  gpautofill  -> AppleScript fallback"
  echo
  echo "Start now:"
  echo "  $0 app-playwright start"
  echo
  echo "Reload shell for alias:"
  echo "  source ~/.zshrc"
}

cmd_app_autofill_start() {
  local plist label uid
  plist="$(app_autofill_plist)"
  label="$(app_autofill_label)"
  uid="$(id -u)"
  install_app_playwright_runtime
  write_app_autofill_plist
  reset_app_playwright_logs

  launchctl bootout "gui/$uid" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$uid/$label"
  echo "Started $label."
}

cmd_app_autofill_stop() {
  local plist label uid
  plist="$(app_autofill_plist)"
  label="$(app_autofill_label)"
  uid="$(id -u)"

  launchctl bootout "gui/$uid" "$plist" 2>/dev/null || launchctl kill TERM "gui/$uid/$label" 2>/dev/null || true
  echo "Stopped $label."
}

cmd_app_autofill_status() {
  local label uid
  label="$(app_autofill_label)"
  uid="$(id -u)"

  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    echo "LaunchAgent: loaded ($label)"
  else
    echo "LaunchAgent: not loaded ($label)"
  fi

  if pgrep -af "gp-app-(autofill|playwright)" >/dev/null 2>&1; then
    echo "Process:"
    pgrep -af "gp-app-(autofill|playwright)" | sed 's/^/  /'
  else
    echo "Process: not running"
  fi

  echo "Plist: $(app_autofill_plist)"
  echo "Runtime: $(app_runtime_dir)"
  echo "Runtime config: $(app_runtime_config)"
  echo "Logs:"
  echo "  $HOME/Library/Logs/gp-app-playwright.out.log"
  echo "  $HOME/Library/Logs/gp-app-playwright.err.log"
}

cmd_app_autofill_uninstall() {
  cmd_app_autofill_stop >/dev/null
  rm -f "$(app_autofill_plist)"
  rm -rf "$(app_support_dir)"
  remove_gpauto_alias
  echo "Uninstalled app login LaunchAgent, runtime, and gpauto aliases."
}

cmd_app_autofill() {
  local subcommand="${1:-run}"
  shift || true
  case "$subcommand" in
    run)
      cmd_app_autofill_run "$@"
      ;;
    install)
      cmd_app_autofill_install "$@"
      ;;
    start)
      cmd_app_autofill_start "$@"
      ;;
    stop)
      cmd_app_autofill_stop "$@"
      ;;
    status)
      cmd_app_autofill_status "$@"
      ;;
    uninstall)
      cmd_app_autofill_uninstall "$@"
      ;;
    *)
      echo "Unknown app-autofill command: $subcommand"
      echo "Usage: $0 app-autofill {run|install|start|stop|status|uninstall}"
      exit 1
      ;;
  esac
}

cmd_app_playwright_run() {
  export GP_CONFIG
  GP_CONFIG="$(find_config)"
  exec "$DIR/gp-app-playwright" "$@"
}

cmd_app_playwright() {
  local subcommand="${1:-run}"
  shift || true
  case "$subcommand" in
    run)
      cmd_app_playwright_run "$@"
      ;;
    install)
      cmd_app_autofill_install "$@"
      ;;
    start)
      cmd_app_autofill_start "$@"
      ;;
    stop)
      cmd_app_autofill_stop "$@"
      ;;
    status)
      cmd_app_autofill_status "$@"
      ;;
    uninstall)
      cmd_app_autofill_uninstall "$@"
      ;;
    *)
      echo "Unknown app-playwright command: $subcommand"
      echo "Usage: $0 app-playwright {run|install|start|stop|status|uninstall}"
      exit 1
      ;;
  esac
}

cmd_chrome_js() {
  local subcommand="${1:-status}"
  case "$subcommand" in
    status|enable|disable|on|off)
      ;;
    *)
      echo "Usage: $0 chrome-js {status|enable|disable}"
      exit 1
      ;;
  esac

  case "$subcommand" in
    on)
      subcommand="enable"
      ;;
    off)
      subcommand="disable"
      ;;
  esac

  node - "$subcommand" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const action = process.argv[2];
const chromeRoot = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
const localStatePath = path.join(chromeRoot, "Local State");
const profiles = new Set(["Default"]);

if (fs.existsSync(localStatePath)) {
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    for (const name of Object.keys(localState.profile?.info_cache || {})) profiles.add(name);
  } catch {
    // Ignore malformed Chrome state and fall back to Default.
  }
}

let found = 0;
for (const profile of [...profiles].sort()) {
  const preferencesPath = path.join(chromeRoot, profile, "Preferences");
  if (!fs.existsSync(preferencesPath)) continue;
  found += 1;

  const preferences = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
  preferences.account_values ||= {};
  preferences.account_values.browser ||= {};

  if (action === "enable" || action === "disable") {
    preferences.account_values.browser.allow_javascript_apple_events = action === "enable";
    fs.writeFileSync(preferencesPath, JSON.stringify(preferences, null, 2));
  }

  const enabled = preferences.account_values.browser.allow_javascript_apple_events === true;
  console.log(`${profile}: ${enabled ? "enabled" : "disabled"}`);
}

if (found === 0) {
  console.error(`Chrome profile preferences not found under: ${chromeRoot}`);
  process.exit(1);
}

if (action === "enable" || action === "disable") {
  console.log("Restart Chrome if the menu state does not update immediately.");
}
NODE
}

case "${1:-}" in
  init)
    shift
    cmd_init "$@"
    ;;
  setup)
    shift
    cmd_setup "$@"
    ;;
  doctor)
    shift
    cmd_doctor "$@"
    ;;
  status)
    shift
    cmd_status "$@"
    ;;
  app-autofill)
    shift
    cmd_app_autofill "$@"
    ;;
  app-playwright)
    shift
    cmd_app_playwright "$@"
    ;;
  chrome-js)
    shift
    cmd_chrome_js "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
