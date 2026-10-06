GetException prototype: private error monitoring, invitation-only workspace membership,
Owner/Developer/Viewer roles, MFA, browser and React SDKs, and PostgreSQL workers.

Installation and upgrade instructions: [deployment guide](https://github.com/GetException/GetException/blob/stable/docs/deployment.md).

The installer verifies the release identity and preserves existing credentials and data.
Releases are initially marked prerelease. CI promotes a release after the published
installer and npm-published SDKs pass setup, event ingestion, update, rollback and backup
restoration tests together. SDK packages, images and installation assets use the same
prepared commit. With automatic deployment enabled, each push to stable runs this full
pipeline and updates the existing server after verification. Install a completed, verified release.

This release adds optional application version metadata, such as `3.192.75`, to the
browser/React SDK and GitLab deployment integration. The dashboard shows it alongside
the immutable commit-based build identity. Source maps continue to match the exact
project, release and compiled file; their storage and upload permissions remain private.

Issues can be filtered by release and first appearance. Release pages show a new-issue
count, and issue details show the first and latest observed releases in the selected
environment. First appearances are distinct from regressions and are retained for
90 days after the last occurrence in that environment, independently of the shorter
event retention. Migrated incomplete history is displayed as unknown rather than new.

Project settings now support name, slug and allowed-origin changes without changing
the DSN. Owners can delete projects, restore them within seven days, and let the
retention worker remove their data after the deadline. The current migration advances
runtime schema to 11; existing accounts, projects and events are preserved.
An application-only rollback to a schema-10 release is incompatible. If disaster
recovery is needed, use the verified backup and its matching release as described
in the deployment guide.
