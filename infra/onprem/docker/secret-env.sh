#!/bin/sh
# Entrypoint wrapper: turns every NAME_FILE=<path> variable into NAME=<content of the file>, then runs the command.
# Secrets are mounted as files (compose secrets, Kubernetes secrets, a secret manager agent); they never sit in the
# image, the compose file or the environment of the compose project. Values are never printed.
set -eu

for entry in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)_FILE=.*/\1/p'); do
  eval "path=\${${entry}_FILE}"
  if [ ! -r "$path" ]; then
    echo "secret-env: ${entry}_FILE names a file that cannot be read" >&2
    exit 78
  fi
  value=$(cat "$path")
  export "${entry}=${value}"
  unset "${entry}_FILE"
done

exec "$@"
