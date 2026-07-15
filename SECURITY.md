# Security policy

ClaimGraph accepts public links and uploaded documents, persists analysis
artifacts, and can invoke paid external services. Security reports involving
authorization, URL retrieval, file parsing, public data exposure, lifecycle
races, resource controls, or cleanup are especially important.

## Supported version

Security fixes target the latest revision of the repository's default branch.
Older deployments should upgrade before requesting support.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow from the repository's
**Security** tab. If that option is unavailable, contact the repository owner
through the [TUPRAM GitHub profile](https://github.com/TUPRAM) and request a
private reporting channel. Do not include exploit details or sensitive data in
a public message.

Please include:

- the affected route, component, or configuration;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- likely impact;
- whether the issue has been tested against the hosted preview;
- any suggested mitigation.

## Disclosure process

The maintainer will acknowledge a complete report, validate severity, and
coordinate a remediation and disclosure timeline. Please allow time for a fix
to be deployed before publishing technical details.

## Security boundaries

The repository's expected boundaries include:

- shared workspace URLs are read-only without owner or developer authority;
- only capability hashes are persisted;
- browser mutations require the canonical origin;
- outbound retrieval rejects private and metadata targets on every redirect;
- uploads and exports remain within configured structural and byte limits;
- public payloads are explicit allowlists;
- canceled or terminal runs cannot be revived by stale work;
- anonymous use, paid work, and provider concurrency have durable ceilings;
- deletion failures remain retryable and visible to protected operators.

Reports showing that any of these boundaries can be bypassed should be treated
as security issues rather than ordinary feature requests.
