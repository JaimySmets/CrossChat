# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please),
using [Semantic Versioning](https://semver.org) driven by
[Conventional Commits](https://www.conventionalcommits.org).

## How a release happens

1. Commit to `main` with Conventional Commit messages (`fix:`, `feat:`, `feat!:` ...).
2. On every push to `main`, release-please opens or updates a **release PR** titled
   `chore(main): release X.Y.Z`. It bumps the version in `package.json`, `package-lock.json` and
   `manifest.json`, and adds the new entries to `CHANGELOG.md`.
3. When you want to ship, **merge the release PR**. release-please then tags `vX.Y.Z` and
   creates the GitHub Release with the changelog as its notes.
4. The `publish` job in the same workflow builds that tag and:
   - attaches `crosschat-vX.Y.Z.zip` to the release. This zip keeps the manifest `key`, so a
     manual *Load unpacked* install gets the pinned extension id;
   - uploads `crosschat-vX.Y.Z-webstore.zip` (the same build without `key`, which the store
     rejects) to the Chrome Web Store and submits it for review, using
     [`mnao305/chrome-extension-upload`](https://github.com/mnao305/chrome-extension-upload).
     The zip is also attached to the release, so you can upload it by hand if needed.

Store review usually takes from a few hours to a few days. Track it in the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Version bumps

| Commits since the last release           | Bump                                  |
| ---------------------------------------- | ------------------------------------- |
| only `fix:` / `perf:`                    | patch                                 |
| any `feat:`                              | minor                                 |
| breaking (`feat!:`, `BREAKING CHANGE:`)  | major (minor while the version is 0.x) |

`docs:`, `chore:`, `ci:`, `refactor:` and similar commits do not start a release on their own.
To force a specific version, add a `Release-As: X.Y.Z` footer to a commit.

`CHANGELOG.md` and the version fields are owned by release-please. Do not edit them by hand.

## One-time GitHub setup

- *Settings → Actions → General → Workflow permissions*: enable **Allow GitHub Actions to create
  and approve pull requests**, so release-please can open its PR.
- PRs that release-please opens with the default `GITHUB_TOKEN` do not trigger other workflows,
  so `ci.yml` does not run on the release PR. The release PR only changes version numbers and
  the changelog, and the `publish` job builds the tag anyway.

## One-time Chrome Web Store setup

The publish step uses [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
with an OAuth refresh token. It is skipped until `CWS_REFRESH_TOKEN` is set.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project and enable
   the **Chrome Web Store API**.
2. Configure the **OAuth consent screen** (External), then set its publishing status to
   **In production**. A consent screen left in *Testing* issues refresh tokens that expire after
   7 days.
3. Create an **OAuth client ID** of type *Web application* and add
   `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. In the [OAuth Playground](https://developers.google.com/oauthplayground), open the settings,
   tick *Use your own OAuth credentials*, enter the client ID and secret, authorize the scope
   `https://www.googleapis.com/auth/chromewebstore` with the account that owns the item, and
   exchange the code for tokens.
5. In *Settings → Secrets and variables → Actions*, add:

   | Name                | Kind     | Value                                                     |
   | ------------------- | -------- | --------------------------------------------------------- |
   | `CWS_CLIENT_ID`     | secret   | OAuth client ID                                           |
   | `CWS_CLIENT_SECRET` | secret   | OAuth client secret                                       |
   | `CWS_REFRESH_TOKEN` | secret   | Refresh token from the playground                         |
   | `CWS_PUBLISHER_ID`  | variable | Developer Dashboard → *Publisher → Settings*              |
   | `CWS_EXTENSION_ID`  | variable | The store item id (32 letters, from the item's dashboard URL) |

The API can only publish with the visibility that was last published. If you change visibility
in the dashboard, publish once by hand before relying on CI again.
