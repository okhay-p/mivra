# Releasing Mivra

`.github/workflows/release.yml` releases a version tag (ADR-013). It only builds and publishes; tests run in the review gate.

1. Bump `version` in `packages/mivra/package.json` in a PR, through the review gate, and merge it.
2. Tag the merge commit on `main` and push the tag: `git tag v<version> && git push origin v<version>`.
3. The workflow takes it from there:
   - It checks that the tag matches the version and that the commit is on `main`.
   - It builds and publishes `@okhay-p/mivra` to npm through trusted publishing (OIDC, no stored token, with provenance).
   - It waits until npm serves the new version, then builds the image from it, pushes `ghcr.io/okhay-p/mivra:<version>` and `:latest`, and smoke-tests it.
   - A version with a prerelease suffix (`1.2.0-beta.1`) goes to npm's `next` tag and never becomes `latest`.
   - Rerunning it skips a version that's already on npm.
4. Smoke-test from the registries: `npx @okhay-p/mivra@<version> --version` in an empty folder, and `docker run --rm ghcr.io/okhay-p/mivra:<version> mivra --version`.

To check a release before tagging, run the workflow by hand from the Actions tab with **dry-run** on (the default). It builds everything and runs `npm publish --dry-run`, then builds the image without pushing it. Only a tag publishes.

One-time setup, on the owner's accounts:
- **npm:** under the package's Settings → Trusted publishing, add GitHub Actions with owner `okhay-p`, repository `mivra`, workflow `release.yml` and environment `release`. A new trusted publisher only allows staged publishing by default, so also allow direct `npm publish`, or the workflow's publish fails. The setup expires if no release publishes through it within two days, so push the next tag soon after (or set it up again then).
- **GHCR:** in the `mivra` package's settings, under Manage Actions access, add the `okhay-p/mivra` repository with the Write role. The package was first pushed by hand, so the workflow's `GITHUB_TOKEN` can't push to it otherwise.
- **Optional:** in the repo's Settings → Environments → `release`, add yourself as a required reviewer, so each release waits for your approval.

**By hand, if the workflow can't run:**
1. From a clean `main`, run `pnpm install --frozen-lockfile && pnpm build`, then `npm publish` in `packages/mivra`. The owner's account confirms with a passkey: npm prints a link to approve.
2. Build and push the image:
   ```sh
   docker build -t ghcr.io/okhay-p/mivra:<version> -t ghcr.io/okhay-p/mivra:latest \
     --build-arg MIVRA_PACKAGE=@okhay-p/mivra@<version> docker
   gh auth token | docker login ghcr.io -u okhay-p --password-stdin   # needs the write:packages scope
   docker push ghcr.io/okhay-p/mivra:<version> && docker push ghcr.io/okhay-p/mivra:latest
   ```

