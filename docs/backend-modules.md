# Backend modules

The backend is a modular monolith. Code is organised by **business domain**, not
by technical layer: everything about orders lives under `modules/orders`, not
scattered across `controllers/`, `routes/` and `services/`.

```
src/
  app.ts  server.ts        thin entry points
  bootstrap/               assembly: create-app, register-modules, shutdown, health
  config/                  process environment validation (Zod over .env)
  shared/                  infrastructure every module may use
  modules/                 the 20 business domains
  jobs/  scripts/          background work and one-off tooling
```

## Ownership

| Module | Owns | Routes | Suggested owner |
| --- | --- | --- | --- |
| `auth` | Otp, RefreshToken, PasswordResetToken, User credentials | `/auth/*` | Senior — every change is a security change |
| `users` | User profile, UserRole | `/users/*` | Senior, shared with auth |
| `access-control` | RoleConfig | `/roles-config/*` | Platform |
| `employees` | Employee | `/employees/*` | Platform |
| `qr` | QrCode, QrScan | `/qr/*` | Platform |
| `publishers` | Publisher, PublisherKyc | `/publishers/*`, `/webhooks/digio` | Supply-side |
| `listings` | Listing, ListingPhoto | `/listings/*` | Supply-side |
| `orders` | Order, OrderAgentAssignment, CheckIn, SiteVerification | `/orders/*` | Own team — core domain |
| `order-milestones` | OrderMilestoneTemplate, MilestonePlan(Item), OrderMilestone(Evidence) | `/milestone-templates/*`, `/milestone-plans/*`, `/orders/:orderId/milestones/*`, `/agent/milestones/*` | With orders |
| `agents` | AgentProfile, AgentMilestone, MilestoneTemplate, TrainingResource | `/agents/*`, `/milestones/*`, `/training/*` | Agent experience |
| `earnings` | Transaction | `/earnings/*` | Agent experience |
| `banking` | BankAccount | `/banking/*` | Agent experience |
| `notifications` | Notification, NotificationPreference | `/notifications/*` | Small — good first module |
| `support` | SupportTicket, TicketMessage | `/support/*` | Small |
| `onboarding` | OnboardingFlowTemplate, OnboardingSubmission | `/onboarding/*` | Platform |
| `kyc` | AdvertiserKyc, UserKyc | `/advertiser-kyc/*`, `/user-kyc/*` | One owner for both review flows |
| `advertisements` | Advertisement | `/advertisements/*` | Advertiser-side |
| `uploads` | UploadedFile | `/upload` | Platform |
| `integrations` | (AppConfig credentials row) | `/integrations` | Platform — credential handling |
| `app-config` | AppConfig `main` row | `/config` | Platform |

Every module has a `README.md` with its routes, entities, exports, dependencies
and — most importantly — its **invariants**. Read that before changing one.

## Names that collide

Three pairs share vocabulary and nothing else. Each module's README opens by
distinguishing them.

| These are different | |
| --- | --- |
| `agents` milestones | gamification: targets, rewards, tiers |
| `order-milestones` | per-order fulfilment checklist |
| `employees` | internal staff HR records |
| `agents` | field workers with an AgentProfile |
| `publishers` onboarding | agent-run QR claim flow, on site |
| `onboarding` | back-office admin intake form |
| `app-config` | enums + flow definitions (AppConfig `main`) |
| `config/` | process environment validation |
| `integrations` | third-party credentials (a different AppConfig row) |

## Dependency graph

Arrows point at the dependency. Everything may use `shared/`; nothing in
`shared/` may import a module.

```
                       ┌──────────────┐
                       │  bootstrap   │  mounts every module router
                       └──────┬───────┘
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌──────────┐          ┌───────────┐
   │  auth   │◄─────────│  users   │◄─────────│ support   │
   └─────────┘          └────┬─────┘          │ employees │
        ▲                    │                └───────────┘
        │                    ▼
   ┌────┴─────┐        ┌──────────┐
   │onboarding│        │  agents  │◄──── earnings, order-milestones
   └──────────┘        └────┬─────┘
                            ▼
   ┌─────────┐   port   ┌────────────┐        ┌──────────┐
   │   qr    │◄─────────│ publishers │───────►│ listings │
   └─────────┘  ───────►└────────────┘        └────┬─────┘
                 mint                              │
                                                   ▼
   ┌───────────────┐                          ┌──────────┐
   │notifications  │◄─────────────────────────│  orders  │
   └───────────────┘                          └────┬─────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │ order-milestones │──► app-config
                                          └──────────────────┘
```

