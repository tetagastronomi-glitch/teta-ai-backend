@echo off
setlocal enabledelayedexpansion

REM ==========================================
REM Te Ta AI - Onboarding Commands (AUTO)
REM - Creates restaurant
REM - Auto extracts REST_ID / API_KEY / OWNER_KEY
REM - Sets plan PRO
REM - Runs tests: health, reservations, segments, consents, audience export, owner views
REM ==========================================

set "BASE=https://teta-ai-backend-production.up.railway.app"

REM --- ADMIN KEY (CHANGE IF NEEDED) ---
set "ADMIN_KEY=tta_admin_master_2026lek"

REM --- NEW RESTAURANT NAME (CHANGE) ---
set "NEW_REST_NAME=Restorant Onboarding Auto"

REM --- TEST PHONES (CHANGE IF YOU WANT) ---
set "PHONE_TODAY=0690003333"
set "PHONE_FUTURE=0690002222"

REM --- TEST DATES (CHANGE IF YOU WANT) ---
set "DATE_TODAY=2025-12-23"
set "TIME_TODAY=19:00"
set "DATE_FUTURE=2025-12-30"
set "TIME_FUTURE=20:00"

echo.
echo ==========================================
echo  Te Ta AI - Onboarding (AUTO)
echo  BASE: %BASE%
echo ==========================================
echo.

REM 0) Ping version
echo [0] CHECK VERSION
curl -s "%BASE%/"
echo.
echo.

REM 1) Create restaurant (returns raw keys ONCE)
echo [1] ADMIN CREATE RESTAURANT + GET RAW KEYS (SAVE THEM!)
echo --- NAME: %NEW_REST_NAME%

curl -s -X POST "%BASE%/admin/restaurants" ^
  -H "x-admin-key: %ADMIN_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"%NEW_REST_NAME%\"}" > onboarding_result.json

echo --- Response saved to onboarding_result.json
type onboarding_result.json
echo.
echo.

REM 2) Auto-extract values using PowerShell
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command ^
  "$j=Get-Content -Raw 'onboarding_result.json' | ConvertFrom-Json; $j.data.restaurant.id"`) do set "REST_ID=%%A"

for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command ^
  "$j=Get-Content -Raw 'onboarding_result.json' | ConvertFrom-Json; $j.data.api_key"`) do set "API_KEY=%%A"

for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command ^
  "$j=Get-Content -Raw 'onboarding_result.json' | ConvertFrom-Json; $j.data.owner_key"`) do set "OWNER_KEY=%%A"

if "%REST_ID%"=="" (
  echo ❌ Could not extract REST_ID. Check onboarding_result.json
  pause
  exit /b 1
)
if "%API_KEY%"=="" (
  echo ❌ Could not extract API_KEY. Check onboarding_result.json
  pause
  exit /b 1
)
if "%OWNER_KEY%"=="" (
  echo ❌ Could not extract OWNER_KEY. Check onboarding_result.json
  pause
  exit /b 1
)

echo ✅ Extracted:
echo   REST_ID=%REST_ID%
echo   API_KEY=%API_KEY%
echo   OWNER_KEY=%OWNER_KEY%
echo.
echo =========================================================
echo  IMPORTANT:
echo  - onboarding_result.json has RAW keys (only time you get them)
echo  - Copy them to a safe place now.
echo =========================================================
echo.

REM 3) Set plan PRO
echo [2] ADMIN SET PLAN = PRO
curl -s -X POST "%BASE%/admin/restaurants/%REST_ID%/plan" ^
  -H "x-admin-key: %ADMIN_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"plan\":\"PRO\"}"
echo.
echo.

REM 4) Health DB
echo [3] HEALTH DB (should say db ok + restaurant_id)
curl -s "%BASE%/health/db" ^
  -H "x-api-key: %API_KEY%"
echo.
echo.

REM 5) Reservation TODAY (past/today will increment visits_count)
echo [4] CREATE RESERVATION (TODAY TEST)
curl -s -X POST "%BASE%/reservations" ^
  -H "x-api-key: %API_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"customer_name\":\"Today Test\",\"phone\":\"%PHONE_TODAY%\",\"date\":\"%DATE_TODAY%\",\"time\":\"%TIME_TODAY%\",\"people\":2,\"channel\":\"Instagram\",\"area\":\"brenda\"}"
echo.
echo.

REM 6) Reservation FUTURE (future should NOT increment visits_count / last_seen)
echo [5] CREATE RESERVATION (FUTURE TEST)
curl -s -X POST "%BASE%/reservations" ^
  -H "x-api-key: %API_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"customer_name\":\"Future Test\",\"phone\":\"%PHONE_FUTURE%\",\"date\":\"%DATE_FUTURE%\",\"time\":\"%TIME_FUTURE%\",\"people\":2,\"channel\":\"Instagram\",\"area\":\"brenda\"}"
echo.
echo.

REM 7) Owner customers
echo [6] OWNER CUSTOMERS (READ ONLY)
curl -s "%BASE%/owner/customers?limit=20" ^
  -H "x-owner-key: %OWNER_KEY%"
echo.
echo.

REM 8) Segments (PRO)
echo [7] SEGMENTS (PRO)
curl -s "%BASE%/segments?days=60" ^
  -H "x-api-key: %API_KEY%"
echo.
echo.

REM 9) Consents enable whatsapp+marketing for TODAY phone
echo [8] CONSENTS (SET whatsapp+marketing TRUE for %PHONE_TODAY%)
curl -s -X POST "%BASE%/consents" ^
  -H "x-api-key: %API_KEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\":\"%PHONE_TODAY%\",\"whatsapp\":true,\"marketing\":true,\"consent_source\":\"onboarding_auto\"}"
echo.
echo.

REM 10) Audience export JSON (PRO)
echo [9] AUDIENCE EXPORT JSON (PRO)
curl -s "%BASE%/audience/export?channel=whatsapp&segment=all&days=60&limit=200&format=json" ^
  -H "x-api-key: %API_KEY%"
echo.
echo.

REM 11) Audience export CSV (PRO)
echo [10] AUDIENCE EXPORT CSV (PRO)
curl -s "%BASE%/audience/export?channel=whatsapp&segment=all&days=60&limit=200&format=csv" ^
  -H "x-api-key: %API_KEY%"
echo.
echo.

REM 12) Owner reservations
echo [11] OWNER RESERVATIONS (READ ONLY)
curl -s "%BASE%/owner/reservations?limit=20" ^
  -H "x-owner-key: %OWNER_KEY%"
echo.
echo.

echo ==========================================
echo  DONE ✅
echo  - Restaurant created: %REST_ID%
echo  - Keys saved: onboarding_result.json
echo ==========================================
echo.
pause
endlocal
