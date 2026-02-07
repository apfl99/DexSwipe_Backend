#!/usr/bin/env bash
# Minimal dotenv loader without eval.
# - Prevents shell expansion issues when values include $, !, etc.
# - Supports KEY=value, KEY="value", KEY='value'
set -euo pipefail

dotenv_load() {
  local file="${1:-.env}"
  [[ -f "${file}" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # Trim leading spaces
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "${line}" ]] && continue
    [[ "${line:0:1}" == "#" ]] && continue

    # Allow optional "export "
    if [[ "${line}" == export\ * ]]; then
      line="${line#export }"
    fi

    # Must contain '='
    [[ "${line}" == *"="* ]] || continue

    key="${line%%=*}"
    value="${line#*=}"

    # Trim trailing spaces in key
    key="${key%"${key##*[![:space:]]}"}"

    # Strip surrounding quotes (single/double)
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:-1}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:-1}"
    fi

    export "${key}=${value}"
  done < "${file}"
}

