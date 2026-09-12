GetException prototype: private error monitoring, invitation-only workspace membership,
Owner/Developer/Viewer roles, MFA, browser and React SDKs, and PostgreSQL workers.

Installation and upgrade instructions: [deployment guide](https://github.com/GetException/GetException/blob/stable/docs/deployment.md).

The installer verifies the release identity and preserves existing credentials and data.
Releases are initially marked prerelease. CI promotes a release after the published
installer and npm-published SDKs pass setup, event ingestion, update, rollback and backup
restoration tests together. SDK packages, images and installation assets use the same
prepared commit. With automatic deployment enabled, each push to stable runs this full
pipeline and updates the existing server after verification. Install a completed, verified release.

Source map upload/symbolication is not implemented in this prototype.
