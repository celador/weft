# Governance

Weft (the Weft Coordination Protocol, the Agent Hooks Core and their reference implementation)
follows a lightweight model based on the LF
[Minimum Viable Governance](https://github.com/github/MVG) template.

## Roles

- **Maintainers** can merge pull requests, cut releases and edit the specifications. They are
  listed in [MAINTAINERS.md](MAINTAINERS.md).
- **Contributors** are anyone who files issues, reviews, or opens pull requests under
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Decisions

- Day-to-day changes: lazy consensus in public pull requests. A maintainer may merge after review
  once the CONTRIBUTING.md proof requirements are met.
- Specification changes (`docs/protocol/*`): an issue first, then a pull request with the spec
  diff, open for at least 5 days. Maintainers decide by consensus; if consensus fails, by majority
  vote of maintainers. While there is a single maintainer, that maintainer decides and records the
  reasoning in the pull request.
- Every decision and its reasoning is public, in GitHub issues, pull requests or Discussions.

## Becoming a maintainer

A contributor with a sustained record of accepted work (as a guide, several merged pull requests
over at least 90 days) may be nominated by any maintainer and is added by consensus of the
existing maintainers. The project actively seeks maintainers from other organizations; no single
organization should hold a majority of maintainer seats once there are three or more.

## Releases

The specifications are versioned independently (`hooks-core-vX.Y`, `wcp-vX.Y` tags). Breaking
changes require a new major version and a migration note.

## Security

See [SECURITY.md](.github/SECURITY.md).

## Changes to this document

By pull request, using the specification-change process above.
