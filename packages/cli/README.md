# @getexception/cli

Prepare and privately upload source maps for a GetException project. Requires Node.js 20.19.6 or newer and a GetException server with source map support.

```bash
yarn add --dev --exact @getexception/cli
```

Build your ESM application with external source maps (Vite: `build.sourcemap: "hidden"`). Include `sourcesContent` to display source snippets. Set the SDK's `release` to the same `<project-slug>@<full 40-character Git SHA>` used below.

```bash
yarn build
yarn getexception sourcemaps prepare --dir dist --output .getexception-maps --release "account@$CI_COMMIT_SHA"
yarn getexception sourcemaps upload --dir .getexception-maps --url https://sentry.frontend.sndsy.ru --project "$GETEXCEPTION_PROJECT_ID"
```

The Owner creates **Source map upload tokens** in the project's settings. Store the token in the CI secret `GETEXCEPTION_UPLOAD_TOKEN`. It expires after 90 days and can be revoked. Never pass it as a command-line argument or include it in the browser environment, repository, logs or public artifacts. Only trusted build jobs may read this secret.

For GitLab MR previews use short-lived `GETEXCEPTION_GITLAB_ID_TOKEN` instead, after the operator has configured the pinned GitLab trust policy. Run `getexception ci context --url <HTTPS dashboard origin> --project <UUID>` before building; use the returned release, deployment and asset prefix for the actual JavaScript output. Upload and release registration use that identity automatically. Never set both credential variables. See the [GitLab integration guide](../../docs/gitlab-ci.md) for server configuration, exact build isolation and production restrictions. Version 0.1.7 does not support this flow.

The current CI context contract is **version 2**; CLI 0.1.8 must be upgraded to use it. The Owner selects **Production only** or **Production and MR** under project settings and adds trusted fork project IDs/paths. No container restart is needed. A context includes `sourceMaps: {enabled: true}` or, for a trusted preview with maps disabled, `{enabled: false, reason: "preview_disabled"}`. An unlisted preview source receives only `{version: 2, sourceMaps: {enabled: false, reason: "source_not_allowed"}}` with no build context or release-registration permission. Skip responses mean build/deploy without maps, not disable SDK events. Invalid credentials, HTTP failures and unknown contracts remain errors. A trusted context can still register its release while maps are disabled. Production never receives a skip response.

Permanent upload tokens cannot be created or used for projects with GitLab authentication configured. They remain available for other trusted CI integrations. Forks may upload only their own preview job's maps; the main repository remains the only production source. Actual map read access is never granted to CI.

`prepare` modifies the **final ESM JavaScript**: it adds a Debug ID, shifts mappings by one line, removes sourceMappingURL comments and moves `.js.map` / `.mjs.map` files out of the public build. The private output directory must not exist and must be outside `dist`. Run this once per fresh build, before compression, SRI signing or deployment. Legacy IIFE/CommonJS bundles are unsupported. If assets are served below an additional base path, pass `--url-prefix <base-path>`; paths must match deployed JavaScript URLs.

Deploy the resulting `dist` unchanged. Upload failure does not undo preparation: retry within the same job using the same prepared directory. **Do not save source maps as GitLab artifacts or cache when access has not been verified.** The GitLab identity flow keeps them only in the isolated job workspace and uploads directly to GetException. A retry after that job ends requires a new build with a new job prefix; it cannot replace maps for the old build. Do not run `prepare` twice or rebuild only the maps. Never publish the private artifact directory alongside the application. Other map formats (for example CSS maps) should also be excluded from the public deploy artifact by your build configuration.

`upload` sends an authenticated manifest, uploads files with checksums, then waits for background validation. It supports retries and resuming the same manifest, has a two-minute deadline, and exits nonzero on failure. CI may allow an urgent production deployment without maps with an explicit warning. MR previews with maps enabled require all batches to be ready before deploying. Do not retain maps in GitLab artifacts as a fallback. Raw maps have no download endpoint.

Limits: 128 JS files and 128 MiB per upload, 16 MiB per map, 1 GiB per project, 10 GiB per installation. Non-indexed Source Map v3 JSON only; no archives, compression or remote source downloads. Existing events are processed after a late upload. Errors thrown in the browser console have no source file and cannot gain a source snippet from a map.

MIT. See `THIRD-PARTY-NOTICES.md`.

## Release context

Register the environment after a successful deployment, with the same project token. This works independently of source-map upload:

```bash
yarn getexception releases register --url https://sentry.frontend.sndsy.ru --project "$GETEXCEPTION_PROJECT_ID" --release "account@$CI_COMMIT_SHA" --environment staging --repository-id "$CI_MERGE_REQUEST_TARGET_PROJECT_ID" --merge-request "$CI_MERGE_REQUEST_IID"
```

Use the GitLab target repository's numeric project ID and the MR IID belonging to it. Standard merge-request pipelines provide these [predefined GitLab variables](https://docs.gitlab.com/ci/variables/predefined_variables/); custom preview pipelines must supply the actual pair explicitly. For production, use `--environment production` and omit both MR options. Repeated registration is safe. One SHA may have both production and staging contexts; this records release history, not current deployment status. Old events only establish an environment and cannot reveal an MR number.

With GitLab build authentication, use the exact `release` and `deployment` returned by `ci context` instead of constructing registration metadata yourself. `CI_MERGE_REQUEST_PROJECT_ID` is not a substitute for the target project in a fork workflow.

Debug IDs are deterministic for identical JS, maps and paths, regardless of the release SHA. The server reuses private bytes within the project and `upload` skips files it already has. Every release still sends its own manifest. Changed JavaScript requires its matching map: there is no fallback to the latest production map. Ready maps older than 30 days are eligible for cleanup only when their release has no retained events or pending inbox events. Shared files survive until all references expire.
