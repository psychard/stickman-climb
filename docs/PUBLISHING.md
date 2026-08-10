# Publishing a project at `<name>.psychard.com`

How to get a static site in the `psychard` GitHub org onto its own subdomain,
with HTTPS, deployed on every push to `main`.

`stickman-climb` is the working reference — it serves at
<https://climb.psychard.com/>. Copy what it does.

**You do not need to touch DNS.** That is the whole point of the setup below.

## What is already set up, once, for the entire org

| Where | Record | Value |
|---|---|---|
| GoDaddy DNS | `CNAME` `*` | `psychard.github.io` |
| GoDaddy DNS | `TXT` `_github-pages-challenge-psychard` | verification token |
| GitHub org | Verified domain | `psychard.com` — shows `verified` |

The wildcard means **any** `<name>.psychard.com` already resolves to GitHub
Pages, including ones nobody has claimed yet. The TXT record verifies the domain
against the org, which is what stops anyone outside `psychard` from pointing
their own repo at one of our subdomains. Both are permanent; leave them alone.

So per project there is exactly one DNS action: **none**.

> Do not add a per-project DNS record. An explicit record overrides the wildcard
> for that name, so a wrong one silently breaks a subdomain that would otherwise
> have worked. The only reason to add one is to point a subdomain at something
> that is *not* GitHub Pages.

## Constraints, before you start

- **The repo must be public.** `psychard` is a free org, and GitHub Pages on
  private repos needs Pro/Team/Enterprise. A private repo simply has no Pages
  tab.
- **One subdomain, one repo.** Claims are exclusive across all of GitHub. If
  another repo already holds the name, GitHub rejects yours — pick another.
- **Already taken:** `climb` (stickman-climb), `www` (psychard.github.com, the
  legacy 2015 site).
- You need **admin** on the repo to change Pages settings, and push access to
  the org.

## The one thing that actually goes wrong

**Your build must emit root-relative asset URLs.** The site is served at the
root of its own subdomain, so there is no `/<repo>/` path prefix — and most
static-site tooling defaults to adding one for GitHub Pages, because it assumes
the bare `psychard.github.io/<repo>/` URL.

Check your built `index.html`. You want this:

```html
<script src="/assets/index-abc123.js"></script>
```

Not this:

```html
<script src="/my-repo/assets/index-abc123.js"></script>
```

The second one deploys fine, loads a blank page, and 404s every asset. It is by
far the most common failure.

| Tool | Setting |
|---|---|
| Vite | omit `base` entirely (default `/`) |
| Next.js (static export) | `output: 'export'`, no `basePath` |
| Create React App | drop `homepage` from `package.json`, or set it to `/` |
| Astro / SvelteKit | omit `base` / `paths.base` |
| Plain static | nothing to do |

