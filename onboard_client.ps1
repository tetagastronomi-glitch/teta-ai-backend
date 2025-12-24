param(
  [Parameter(Mandatory=$true)][string]$Name,
  [ValidateSet("FREE","PRO")][string]$Plan = "PRO"
)

$Base = "https://teta-ai-backend-production.up.railway.app"
$AdminKey = "tta_admin_master_2026lek"

$SafeName = ($Name -replace '[^\w\- ]','').Trim()
$Stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$OutDir = "C:\Users\User\Desktop\teta-ai-backend\clients"
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$OutFile = Join-Path $OutDir ("{0}_{1}.txt" -f ($SafeName -replace ' ','-'), $Stamp)

Write-Host "=== Te Ta AI Onboarding ==="
Write-Host "Name: $Name"
Write-Host "Plan: $Plan"
Write-Host "Saving to: $OutFile"
Write-Host ""

# 1) Create restaurant
Write-Host "1) Creating restaurant..."
$createBody = @{ name = $Name } | ConvertTo-Json
$create = Invoke-RestMethod -Method POST -Uri "$Base/admin/restaurants" `
  -Headers @{ "x-admin-key" = $AdminKey; "Content-Type"="application/json" } `
  -Body $createBody

if (-not $create.success) { throw "Create restaurant failed: $($create | ConvertTo-Json -Depth 10)" }

$rid = [int]$create.data.restaurant.id
$apiKey = [string]$create.data.api_key
$ownerKey = [string]$create.data.owner_key

Write-Host "✅ Created restaurant_id=$rid"
Write-Host ""

# 2) Set plan
Write-Host "2) Setting plan..."
$planBody = @{ plan = $Plan } | ConvertTo-Json
$planRes = Invoke-RestMethod -Method POST -Uri "$Base/admin/restaurants/$rid/plan" `
  -Headers @{ "x-admin-key" = $AdminKey; "Content-Type"="application/json" } `
  -Body $planBody

Write-Host "✅ Plan set: $($planRes.data.plan)"
Write-Host ""

# 3) Health/db test
Write-Host "3) Testing /health/db..."
$health = Invoke-RestMethod -Method GET -Uri "$Base/health/db" `
  -Headers @{ "x-api-key" = $apiKey }

Write-Host "✅ health ok: restaurant_id=$($health.restaurant_id) now_local=$($health.now_local)"
Write-Host ""

# 4) Create reservation test (today in Albania)
# (simple: use today's date from local machine; ok for onboarding)
$today = (Get-Date).ToString("yyyy-MM-dd")
Write-Host "4) Creating reservation test..."
$resBody = @{
  customer_name = "Onboarding Test"
  phone = "0690000000"
  date = $today
  time = "20:30"
  people = 2
  channel = "Onboarding"
  area = "brenda"
} | ConvertTo-Json

$res = Invoke-RestMethod -Method POST -Uri "$Base/reservations" `
  -Headers @{ "x-api-key" = $apiKey; "Content-Type"="application/json" } `
  -Body $resBody

Write-Host "✅ reservation created: status=$($res.data.status) id=$($res.data.id)"
Write-Host ""

# 5) Owner reservations check
Write-Host "5) Testing owner view..."
$owner = Invoke-RestMethod -Method GET -Uri "$Base/owner/reservations?limit=5" `
  -Headers @{ "x-owner-key" = $ownerKey }

Write-Host "✅ owner reservations count: $($owner.data.Count)"
Write-Host ""

# Save keys to file
@"
=== CLIENT ONBOARDING RESULT ===
NAME: $Name
RESTAURANT_ID: $rid
PLAN: $Plan

API_KEY: $apiKey
OWNER_KEY: $ownerKey

OWNER ENDPOINTS:
- $Base/owner/reservations
- $Base/owner/customers

NOTES:
- RAW keys shown once. Store securely.
- Give CLIENT only OWNER_KEY. Keep API_KEY + ADMIN_KEY private.
"@ | Out-File -FilePath $OutFile -Encoding UTF8

Write-Host "✅ Saved keys + info to: $OutFile"
Write-Host "=== DONE ==="
