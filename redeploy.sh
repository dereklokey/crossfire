#!/usr/bin/env bash
set -euo pipefail

SUBSCRIPTION_ID="0306cb34-f0d6-40b9-b4e3-0cc6c24dd240"
RG="rg-dlokey"
APP="crossfire-dll-2026"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP_PATH="$ROOT_DIR/deploy.zip"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

require_cmd az
require_cmd zip

echo "Using subscription: $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

echo "Building deploy zip..."
rm -f "$ZIP_PATH"
(
  cd "$ROOT_DIR"
  zip -r "$ZIP_PATH" . \
    -x "node_modules/*" \
       ".git/*" \
       "deploy.zip" \
       "*.DS_Store" >/dev/null
)

echo "Deploying to Azure Web App..."
az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP_PATH" --type zip >/dev/null

echo "Redeploy complete."
echo "URL: https://$APP.azurewebsites.net"
