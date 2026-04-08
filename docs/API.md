# Te Ta AI Backend — API Reference

> Auto-generated from modular route files. 81 endpoints total.

## Authentication

| Middleware | Header | Source |
|---|---|---|
| `requireApiKey` | `x-api-key` | DB lookup (`api_keys`) or `API_KEY` env var |
| `requireOwnerKey` | `x-owner-key` | DB lookup (`owner_keys`) |
| `requireAdminKey` | `x-admin-key` | `ADMIN_KEY` env var (timing-safe compare) |
| `requirePlan(plan)` | — | Called after auth; checks restaurant plan |

---

## 1. Health (`routes/health.js`) — 3 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | None | Root ping — plain text |
| GET | `/health` | None | Healthcheck (no DB) |
| GET | `/health/db` | `x-api-key` | Full DB connectivity check |

## 2. Webhook (`routes/webhook.js`) — 2 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/webhook` | None | Meta webhook verification |
| POST | `/webhook` | None | WhatsApp inbound messages |

## 3. Auth (`routes/auth.js`) — 2 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | None (rate limited) | Login via raw key |
| POST | `/auth/pin-login` | None (rate limited) | PIN-based owner login |

## 4. Click Links (`routes/clicklinks.js`) — 2 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/o/confirm/:token` | Token (one-time) | One-click confirm reservation |
| GET | `/o/decline/:token` | Token (one-time) | One-click decline reservation |

## 5. Public API (`routes/public.js`) — 11 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/consents` | `x-api-key` | Upsert marketing consent |
| GET | `/segments` | `x-api-key` + PRO | Customer segments (ACTIVE/WARM/COLD/VIP) |
| GET | `/audience/export` | `x-api-key` + PRO | Export audience (JSON/CSV) |
| POST | `/events` | `x-api-key` | Log calendar event |
| GET | `/events` | `x-api-key` | Fetch events |
| POST | `/reservations` | `x-api-key` | Create reservation (auto-confirm logic) |
| GET | `/reservations` | `x-api-key` | List reservations |
| GET | `/reservations/upcoming` | `x-api-key` | Upcoming reservations |
| POST | `/feedback` | `x-api-key` | Submit feedback ratings |
| GET | `/feedback` | `x-api-key` | List feedback |
| GET | `/reports/today` | `x-api-key` | Today's full report |
| POST | `/feedback/messages` | `x-api-key` | Save WhatsApp feedback message |

## 6. Owner API (`routes/owner.js`) — 21 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/owner/customers` | `x-owner-key` | List customers |
| POST | `/owner/customers` | `x-owner-key` | Add customer manually |
| POST | `/owner/reservations/create` | `x-owner-key` | Create reservation (owner-side) |
| GET | `/owner/reservations` | `x-owner-key` | List reservations |
| POST | `/owner/reservations/:id/confirm` | `x-owner-key` | Confirm pending reservation |
| POST | `/owner/reservations/:id/decline` | `x-owner-key` | Decline pending reservation |
| POST | `/owner/reservations/:id/complete` | `x-owner-key` | Mark as completed |
| POST | `/owner/reservations/:id/no-show` | `x-owner-key` | Mark as no-show |
| POST | `/owner/reservations/:id/cancel` | `x-owner-key` | Cancel reservation |
| POST | `/owner/feedback/send-one` | `x-owner-key` | Send single feedback request |
| POST | `/owner/feedback/send-batch` | `x-owner-key` | Bulk feedback requests |
| POST | `/owner/debug/make/:type` | `x-owner-key` | Fire Make.com test webhook |
| GET | `/owner/reports/feedback/daily` | `x-owner-key` | Daily feedback summary |
| POST | `/owner/support/chat` | `x-owner-key` | Chat with Jerry AI |
| GET | `/owner/ai/insights` | `x-owner-key` | AI business insights |
| POST | `/owner/bot/start` | `x-owner-key` | Activate WhatsApp bot |
| POST | `/owner/bot/stop` | `x-owner-key` | Deactivate WhatsApp bot |
| GET | `/owner/bot/status` | `x-owner-key` | Bot status |
| GET | `/owner/reservations/active-by-phone` | `x-owner-key` | Find active reservation by phone |
| GET | `/owner/missed-messages` | `x-owner-key` | List missed WhatsApp messages |
| POST | `/owner/missed-message` | `x-owner-key` | Log missed message |
| POST | `/cron/reminders` | `x-owner-key` | Cron: send reminders |
| POST | `/cron/feedback-auto` | `x-owner-key` | Cron: auto feedback requests |

