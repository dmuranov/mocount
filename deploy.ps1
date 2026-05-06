# deploy.ps1 — push local mocount build to VM, restart pm2.
# Run from the repo root: ./deploy.ps1

$VM_IP  = "51.145.161.85"
$KEY    = "C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem"
$REMOTE = "azureuser@$VM_IP"
$DEST   = "/home/azureuser/mocount"

# Build the React bundle if it exists. Step 13 introduces web/, before then
# this block is a no-op so deploy.ps1 works from step 1 onward.
if (Test-Path "web/package.json") {
    Write-Host "→ Building web client..." -ForegroundColor Cyan
    Push-Location web
    npm run build
    Pop-Location
}

Write-Host "→ Uploading to VM..." -ForegroundColor Cyan
$args = @(
    "-i", $KEY, "-r",
    "package.json", "package-lock.json", "server.js", "ecosystem.config.js"
)
# Add directories that may not exist yet (later steps create them).
foreach ($dir in @("src", "db", "web/dist")) {
    if (Test-Path $dir) { $args += $dir }
}
$args += "${REMOTE}:${DEST}/"
& scp @args

Write-Host "→ Restarting on VM..." -ForegroundColor Cyan
ssh -i $KEY $REMOTE "cd $DEST && npm ci --omit=dev && pm2 restart mocount && pm2 save"

Write-Host "✓ Deployed" -ForegroundColor Green
