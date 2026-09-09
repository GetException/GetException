GetException prototype: private error monitoring, invitation-only workspace membership,
Owner/Developer/Viewer roles, MFA, browser and React SDKs, and PostgreSQL workers.

Installation and upgrade instructions: [deployment guide](https://github.com/GetException/GetException/blob/stable/docs/deployment.md).

The installer verifies the release identity and preserves existing credentials and data.
Releases are initially marked prerelease. CI promotes a release after the published
installer passes setup, event ingestion, update, rollback and backup restoration tests.
Install a completed, verified release. SDK publication is a separate manual workflow;
this server release does not require an npm token or published SDK packages.

Source map upload/symbolication is not implemented in this prototype.