There is no Jekyll step in this pipeline — `upload-pages-artifact` serves the
directory as-is — so a `.nojekyll` file is unnecessary. Directories starting
with `_` (like Next's `_next`) are served fine.

## Steps

### 1. Push the repo

```bash
gh repo create psychard/my-project --public --source=. --remote=origin --push
```

### 2. Add the workflow

`.github/workflows/pages.yml`, verbatim. Replace the test step with whatever
your project uses, or delete it.

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test          # or delete this line
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist           # build output dir: dist, build, out, _site…

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Put a real check in that `npm test` slot if the project has one. It gates the
deploy, which is the cheapest way to stop a broken build reaching the domain.

### 3. Turn on Pages, with the Actions source

In the repo: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. Not "Deploy from a branch" — with Actions as the source there is no
`gh-pages` branch, nothing to commit, and the build output stays gitignored.

Equivalently, from the CLI:

```bash
gh api -X POST repos/psychard/my-project/pages -f build_type=workflow
```

This is the one command here that wasn't exercised on `stickman-climb` — Pages
was switched on through the web UI there. If it errors, use the UI; everything
after this point is unaffected.

### 4. Claim the subdomain

```bash
gh api -X PUT repos/psychard/my-project/pages -f cname='hopping.psychard.com'
```

Or **Settings → Pages → Custom domain**. Do not add a `CNAME` file to the repo
— with the Actions build type the domain lives in the Pages settings and the
artifact needs nothing.

**Do not skip this step.** The org's legacy user site claims `www.psychard.com`,
which makes GitHub redirect any project site *without* its own custom domain to
`www.psychard.com/<repo>/`. Skipping the custom domain doesn't leave you on a
plain github.io URL — it sends your project somewhere surprising.

### 5. Enable HTTPS

GitHub requests a Let's Encrypt certificate automatically once the domain is
set. It usually lands within a minute or two. Watch for it:

```bash
gh api repos/psychard/my-project/pages --jq '.https_certificate.state'
```

`null` → `authorized` → `approved`. When it reads `approved`:

```bash
gh api -X PUT repos/psychard/my-project/pages -F https_enforced=true
```

Or tick **Enforce HTTPS**, which is greyed out until the certificate exists.

## Verify

```bash
gh run list --repo psychard/my-project --limit 3
dig +short hopping.psychard.com
curl -sI https://hopping.psychard.com/ | head -1
curl -s https://hopping.psychard.com/ | grep -o 'src="[^"]*"'
```

Want: `psychard.github.io.` followed by the four `185.199.108–111.153`
addresses, `HTTP/2 200`, and asset paths with **no** repo-name prefix.

## Troubleshooting

**Blank page, assets 404, paths contain `/my-project/`** — your build set a base
path. See the section above. This is nearly always the problem.

**Certificate stuck at `null` for more than ~15 minutes** — GitHub hasn't
requested it. Force a re-check by clearing and re-setting the domain:

```bash
echo '{"cname":null}' | gh api -X PUT repos/psychard/my-project/pages --input -
sleep 20
gh api -X PUT repos/psychard/my-project/pages -f cname='hopping.psychard.com'
```

That took `climb.psychard.com` from `null` to `approved` in about 60 seconds
after 15 minutes of nothing.

**`http://` still serves 200 instead of redirecting, with HTTPS enforced** —
Varnish cache, `max-age=600`. Wait ten minutes. Check `curl -sI` for an `Age:`
header near 600 to confirm that's all it is.

**DNS "doesn't resolve" but the record looks right** — your local resolver is
caching. Ask the authoritative server directly:

```bash
dig @ns37.domaincontrol.com +noall +answer hopping.psychard.com
```

**Site unreachable and DNS points at `psychard.github.com`** — that is the
pre-2013 Pages hostname and it no longer resolves. Nothing should reference it.
The correct target is `psychard.github.io`.

**Serving from a bare `psychard.github.io/<repo>/` URL instead** — then you *do*
need a base path, and you need it for the preview command too, not just the
build. `vite preview` reports `command === 'serve'` exactly like the dev server,
so a build-only check passes while preview 404s every asset. Better to just use
a subdomain.

## Copy-paste, whole thing

```bash
REPO=my-project
SUB=hopping

gh repo create psychard/$REPO --public --source=. --remote=origin --push
gh api -X POST repos/psychard/$REPO/pages -f build_type=workflow
gh api -X PUT  repos/psychard/$REPO/pages -f cname="$SUB.psychard.com"

# `gh run watch` prompts for a run when given no id, which hangs a script — so
# look the latest one up explicitly.
RUN=$(gh run list --repo psychard/$REPO --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch --repo psychard/$REPO --exit-status "$RUN"

until [ "$(gh api repos/psychard/$REPO/pages --jq '.https_certificate.state')" = approved ]; do
  sleep 20
done
gh api -X PUT repos/psychard/$REPO/pages -F https_enforced=true

curl -sI "https://$SUB.psychard.com/" | head -1
```

Assumes the workflow file is committed and the build emits root-relative paths.