## 7. Admin API (`routes/admin.js`) — 22 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/debug-env` | `x-admin-key` | Show masked env vars |
| GET | `/admin/env-check` | `x-admin-key` | Boolean env var presence |
| GET | `/admin/stats` | `x-admin-key` | Platform-wide stats |
| GET | `/admin/restaurants` | `x-admin-key` | List all restaurants |
| GET | `/admin/restaurants/:id` | `x-admin-key` | Restaurant detail |
| POST | `/admin/restaurants` | `x-admin-key` | Create restaurant (auto-generates keys) |
| PATCH | `/admin/restaurants/:id/settings` | `x-admin-key` | Update restaurant settings |
| POST | `/admin/restaurants/:id/plan` | `x-admin-key` | Set plan (FREE/PRO) |
| PATCH | `/admin/restaurants/:id/billing` | `x-admin-key` | Record manual payment |
| DELETE | `/admin/restaurants/:id` | `x-admin-key` | Hard delete restaurant + data |
| GET | `/admin/restaurants/:id/reservations` | `x-admin-key` | Restaurant reservations (admin) |
| GET | `/admin/restaurants/:id/customers` | `x-admin-key` | Restaurant customers (admin) |
| GET | `/admin/restaurants/:id/feedback` | `x-admin-key` | Restaurant feedback (admin) |
| GET | `/admin/restaurants/:id/stats` | `x-admin-key` | Restaurant weekly stats |
| DELETE | `/admin/cleanup-duplicates` | `x-admin-key` | Remove duplicate reservations |
| POST | `/cron/auto-close` | `x-admin-key` | Cron: auto-complete/no-show old reservations |
| POST | `/admin/restaurants/:id/feedback-settings` | `x-admin-key` | Update feedback settings |
| POST | `/admin/keys/disable` | `x-admin-key` | Disable a specific key |
| POST | `/admin/restaurants/:id/rotate-keys` | `x-admin-key` | Rotate all keys for restaurant |
| POST | `/admin/jerry/chat` | `x-admin-key` | Admin chat with Jerry AI |
| GET | `/admin/reservations` | `x-admin-key` | Cross-restaurant reservations |
| POST | `/admin/restaurants/:id/customers` | `x-admin-key` | Add customer (admin-side) |
| GET | `/admin/support-tickets` | `x-admin-key` | List support tickets |
| PUT | `/admin/support-tickets/:id` | `x-admin-key` | Update support ticket |

## 8. Marketing (`routes/marketing.js`) — 6 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/marketing/audience/:restaurantId` | `x-admin-key` | Segmented audience with RFV scores |
| POST | `/admin/marketing/send` | `x-admin-key` | Send campaign (WhatsApp/email) |
| GET | `/admin/marketing/campaigns` | `x-admin-key` | List campaigns |
| GET | `/admin/marketing/campaigns/:id/stats` | `x-admin-key` | Campaign stats + conversions |
| POST | `/admin/marketing/triggers` | `x-admin-key` | Create marketing trigger |
| GET | `/admin/marketing/triggers/:restaurantId` | `x-admin-key` | List triggers |

## 9. Debug (`routes/debug.js`) — 3 endpoints

> Blocked in production (`NODE_ENV=production` returns 404)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/debug/customers` | `x-api-key` | Last 20 customers (dev only) |
| GET | `/debug/reservations-schema` | `x-api-key` | DB schema info |
| GET | `/debug/reservations-constraints` | `x-api-key` | DB constraints info |

## 10. Pages (`routes/pages.js`) — 9 endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin-panel` | None | Admin panel HTML |
| GET | `/command` | None | Command Center HTML |
| GET | `/login` | None | Login page |
| GET | `/platform` | None | Platform page |
| GET | `/dashboard` | None | Owner dashboard |
| GET | `/onboarding` | None | Onboarding page |
| GET | `/admin` | None | Admin page |
| GET | `/test-wa` | `x-admin-key` | Test WhatsApp send |
| GET | `/privacy` | None | Privacy policy HTML |
