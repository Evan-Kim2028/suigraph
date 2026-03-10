# Walrus Sites Deployment

suigraph is deployed as a Walrus Site on Sui mainnet. The site is a single `index.html`
file with all CSS and JS inlined.

## Prerequisites

- **`site-builder`** CLI installed at `~/.local/bin/site-builder`
- **`walrus`** CLI installed at `~/.local/bin/walrus`
- Walrus config at `~/.config/walrus/client_config.yaml` with `default_context: mainnet`
- Sui wallet configured with sufficient SUI for gas + WAL for storage

## Site Object

| Field | Value |
|-------|-------|
| Object ID | `0xa1248f83831fd952680649e461899a59647f6f1fefc6397a77d387dc01a7d732` |
| Site Name | `suigraph block explorer` |
| Single-page app | Yes (`/*` → `/index.html`) |

## Build

From the `site/` directory:

```bash
cd site
npm run build
```

This runs `node scripts/build-single-file.mjs` which:
1. Reads `src/index.template.html`
2. Minifies and inlines `src/styles.css` at the `{{INLINE_CSS}}` placeholder
3. Concatenates `src/app/*.js`, minifies the result, and inlines it at the `{{INLINE_JS}}` placeholder
4. Writes the result to both `index.html` and `dist/index.html`
5. Outputs a sha256 hash for verification

## Deploy / Update

```bash
cd site
site-builder --context=mainnet deploy ./dist --epochs 10 --ws-resources ./ws-resources.json
```

Using `--ws-resources` ensures the canonical site object (`object_id` in
`site/ws-resources.json`) is updated in place.

### What `update` does

1. Parses `dist/` directory and `site/ws-resources.json`
2. Uploads changed files as Walrus quilts (blob storage)
3. Updates the on-chain site object with new resource references
4. Deletes old quilt patches that are no longer needed
5. Updates `site/ws-resources.json` with any `object_id`/resource revisions

## Site Configuration

The `ws-resources.json` file controls routing, headers, and metadata:

```json
{
  "headers": {
    "/index.html": {
      "Cache-Control": "no-cache, must-revalidate",
      "Content-Type": "text/html; charset=utf-8"
    }
  },
  "routes": {
    "/*": "/index.html"
  },
  "metadata": {
    "description": "a graphql based block explorer",
    "project_url": "https://github.com/Evan-Kim2028/suigraph",
    "creator": "Sui Community"
  },
  "site_name": "suigraph block explorer",
  "object_id": "0xa1248f83831fd952680649e461899a59647f6f1fefc6397a77d387dc01a7d732"
}
```

Key settings:
- **`routes`**: `/*` → `/index.html` makes it a single-page app (all paths serve index.html)
- **`headers`**: `no-cache` ensures users always get the latest version
- **`object_id`**: Auto-updated by `site-builder update`

## Browsing the Site

After deployment, the site is accessible via:

1. **Local portal**: Run a mainnet portal locally and browse at
   `http://<base36-object-id>.localhost:3000`
2. **Third-party portal**: Point a SuiNS name to the site object ID, then browse at
   `https://<suins-name>.wal.app`

Convert object ID to Base36 for local portal URLs:
```bash
site-builder convert 0xab8338106e896d9145353a27d773a3dfa5086492c9c262dec274b023c602f4b4
```

## Local Development

For local testing before deploying:

```bash
cd site
npm run build
cd dist
python3 -m http.server 8080
# Open http://localhost:8080/index.html
```

## Quick Reference

```bash
# Full deploy workflow
cd site
npm run build                    # Build single-file site
site-builder --context=mainnet deploy ./dist --epochs 10 --ws-resources ./ws-resources.json

# Verify
git add -A && git status         # Check what changed
git commit -m "Deploy site"      # Commit
git push origin main             # Push
```
