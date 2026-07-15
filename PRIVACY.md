# Privacy notice

ClaimGraph creates shareable argument maps from a question, public links, and
optional uploaded files. This notice describes the repository's intended data
boundaries. A deployed operator remains responsible for publishing contact
details, applicable legal terms, and any jurisdiction-specific disclosures.

## Information submitted

A workspace may contain:

- the question and workspace settings;
- public source URLs;
- uploaded file names and file contents;
- extracted snippets and source metadata;
- claims, counterclaims, evidence, gaps, and graph relationships;
- run, export, and cleanup metadata needed to operate the service.

Do not submit confidential, regulated, privileged, or personally sensitive
material to a public deployment.

## Shared workspaces

Anyone with a workspace URL can read its public graph. The public response may
include the question, source titles, public source links, uploaded file names,
cited excerpts, graph nodes, and relationships.

Raw uploads, private object-storage addresses, owner capabilities, internal
diagnostics, provider cleanup identifiers, and protected operations data are
not part of the public workspace contract.

Creating a workspace also creates an unguessable owner capability. The service
stores only its hash. The capability authorizes mutations such as rebuilding,
canceling, changing files, persisting exports, and deleting the workspace. A
shared URL without that capability remains read-only.

## Processing

Depending on deployment configuration, submitted material may be sent to
configured analysis, search, storage, database, and hosting providers. Operators
must review those providers' terms, data locations, and retention policies
before accepting public traffic.

## Default retention

The checked-in defaults are:

| Data | Default retention |
| --- | ---: |
| Abandoned workspaces | 14 days |
| Uploaded files | 30 days |
| Generated exports | 24 hours |
| QA-created workspaces | 24 hours |

Deployments may choose shorter limits. If an operator changes these defaults,
the public notice shown by that deployment must be updated to match.

Deletion first removes public access and records durable cleanup work. Object
and database cleanup can retry with backoff when a provider is temporarily
unavailable.

## Security and abuse prevention

The service may retain bounded technical records needed to enforce creation,
analysis, upload, export, paid-run, and concurrency limits. IP-derived abuse
keys are protected with a deployment secret and should not be exposed through
public APIs.

## Contact

For repository privacy questions, contact the maintainer through the
[TUPRAM GitHub profile](https://github.com/TUPRAM). Report security issues
privately according to [SECURITY.md](SECURITY.md).
