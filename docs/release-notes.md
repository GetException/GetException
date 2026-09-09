GetException prototype: private error monitoring, invitation-only workspace membership,
Owner/Developer/Viewer roles, MFA, browser and React SDKs, and PostgreSQL workers.

Installation and upgrade instructions: [deployment guide](https://github.com/GetException/GetException/blob/stable/docs/deployment.md).

The installer verifies the release identity and preserves existing credentials and data.
Releases are initially marked prerelease. CI promotes a release after the published
installer and npm SDKs pass the bootstrap test. Install a completed, verified release.

Source map upload/symbolication is not implemented in this prototype.
