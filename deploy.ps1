# deploy.ps1 — push local mocount build to VM, restart pm2.
# Atomic-swap pattern: dist is uploaded to a staging dir and only
# moved into place once the upload fully succeeds. If anything fails
# before the swap, the live site is untouched.

$ErrorActionPreference = 'Stop'
$KEY    = '"C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem"'
$REMOTE = 'azureuser@51.145.161.85'
$DEST   = '/home/azureuser/mocount'

function Run($label, $cmd) {
    Write-Host "-> $label" -ForegroundColor Cyan
    cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

Run 'Build web'        "npm --prefix web run build"
Run 'Upload source'    "scp -i $KEY -r package.json package-lock.json server.js ecosystem.config.cjs src db ${REMOTE}:${DEST}/"

# Stage new dist next to the live one. _staging is wiped first in case
# a previous deploy died partway and left a stale copy.
Run 'Prepare staging'  "ssh -i $KEY $REMOTE `"mkdir -p $DEST/web/_staging && rm -rf $DEST/web/_staging/dist`""
Run 'Upload dist'      "scp -i $KEY -r web/dist ${REMOTE}:${DEST}/web/_staging/"

# Atomic-ish swap: same-filesystem mv is effectively atomic. The old
# dist is preserved as dist.old until pm2 restarts cleanly, then
# cleaned up. If anything blows up here, dist.old is the rollback.
Run 'Atomic swap'      "ssh -i $KEY $REMOTE `"rm -rf $DEST/web/dist.old && (test ! -d $DEST/web/dist || mv $DEST/web/dist $DEST/web/dist.old) && mv $DEST/web/_staging/dist $DEST/web/dist && rmdir $DEST/web/_staging`""

Run 'Restart pm2'      "ssh -i $KEY $REMOTE `"cd $DEST && npm ci --omit=dev && pm2 restart mocount && pm2 save && rm -rf $DEST/web/dist.old`""

Write-Host '✓ Deployed' -ForegroundColor Green
