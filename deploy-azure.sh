#!/usr/bin/env bash
set -euo pipefail

SUBSCRIPTION_ID="0306cb34-f0d6-40b9-b4e3-0cc6c24dd240"
RG="rg-dlokey"
LOCATION="southcentralus"
PLAN="asp-crossfire-dll-2026"
APP="crossfire-dll-2026"
SKU="B1"
RUNTIME="NODE|24-lts"

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

if ! az group show -n "$RG" >/dev/null 2>&1; then
  echo "Resource group '$RG' not found. Creating in $LOCATION..."
  az group create -n "$RG" -l "$LOCATION" >/dev/null
fi

if ! az appservice plan show -g "$RG" -n "$PLAN" >/dev/null 2>&1; then
  echo "App Service plan '$PLAN' not found. Creating Linux plan ($SKU) in $LOCATION..."
  az appservice plan create -g "$RG" -n "$PLAN" --is-linux --sku "$SKU" -l "$LOCATION" >/dev/null
else
  echo "Found existing App Service plan '$PLAN'."
fi

if ! az webapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  echo "Creating web app '$APP'..."
  az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "$RUNTIME" >/dev/null
else
  echo "Web app '$APP' already exists."
fi

echo "Applying app settings..."
az webapp config appsettings set -g "$RG" -n "$APP" --settings \
  HOST=0.0.0.0 \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  WEBSITES_PORT=3000 \
  NODE_ENV=production >/dev/null

echo "Setting startup command..."
az webapp config set -g "$RG" -n "$APP" --startup-file "npm start" >/dev/null

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

URL="https://$APP.azurewebsites.net"
echo "Deployment complete."
echo "URL: $URL"
