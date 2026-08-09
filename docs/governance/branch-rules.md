# Required GitHub repository controls

Apply a branch ruleset to `main` with these settings:

- pull requests required; no direct pushes or force pushes;
- at least one approval and CODEOWNER review;
- dismiss stale approvals after new commits;
- require conversation resolution and linear history;
- require the current branch to be up to date;
- required checks: `Static checks`, `Worker tests`, `CLI tests`,
  `Migration and DOM boundaries`, `Chromium E2E`, and
  `Production dependency audit`;
- administrators and automation do not bypass the ruleset by default.

Create `preview`, `staging`, and `production` GitHub Environments. All three
hold environment-scoped Cloudflare credentials. Production requires an
independent reviewer, prevents self-review, restricts deployment to `main`,
and allows only one deployment at a time. Staging and production credentials
must address different Cloudflare resources.

The repository cannot enforce an independent approval while it has only one
maintainer. In that state the production Environment intentionally remains
unconfigured/blocked; preview and local verification can continue.
