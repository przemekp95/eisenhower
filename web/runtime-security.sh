#!/bin/sh

valid_csp_host() (
  host="$1"
  if [ -z "$host" ] || [ "${#host}" -gt 253 ]; then
    return 1
  fi
  case "$host" in
    .*|*.|*..*) return 1 ;;
  esac

  if printf '%s' "$host" | grep -Eq '^[0-9.]+$'; then
    previous_ifs="$IFS"
    IFS=.
    set -- $host
    IFS="$previous_ifs"
    [ "$#" -eq 4 ] || return 1
    for octet in "$@"; do
      case "$octet" in
        ''|*[!0-9]*) return 1 ;;
      esac
      [ "$octet" -le 255 ] || return 1
    done
    return 0
  fi

  previous_ifs="$IFS"
  IFS=.
  set -- $host
  IFS="$previous_ifs"
  for label in "$@"; do
    if [ -z "$label" ] || [ "${#label}" -gt 63 ]; then
      return 1
    fi
    case "$label" in
      -*|*-) return 1 ;;
    esac
    printf '%s' "$label" | grep -Eq '^[A-Za-z0-9-]+$' || return 1
  done
)

csp_origin() {
  endpoint="$1"

  printable="$(printf '%s' "$endpoint" | LC_ALL=C tr -cd '\040-\176')"
  if [ "$endpoint" != "$printable" ]; then
    printf 'invalid runtime endpoint for CSP: contains non-printable characters\n' >&2
    return 1
  fi

  case "$endpoint" in
    '')
      return 0
      ;;
    //*)
      printf 'invalid runtime endpoint for CSP: protocol-relative URL\n' >&2
      return 1
      ;;
    /*)
      return 0
      ;;
  esac

  origin="$(printf '%s' "$endpoint" | sed -E 's#^(https?://[^/]+).*$#\1#')"
  if ! printf '%s' "$origin" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'; then
    printf 'invalid runtime endpoint for CSP: %s\n' "$endpoint" >&2
    return 1
  fi

  authority="${origin#*://}"
  host="${authority%%:*}"
  if ! valid_csp_host "$host"; then
    printf 'invalid runtime endpoint for CSP: invalid host\n' >&2
    return 1
  fi
  case "$authority" in
    *:*)
      port="${authority##*:}"
      if [ "${#port}" -gt 5 ] || [ "$port" -gt 65535 ]; then
        printf 'invalid runtime endpoint for CSP: invalid port\n' >&2
        return 1
      fi
      ;;
  esac
  printf '%s' "$origin"
}

build_csp_connect_src() {
  sources="'self'"
  for endpoint in "$@"; do
    origin="$(csp_origin "$endpoint")" || return 1
    [ -n "$origin" ] || continue
    case " $sources " in
      *" $origin "*) ;;
      *) sources="$sources $origin" ;;
    esac
  done
  printf '%s' "$sources"
}
