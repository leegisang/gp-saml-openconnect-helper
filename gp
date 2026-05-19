#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$DIR/.gp.env"
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/gp-openconnect/config.env"
CONFIG_FILE="${GP_CONFIG:-}"

usage() {
  cat <<'USAGE'
Usage:
  gp init [--global]        Create a config file
  gp init --no-sudo-touchid Create a config file without sudo Touch ID setup
  gp setup                  Install/check Homebrew dependencies
  gp doctor                 Check local setup
  gp connect [--fg]         Connect VPN
  gp disconnect             Disconnect VPN
  gp status                 Show VPN status
  gp sudo-touchid           Enable Touch ID for sudo
  gp sudo-nopasswd          Allow openconnect without sudo password

Config lookup:
  GP_CONFIG, then ./.gp.env next to this script, then ~/.config/gp-openconnect/config.env
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
  local override_gp_interface="${GP_INTERFACE:-}"
  local override_gp_authgroup="${GP_AUTHGROUP:-}"
  local override_vpn_user="${VPN_USER:-}"
  local override_gp_mfa_method="${GP_MFA_METHOD:-}"
  local override_gp_ms_stay_signed_in="${GP_MS_STAY_SIGNED_IN:-}"
  local override_gp_split_routes="${GP_SPLIT_ROUTES:-}"

  set -a
  # shellcheck disable=SC1090
  source "$config"
  set +a

  [[ -n "$override_gp_1p_item" ]] && export GP_1P_ITEM="$override_gp_1p_item"
  [[ -n "$override_gp_1p_vault" ]] && export GP_1P_VAULT="$override_gp_1p_vault"
  [[ -n "$override_vpn_host" ]] && export VPN_HOST="$override_vpn_host"
  [[ -n "$override_gp_interface" ]] && export GP_INTERFACE="$override_gp_interface"
  [[ -n "$override_gp_authgroup" ]] && export GP_AUTHGROUP="$override_gp_authgroup"
  [[ -n "$override_vpn_user" ]] && export VPN_USER="$override_vpn_user"
  [[ -n "$override_gp_mfa_method" ]] && export GP_MFA_METHOD="$override_gp_mfa_method"
  [[ -n "$override_gp_ms_stay_signed_in" ]] && export GP_MS_STAY_SIGNED_IN="$override_gp_ms_stay_signed_in"
  [[ -n "$override_gp_split_routes" ]] && export GP_SPLIT_ROUTES="$override_gp_split_routes"

  return 0
}

require_config() {
  local missing=0
  for name in VPN_HOST GP_INTERFACE GP_1P_ITEM; do
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
  local setup_touchid=1

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --global)
        target="$GLOBAL_CONFIG"
        ;;
      --sudo-touchid)
        setup_touchid=1
        ;;
      --no-sudo-touchid)
        setup_touchid=0
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
  local item vault host iface authgroup user mfa_method default_user
  default_user="${VPN_USER:-$(id -un)@example.com}"
  item="$(prompt "1Password item name" "Company VPN")"
  vault="$(prompt "1Password vault name (blank is okay)" "")"
  host="$(prompt "GlobalProtect host" "vpn.example.com")"
  iface="$(prompt "GlobalProtect interface (portal/gateway)" "gateway")"
  authgroup="$(prompt "Gateway/authgroup (blank for direct gateway)" "")"
  user="$(prompt "VPN username fallback" "$default_user")"
  mfa_method="$(prompt "MFA method (verification-code/push)" "verification-code")"

  {
    echo "# gp-openconnect config"
    echo "GP_1P_ITEM=$(quote_env "$item")"
    if [[ -n "$vault" ]]; then
      echo "GP_1P_VAULT=$(quote_env "$vault")"
    else
      echo "# GP_1P_VAULT="
    fi
    echo "VPN_HOST=$(quote_env "$host")"
    echo "GP_INTERFACE=$(quote_env "$iface")"
    echo "GP_AUTHGROUP=$(quote_env "$authgroup")"
    echo "VPN_USER=$(quote_env "$user")"
    echo "GP_MFA_METHOD=$(quote_env "$mfa_method")"
    echo "GP_MS_STAY_SIGNED_IN=yes"
  } >"$target"

  chmod 600 "$target"
  echo "Config created."

  if [[ "$setup_touchid" -eq 1 ]]; then
    echo
    echo "Enabling Touch ID for sudo. This may ask for your Mac password once."
    cmd_sudo_touchid || {
      echo
      echo "Touch ID sudo setup failed. You can retry later with: $0 sudo-touchid"
    }
  fi

  echo
  echo "Done. Next: $0 doctor"
}

cmd_setup() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required: https://brew.sh"
    exit 1
  fi

  brew install openconnect node 1password-cli
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
  check "openconnect" command -v openconnect || failed=1
  check "1Password CLI (op)" command -v op || failed=1
  check "Google Chrome" test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" || failed=1
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
    echo "  interface: ${GP_INTERFACE}"
    echo "  authgroup: ${GP_AUTHGROUP:-<none>}"
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

  echo
  if sudo -n true >/dev/null 2>&1; then
    echo "  ok   sudo currently cached or passwordless"
  else
    echo "  info sudo will ask for password or Touch ID"
  fi

  return "$failed"
}

