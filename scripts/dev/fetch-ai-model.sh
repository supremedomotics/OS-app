#!/usr/bin/env bash
# Fetch a small on-box instruct model (GGUF) for the Supreme AI assistant and print
# the path to export as SUPREME_AI_MODEL_PATH. Weights are never committed to the
# repo; the appliance (or CI in a network that can reach the model host) downloads
# them here.
#
#   bash scripts/dev/fetch-ai-model.sh
#   export SUPREME_AI_MODEL_PATH="$(pwd)/services/ai-py/models/<file>.gguf"
#
# Default: Qwen2.5-0.5B-Instruct (Q4_K_M, ~400 MB) from Hugging Face. Override the
# URL for an air-gapped mirror. NOTE: in restricted networks Hugging Face may be
# blocked; point MODEL_URL at an allowlisted mirror in that case.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODEL_URL="${MODEL_URL:-https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf}"
DEST_DIR="services/ai-py/models"
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/$(basename "$MODEL_URL")"

if [ -f "$DEST" ]; then
  echo "Model already present: $DEST"
else
  echo "Downloading $MODEL_URL …"
  curl -fSL -o "$DEST" "$MODEL_URL"
fi
echo "SUPREME_AI_MODEL_PATH=$(pwd)/$DEST"
