# Contributing to ClaimGraph

Bug reports and product proposals are welcome. ClaimGraph is distributed under
the source-available evaluation terms in [LICENSE](LICENSE), so unsolicited
external code contributions are not accepted at this time. This guide applies
to TUPRAM maintainers and collaborators who have been authorized to submit
code.

## Before you start

- Search existing issues before opening a duplicate.
- Use a focused issue for behavior changes or substantial refactors.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).
- Do not open a code pull request unless TUPRAM has authorized the contribution.

## Product invariants

Contributions must preserve these rules:

- The graph remains the primary output.
- Every non-question node has source and snippet provenance.
- Confidence describes grounding and placement, not truth.
- Counterclaims and unresolved gaps remain explicit.
- Claims stay atomic and the rendered graph stays readable.
- Layout remains deterministic application code.
- Public responses expose allowlisted fields only.

## Development setup

```bash
git clone https://github.com/TUPRAM/claim-graph.git
cd claim-graph
npm ci
cp .env.example .env.local
npm run dev
```

The default configuration uses the curated demo and does not require connected
services. Never commit `.env.local` or real credentials.

## Verification

Run the complete local gate before opening a pull request:

```bash
npm run typecheck
npm run test
npm run build
npm run audit:security
```

Add focused tests for changed behavior. Trust-sensitive changes should cover
both the accepted path and the fail-closed path. Lifecycle changes should cover
stale retries, cancellation, and concurrent requests where applicable.

## Authorized pull requests

Keep pull requests small enough to review. A good description explains:

- what changed;
- why it changed;
- user-visible or operational impact;
- verification performed;
- remaining limitations or follow-up work.

Do not include generated build output, local runtime data, screenshots that
contain private workspace information, or secrets in commits.

Authorized contributors confirm that they have the right to submit the work and
that TUPRAM may use, modify, distribute, and relicense the submitted
contribution as part of ClaimGraph. Authorization to contribute does not grant
any license to the rest of this repository.
