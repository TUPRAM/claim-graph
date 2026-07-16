# Deployment guide

This guide describes the supported ClaimGraph deployment shapes and the checks
required before exposing a deployment to untrusted traffic.

## Supported shapes

### Local development

Local development uses SQLite and filesystem storage under
`CLAIMGRAPH_DATA_DIR`. It is the simplest way to exercise the interface, the
curated demo, and source-backed runs on one machine.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The default environment starts in demo mode. Configure a supported analysis
provider when source-backed runs are required.

### Hosted deployment

The hosted path requires:

- a PostgreSQL-compatible database;
- private object storage for uploads and generated exports;
- the durable workflow runner;
- one configured analysis provider;
- a canonical public HTTPS origin;
- strong secrets for abuse-control hashing, cleanup authentication, the
  read-only operations monitor, and the protected developer session;
- a private HTTPS operations-notification webhook.

Use [`.env.example`](../.env.example) as the configuration inventory. It
contains safe placeholders only; real values belong in the hosting platform's
secret store.

## Required production boundaries

Before enabling anonymous traffic, confirm all of the following:

- `CLAIMGRAPH_STORAGE_DRIVER` selects hosted storage.
- Database connectivity and schema initialization succeed.
- Object storage is private and the application can create and delete a test
  object.
- The durable runner is configured and can complete a source-backed run.
- `CLAIMGRAPH_PUBLIC_ORIGIN` is the exact public HTTPS origin.
- Control and session secrets contain at least 32 random bytes.
- `CLAIMGRAPH_MONITOR_SECRET` is set and differs from `CRON_SECRET`.
- `CLAIMGRAPH_OPERATIONS_WEBHOOK_URL` is a private HTTPS receiver. The default
  `CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT=generic` posts the aggregate JSON
  payload directly; configure `CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN` when
  the receiver supports it.
- An optional `github-issue` format may target only
  `https://api.github.com/repos/<owner>/<private-operations-repository>/issues`.
  It requires a short-lived, repository-scoped bearer token with only Issues
  write access. The resulting issue contains the same bounded aggregate
  notification and no workspace, run, file, source, IP, or cleanup-job IDs.
- The authenticated cleanup and independent notification schedules are
  installed. Cleanup produces the heartbeat; `/api/internal/notify` consumes
  monitor state later in the day so a missed cleanup run can raise an alert.
- Creation, analysis, export, upload, paid-run, and provider-concurrency limits
  have explicit production values.
- Retention periods match the published privacy notice.
- The analysis kill switch can be changed without a redeployment.

The anonymous health route intentionally exposes only coarse status and a
timestamp. Detailed component health is available only to the protected
developer session or the cleanup bearer secret. The privacy-minimal operations
snapshot at `/api/internal/monitor` uses only the distinct
`CLAIMGRAPH_MONITOR_SECRET` bearer, returns no workspace, IP, file, or cleanup
job identifiers, and disables caching.

## Build and start

```bash
npm ci
npm run typecheck
npm run test
npm run build
npm run start
```

Run the dependency gate separately:

```bash
npm run audit:security
```

The production deployment should fail closed if the audit result is invalid or
contains a high or critical finding.

## Persistence and cleanup

Hosted storage uses database-backed lifecycle records and retryable cleanup
jobs. Workspace deletion first makes the workspace read-invisible and commits a
deterministic cleanup job in the same transaction. Object deletion and final
database cleanup may then retry with backoff.

Operationally, verify:

- abandoned workspaces expire at the configured TTL;
- uploads and generated exports expire independently;
- QA-created workspaces use the shorter QA TTL;
- failed cleanup attempts are visible only in the protected operations view;
- expired cleanup leases can be reclaimed;
- a failed object-storage delete never becomes an untracked orphan.

## Deployment validation

Before a release, use an isolated staging environment with
production-equivalent services and validate:

1. Create a workspace and retain owner mutation authority.
2. Open the same URL in a clean browser and confirm it is read-only.
3. Submit simultaneous Analyze requests and confirm they return one active run.
4. Cancel during evidence gathering and between stages.
5. Confirm a stale retry cannot revive a canceled run or replace a newer graph.
6. Exercise per-IP, per-workspace, global, paid-run, and concurrency ceilings.
7. Toggle the analysis kill switch and confirm it propagates without a deploy.
8. Upload valid and malformed files near each configured limit.
9. Attempt private, loopback, metadata, credential-bearing, and redirecting
   URLs and confirm rejection before content is consumed.
10. Export Markdown and PNG, then verify retention and retryable deletion.
11. Inspect public graph, run, source, and snippet responses for internal-field
    leakage.
12. Drain cleanup jobs through the authenticated scheduler.
13. Read the protected monitor snapshot with its dedicated bearer and invoke
    the separately scheduled `/api/internal/notify` route with `CRON_SECRET`;
    verify that a changed alert, a delivery retry, a stale cleanup heartbeat,
    and a recovery reach the private operations webhook.

Do not treat the curated demo as proof that hosted analysis, persistence, or
cleanup is configured correctly.

## Rollback

Keep the previous deployment artifact available. If lifecycle, persistence,
privacy, or resource-control verification fails:

1. Activate the analysis kill switch.
2. Stop accepting new anonymous workspaces if necessary.
3. Roll back the application deployment.
4. Leave retryable cleanup enabled.
5. Inspect protected cleanup and run diagnostics before restoring traffic.

Never roll back the database schema independently of application compatibility.
The application must refuse schemas newer than it understands rather than
attempting a destructive downgrade.
