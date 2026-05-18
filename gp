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

  set -a
  # shellcheck disable=SC1090
  source "$config"
  set +a
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
  local item vault host iface authgroup user default_user
  default_user="${VPN_USER:-$(id -un)@example.com}"
  item="$(prompt "1Password item name" "Company VPN")"
  vault="$(prompt "1Password vault name (blank is okay)" "")"
  host="$(prompt "GlobalProtect host" "vpn.example.com")"
  iface="$(prompt "GlobalProtect interface (portal/gateway)" "gateway")"
  authgroup="$(prompt "Gateway/authgroup (blank for direct gateway)" "")"
  user="$(prompt "VPN username fallback" "$default_user")"

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
    echo "GP_MS_STAY_SIGNED_IN=yes"
  } >"$target"

  chmod 600 "$target"
  echo "Config created."

  if [[ "$setup_touchid" -eq 1 ]]; then
    echo
    echo "Enabling Touch ID for sudo. This may ask for your Mac password once."
    "$DIR/setup-sudo-touchid" || {
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

  exec "$DIR/gp-connect"
}

cmd_disconnect() {
  exec "$DIR/gp-disconnect"
}

cmd_status() {
  exec "$DIR/gp-status"
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
    exec "$DIR/setup-sudo-touchid"
    ;;
  sudo-nopasswd)
    shift
    exec "$DIR/setup-sudo-openconnect-nopasswd"
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