`qr ↔ publishers` is the only pair that needs both directions. It is resolved
with a **port**: `qr` declares `PublisherOnboardingPort`, `publishers`
implements it, and `bootstrap` registers it — so `qr` never imports
`publishers` and there is no cycle. See `modules/qr/README.md`.

## Rules

### Adding an endpoint

1. Add the route to the owning **module's** `*.routes.ts`. Never to
   `bootstrap/register-modules.ts` — that file only decides where a module's
   router is mounted.
2. Validation goes in the module's `*.schema.ts`, as Zod.
3. The controller translates HTTP to a service call and back. No business rules,
   no Prisma.
4. Business rules go in the service. Services never touch `req`/`res`.
5. Queries go in `prisma-<module>.repository.ts`, behind the interface in
   `<module>.repository.ts`.
6. Regenerate the route snapshot and review the diff:
   `npm run routes:snapshot && git diff docs/route-inventory.json`.
7. Add the invariant to the module README if it is not obvious from the code.

### Talking to another module

- Import **only** its `index.ts`: `import { createNotification } from '../notifications'`.
  Reaching into `../notifications/notifications.service` is a lint error.
- Do not query another module's tables. If you need data it owns, add a narrow
  export to that module. Several already exist for exactly this:
  `users.getUserDisplayName`, `agents.requireAgentProfile`,
  `listings.setListingAvailability`, `orders.getOrderSummary`,
  `qr.findActiveQrFor`.
- If both modules need each other, invert one direction with a port rather than
  accepting a cycle.
- `shared/` is the bottom of the graph and may never import a module.

### Where Prisma may appear

Only in `prisma-*.repository.ts` files, plus `shared/database`, `jobs/` and
`scripts/` (composition roots). Type-only imports of generated model and enum
types are fine anywhere — they erase at compile time.

### Transactions

A `$transaction` lives in **one** repository method. Do not split one across
repositories to satisfy a boundary rule — that turns a correct write into a
data-integrity bug. `users.deleteUserCascade` is the deliberate example, and
its README says so.

### Naming

| Thing | Pattern |
| --- | --- |
| Module directory | `kebab-case`, plural where it is a collection |
| Files | `<module>.<role>.ts` — `orders.controller.ts`, `orders.schema.ts` |
| Prisma implementation | `prisma-<module>.repository.ts` (the lint rules key off this) |
| Subfeature directory | `kebab-case` verb or stage — `assignment/`, `self-install/` |
| Public surface | `index.ts`, with a comment saying who each export is for |

## Testing

```bash
npm test                      # everything
npm run typecheck             # src + tests + scripts
npm run arch                  # dependency-cruiser + eslint boundary rules
npm run build                 # production tsc
npm run routes:snapshot       # regenerate docs/route-inventory.json

npx vitest run src/modules/orders     # one module
```

Three gates protect the refactor and should protect future changes too:

- `tests/architecture/route-inventory.test.ts` — diffs the live router tree,
  **in order**, against `docs/route-inventory.json`.
- `tests/contract/auth-topology.test.ts` — drives all 167 routes: every
  authenticated route must reject a missing and a malformed token, every
  role-guarded route must reject a role outside its guard, and the six
  deliberately public endpoints must stay public.
- `npm run arch` — no cycles, no deep cross-module imports, no Prisma outside a
  repository, no `shared/` importing a module.

## Migration status

Every file from the pre-refactor tree. Nothing is left behind:
`src/controllers/`, `src/routes/`, `src/services/`, `src/lib/`,
`src/middleware/` and `src/constants/` no longer exist.

