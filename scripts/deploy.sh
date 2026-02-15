#!/bin/bash
# Deploy script for TSLA Neutral Bot on spirit-worker VM
# Ensures build succeeds before restarting PM2
#
# Usage: ./scripts/deploy.sh [commit-message]
# Or from VM: ./scripts/deploy-vm.sh

set -euo pipefail

REMOTE="spirit-worker"
ZONE="us-central1-a"
REMOTE_DIR="/home/cmadaan/tsla-hedge"

echo "═══════════════════════════════════════════════"
echo "TSLA Neutral Bot — Deploy to $REMOTE"
echo "═══════════════════════════════════════════════"

# Step 1: Local typecheck
echo ""
echo "[1/5] Local typecheck..."
npx tsc --noEmit
echo "  ✓ TypeScript compiles cleanly"

# Step 2: Push to remote
echo ""
echo "[2/5] Pushing to origin..."
git push origin main
echo "  ✓ Pushed"

# Step 3: Pull + build on VM
echo ""
echo "[3/5] Building on VM..."
BUILD_OUTPUT=$(gcloud compute ssh "$REMOTE" --zone="$ZONE" -- "cd $REMOTE_DIR && git pull origin main && npx tsc 2>&1; echo EXIT_CODE=\$?" 2>&1)

if ! echo "$BUILD_OUTPUT" | grep -q "EXIT_CODE=0"; then
    echo "  ✗ BUILD FAILED on VM!"
    echo ""
    echo "$BUILD_OUTPUT"
    echo ""
    echo "Aborting deploy. PM2 still running old code."
    exit 1
fi
echo "  ✓ Built successfully on VM"

# Step 4: Verify key functions exist in compiled output
echo ""
echo "[4/5] Verifying Phase 1-3 code in dist/..."
VERIFY=$(gcloud compute ssh "$REMOTE" --zone="$ZONE" -- "cd $REMOTE_DIR && grep -c 'repositionLP\|isPriceStable\|outOfRangeSince\|MIN_REBALANCE_INTERVAL' dist/bots/tsla_neutral/strategy/orchestrator.js 2>/dev/null || echo 0" 2>&1 | tail -1)

if [ "$VERIFY" -lt 5 ] 2>/dev/null; then
    echo "  ✗ Compiled code missing expected functions (found $VERIFY references)"
    echo "Aborting deploy."
    exit 1
fi
echo "  ✓ Found $VERIFY references to Phase 1-3 code"

# Step 5: Restart PM2
echo ""
echo "[5/5] Restarting PM2..."
RESTART_OUTPUT=$(gcloud compute ssh "$REMOTE" --zone="$ZONE" -- "cd $REMOTE_DIR && pm2 restart tsla-neutral && sleep 5 && pm2 status" 2>&1)
echo "$RESTART_OUTPUT" | grep "tsla-neutral"

# Log the commit hash for traceability
COMMIT=$(gcloud compute ssh "$REMOTE" --zone="$ZONE" -- "cd $REMOTE_DIR && git rev-parse --short HEAD" 2>&1 | tail -1)
echo ""
echo "═══════════════════════════════════════════════"
echo "✓ Deploy complete — commit $COMMIT running on $REMOTE"
echo "═══════════════════════════════════════════════"
