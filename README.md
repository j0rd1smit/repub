# rePub

[![build](https://github.com/j0rd1smit/repub/actions/workflows/build.yml/badge.svg)](https://github.com/j0rd1smit/repub/actions/workflows/build.yml)
[![firefox](https://img.shields.io/badge/firefox-extension-orange)](#install)
[![license](https://img.shields.io/github/license/j0rd1smit/repub)](LICENSE)

A reMarkable ePub generator for Firefox. Click the toolbar button on any article
and rePub turns it into an ePub, with its images, and sends it to your
reMarkable or saves it as a file. It's essentially an open source version of
Read on reMarkable, but it keeps images, and its options page offers margins,
text scale, line height, alignment, fonts, tags, and a cover page.

This is a Firefox port of [hafacc/repub](https://github.com/hafacc/repub), which
is a Chrome extension.

## Features

- **Pages to ePub**: the toolbar button captures the current page, keeps the
  article, and builds an ePub with its images, including lazily loaded,
  `srcset`, `<picture>`, and cross-origin ones.
- **PDFs**: clicking the button on a PDF open in Firefox's viewer sends the PDF
  itself, optionally zoomed past its white margins.
- **Uploads**: the options page uploads ePub, PDF, Markdown, and MHTML files.
- **Title prompt**: optionally asks for a title and author before capturing.

## Install

Firefox 140 or newer is required.

- **From a release**: download `repub.zip` from the
  [releases](https://github.com/j0rd1smit/repub/releases). Unsigned add-ons only
  install permanently in Firefox Developer Edition or Nightly with
  `xpinstall.signatures.required` set to `false` in `about:config`. In regular
  Firefox, load it temporarily as described below.
- **Temporarily, for development**: run `bun export`, open
  `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…", and
  pick `manifest.json` in the repository root. Firefox removes it when it
  restarts.

To use upload mode, open the extension's options (`about:addons` → rePub →
Preferences) and link it to your reMarkable account with a one-time code.

## Permissions

- **Access your data for all websites**: needed to snapshot the page you
  click on and to fetch its images, including ones from other domains.
- **Downloads**: to save ePubs and PDFs when "Download as file" is selected.
- **Notifications**: to tell you when a conversion fails.
- **Storage**: for your options and the reMarkable session.

Pages are only read when you click the button, and they're only sent to
reMarkable's servers, in upload mode.

## How it works

Chrome's version relies on `pageCapture`, offscreen documents, and
`printerProvider`, none of which Firefox has. Instead:

1. A script injected into the tab clones the DOM, makes every image URL
   absolute, swaps in the source the browser actually displayed, and fetches
   each image from inside the page (so cookies and caches apply).
2. Images the page couldn't fetch, usually cross-origin ones without CORS
   headers, are fetched again by the extension, which has host permissions.
3. The page and images are packed as MHTML and go through the same rendering as
   before ([Defuddle](https://github.com/kepano/defuddle) to find the article,
   then ePub generation), which Firefox's background page can run directly
   because it has a DOM.
4. A PDF tab is fetched and sent as a PDF, replacing the printer that Chrome's
   version offered.

## Development

```sh
bun install
bun lint            # typecheck and biome
bun test            # unit tests
bun export          # icons (needs rsvg-convert), bundles, and repub.zip
bun lint:ext        # unpack repub.zip into dist/ and lint it with web-ext
bun e2e             # drive dist/ in a headless firefox (needs selenium and pillow)
```

`bun e2e` serves a test site with every kind of image reference rePub handles,
then checks the ePubs and PDFs the extension downloads. It looks for `firefox`
and `geckodriver` on the path, or in the `FIREFOX` and `GECKODRIVER` environment
variables.

`bun cli <file.mhtml>` runs the conversion on a saved MHTML file outside of the
browser, with extra logging.

### Publishing to addons.mozilla.org

The bundles are minified, so AMO asks for the source code with each version.
Upload the repository as the source and point reviewers at `bun install` and
`bun export`. Signing can also be done from the command line with
`bunx web-ext sign --source-dir dist --channel unlisted` and AMO API keys.