| Old file | Now |
| --- | --- |
| `app.ts` | `app.ts` (thin) + `bootstrap/create-app.ts` |
| `server.ts` | `server.ts` + `bootstrap/graceful-shutdown.ts` |
| `config/env.ts` | `config/env.ts` |
| `config/loadEnv.ts` | `config/load-env.ts` |
| `constants/appEnums.ts` | `modules/app-config/app-enums.ts` |
| `lib/errors.ts` | `shared/errors/api-error.ts` + `shared/http/async-handler.ts` |
| `lib/logger.ts` | `shared/logging/logger.ts` |
| `lib/prisma.ts` | `shared/database/prisma.ts` |
| `lib/redis.ts` | `shared/cache/redis.ts` |
| `lib/zod.ts` | `shared/validation/zod.ts` |
| `middleware/authenticate.ts` | `shared/auth/authenticate.ts` + `shared/auth/jwt.ts` + `shared/auth/express.d.ts`; `requirePublisherOnboarded` **deleted** (dead, and business logic in middleware) |
| `middleware/captcha.ts` | `shared/security/captcha.ts` |
| `middleware/errorHandler.ts` | `shared/errors/error-handler.ts` |
| `middleware/notFound.ts` | `shared/errors/not-found.ts` |
| `middleware/rateLimit.ts` | `shared/security/rate-limit.ts` |
| `middleware/requestLogger.ts` | `shared/logging/request-logger.ts` |
| `routes/index.ts` | `bootstrap/register-modules.ts` |
| `routes/*.ts` (20 files) | each module's `*.routes.ts` |
| `controllers/advertisement.ts` | `modules/advertisements/` |
| `controllers/advertiserKyc.ts` | `modules/kyc/advertiser/` |
| `controllers/agent.ts` | `modules/agents/` |
| `controllers/auth.ts` | `modules/auth/{otp,password,tokens,publisher}/` |
| `controllers/banking.ts` | `modules/banking/` |
| `controllers/config.ts` | `modules/app-config/` |
| `controllers/digio.ts` | `modules/publishers/kyc/digio.controller.ts` |
| `controllers/earnings.ts` | `modules/earnings/` |
| `controllers/employee.ts` | `modules/employees/` (+ `employees.policy.ts`) |
| `controllers/integrations.ts` | `modules/integrations/` (+ `.mapper.ts`, `.schema.ts`) |
| `controllers/milestone.ts` | `modules/agents/milestones/` |
| `controllers/notification.ts` | `modules/notifications/` |
| `controllers/onboarding.ts` | `modules/onboarding/` |
| `controllers/order.ts` | `modules/orders/` + `modules/orders/tracking/` |
| `controllers/orderMilestone.ts` | `modules/order-milestones/` |
| `controllers/publisher.ts` | `modules/publishers/` + `modules/listings/` |
| `controllers/qr.ts` | `modules/qr/` |
| `controllers/rolesConfig.ts` | `modules/access-control/` |
| `controllers/support.ts` | `modules/support/` |
| `controllers/upload.ts` | `modules/uploads/` (+ `.middleware.ts`) |
| `controllers/user.ts` | `modules/users/` |
| `controllers/userKyc.ts` | `modules/kyc/user/` |
| `services/activityLog.service.ts` | `shared/audit/activity-log.ts` |
| `services/digio.service.ts` | `modules/publishers/kyc/digio.service.ts` |
| `services/earnings.service.ts` | `modules/earnings/` |
| `services/integrationConfig.service.ts` | `shared/integrations/integration-config.ts` |
| `services/loginSecurity.service.ts` | `modules/auth/password/login-security.service.ts` |
| `services/mail.service.ts` | `shared/email/mail.ts` |
| `services/milestone.service.ts` | `modules/agents/milestones/` |
| `services/notification.service.ts` | `modules/notifications/` |
| `services/order.service.ts` | `modules/orders/{placement,assignment,scheduling,fulfilment,verification}/` |
| `services/orderAssignment.service.ts` | `modules/orders/assignment/` |
| `services/orderMilestone.service.ts` | `modules/order-milestones/{templates,plans,order,agent}/` |
| `services/otp.service.ts` | `modules/auth/otp/` |
| `services/password.service.ts` | `modules/auth/password/` |
| `services/publisher.service.ts` | `modules/publishers/` + `modules/listings/` |
| `services/qr.service.ts` | `modules/qr/` (+ `qr.token.ts`, `qr.ports.ts`) |
| `services/resend.service.ts` | `shared/email/resend.ts` |
| `services/sms.service.ts` | `shared/sms/sms.ts` |
| `services/storage.service.ts` | `shared/storage/storage.ts` |
| `services/support.service.ts` | `modules/support/` |
| `services/token.service.ts` | `modules/auth/tokens/` (signing moved to `shared/auth/jwt.ts`) |
| `jobs/publisherTimer.ts` | `jobs/publisher-timer.job.ts` |
| `scripts/createUser.ts`, `scripts/seedConfig.ts` | unchanged location, imports repointed |

## What did not change

The Prisma schema, every migration, and all 167 API routes — their paths,
methods, middleware order, status codes and response bodies. The frontend was
not touched.
