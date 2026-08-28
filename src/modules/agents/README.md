# agents

Field workers with an `AgentProfile`, plus their milestone board and training
library.

```
agents/
  agents.*            the AgentProfile directory and requireAgentProfile
  milestones/         AgentMilestone, MilestoneTemplate, TrainingResource
```

## Three things called "milestone", and "agent"

| Name | What | Where |
| --- | --- | --- |
| **agent milestones** (here) | agent gamification — targets, rewards, tiers | `AgentMilestone`, `MilestoneTemplate` |
| `order-milestones` | per-order fulfilment checklist | `OrderMilestone`, `MilestonePlan` |
| `employees` | internal staff HR records | `Employee` |

They share vocabulary and nothing else. Do not merge them.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/agents` | ADMIN |
| GET | `/api/v1/agents/:id` | ADMIN |
| GET | `/api/v1/milestones` | `authenticate` (agent's own board) |
| POST | `/api/v1/milestones/templates` | ADMIN (**201**) |
| GET | `/api/v1/training` | `authenticate` |
| POST | `/api/v1/training` | ADMIN (**201**) |

## Owned Prisma entities

`AgentProfile`, `AgentMilestone`, `MilestoneTemplate`, `TrainingResource`.

`AgentProfile` rows are *created* by `users` when an agent role is granted;
`agents` owns them from then on.

## Public exports (`index.ts`)

- `agentRouter`, `milestoneRouter`, `trainingRouter`.
- **`requireAgentProfile(userId)`** — resolves the caller's agent profile or
  throws `404 Agent profile not found`. Used by `orders`, `order-milestones`,
  `earnings` and `publishers`.
- `findAgentProfile(userId)` — the same lookup without the throw.
- `incrementMilestoneProgress(agentId, type)`.

## The duplication this module retired

`prisma.agentProfile.findUnique({ where: { userId } })` followed by
`throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found')` appeared
**twelve times** across `publisher`, `order`, `orderMilestone` (×4), `earnings`
(×2), `milestone`, `digio` (×2) and `agent`. It is now one function. If the
message or status ever needs to change, it changes once.

## Invariants

- The agent listing meta is `{ total, limit, offset }` — **not** the
  `{ page, pageSize, total, totalPages }` shape the other admin listings use.
  Both are contract; do not normalise.
- `search` matches the **joined user's** name or mobile, not agent-profile
  fields.
- The by-id join includes `email`; the listing join does not.
- `GET /milestones` materialises rows lazily: every active template the agent
  has no row for is created on read, so a new template appears for everyone
  without a backfill. It also returns the agent's `tier` alongside the board.
- `category=All` on the training listing is the UI's no-filter sentinel, not a
  real category.
- `incrementMilestoneProgress` advances every incomplete milestone of the given
  type by one and completes those reaching their target.

## Tests

```bash
npx vitest run src/modules/agents
```

## Suggested ownership

Agent-experience team, alongside `earnings`.