cmd_connect() {
  local foreground=0
  if [[ "${1:-}" == "--fg" || "${1:-}" == "--foreground" ]]; then
    foreground=1
  elif [[ $# -gt 0 ]]; then
    echo "Unknown connect option: $1"
    exit 1
  fi

  load_config
  require_config

  if [[ "$foreground" -eq 0 ]]; then
    export GP_BACKGROUND=1
  else
    unset GP_BACKGROUND || true
  fi

  if [[ ! -d "$DIR/node_modules/playwright-core" ]]; then
    echo "Missing dependency: playwright-core"
    echo "Run: npm install"
    exit 1
  fi

  exec node "$DIR/gp-saml-playwright.mjs"
}

cmd_disconnect() {
  local pid_file
  pid_file="${GP_PID_FILE:-/tmp/gp-openconnect-$(id -u).pid}"

  if [[ ! -f "$pid_file" ]]; then
    echo "No OpenConnect pid file found: $pid_file"
    exit 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid pid file: $pid_file"
    sudo rm -f "$pid_file"
    exit 1
  fi

  if ! ps -p "$pid" >/dev/null 2>&1; then
    echo "OpenConnect is not running (stale pid $pid)."
    sudo rm -f "$pid_file"
    exit 0
  fi

  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != *openconnect* ]]; then
    echo "Refusing to kill pid $pid because it is not openconnect."
    echo "$command"
    exit 1
  fi

  echo "Stopping OpenConnect pid $pid..."
  sudo kill "$pid"
  sudo rm -f "$pid_file"
  echo "Disconnected."
}

cmd_status() {
  local pid_file
  pid_file="${GP_PID_FILE:-/tmp/gp-openconnect-$(id -u).pid}"

  echo "GlobalProtect/OpenConnect status:"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && ps -p "$pid" >/dev/null 2>&1; then
      local command
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$command" == *openconnect* ]]; then
        echo "  openconnect: running (pid $pid)"
      else
        echo "  pid file exists, but pid $pid is not openconnect"
      fi
    else
      echo "  openconnect: not running (stale pid file: $pid_file)"
    fi
  else
    echo "  openconnect: no pid file ($pid_file)"
  fi

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

cmd_sudo_touchid() {
  if [[ ! -f /etc/pam.d/sudo_local.template ]]; then
    echo "This macOS install does not have /etc/pam.d/sudo_local.template."
    echo "Manual fallback: add this line near the top of /etc/pam.d/sudo:"
    echo "auth       sufficient     pam_tid.so"
    return 1
  fi

  if [[ ! -f /etc/pam.d/sudo_local ]]; then
    sudo cp /etc/pam.d/sudo_local.template /etc/pam.d/sudo_local
  fi

  sudo sed -i.bak -E \
    's/^#(auth[[:space:]]+sufficient[[:space:]]+pam_tid\.so)/\1/' \
    /etc/pam.d/sudo_local

  echo "Touch ID for sudo is enabled."
  echo "Open a new terminal or run: sudo -k && sudo -v"
}

cmd_sudo_nopasswd() {
  local user_name openconnect_path openconnect_realpath sudoers_file tmp_file
  user_name="$(id -un)"
  openconnect_path="$(command -v openconnect)"
  openconnect_realpath="$(realpath "$openconnect_path" 2>/dev/null || echo "$openconnect_path")"
  sudoers_file="/etc/sudoers.d/gp-openconnect-${user_name}"
  tmp_file="$(mktemp)"

  {
    echo "# Allow ${user_name} to run OpenConnect for GlobalProtect without a sudo password."
    echo "# Created by gp."
    if [[ "$openconnect_path" == "$openconnect_realpath" ]]; then
      echo "${user_name} ALL=(root) NOPASSWD: ${openconnect_path} *"
    else
      echo "${user_name} ALL=(root) NOPASSWD: ${openconnect_path} *, ${openconnect_realpath} *"
    fi
  } >"$tmp_file"

  sudo visudo -cf "$tmp_file" >/dev/null
  sudo install -m 0440 "$tmp_file" "$sudoers_file"
  rm -f "$tmp_file"

  echo "Installed sudoers rule:"
  sudo cat "$sudoers_file"
  echo
  echo "Test with:"
  echo "  sudo -k"
  echo "  sudo -n ${openconnect_path} --version"
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
  connect)
    shift
    cmd_connect "$@"
    ;;
  disconnect|stop)
    shift
    cmd_disconnect "$@"
    ;;
  status)
    shift
    cmd_status "$@"
    ;;
  sudo-touchid)
    shift
    cmd_sudo_touchid "$@"
    ;;
  sudo-nopasswd)
    shift
    cmd_sudo_nopasswd "$@"
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
