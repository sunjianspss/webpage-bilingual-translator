# Changelog

## Unreleased

## v0.1.6 - 2026-09-14

### Fixed

- Scrolling a page while it was being translated cancelled the translation. A
  tab reporting status `loading` was read as proof its document had gone away,
  but on a site that prefetches routes the tab flips in and out of loading as
  links enter the viewport, with no navigation and no URL in the event. The
  listener now acts only on a changed URL; a document that is genuinely leaving
  is reported by the content script's `pagehide`, which is what that event is
  for.
- Clicking an entry in a page's table of contents cancelled the translation for
  the same reason. Jobs are now bound to a document rather than a tab, so a URL
  that differs only by fragment leaves the job alone.
- Pressing the translate shortcut a second time while a page was still being
  translated cancelled the run in progress. The guard that should have refused
  the second press read a status field that resets at the end of every scan, so
  a press landing between scans went straight through.
- A translation was abandoned when the extension failed to deliver the start
  message. A broken message port says nothing about whether the page took the
  job, and destroying a job the page is using costs a whole translation, while
  leaving one behind costs a settings snapshot that tab teardown collects.
- A lost background job ended the page. Manifest V3 recycles the service worker,
  and `chrome.storage.session` is absent on Safari, so the record can vanish
  while the page is half done; the page now asks for a replacement job and
  finishes the remaining batches. A deliberate cancel is still final.
- Article titles and standfirsts were skipped on news sites and blogs. A
  `header` inside an `article` or `section` is sectioning content, not site
  furniture, and was being excluded along with real page headers.
- Restoring the original text left an empty `style` attribute on every element
  that had been translated, because removing a custom property does not remove
  the attribute it lives in. A site's own `p:not([style])` rules stopped
  matching after a restore.
- A heading whose font size could not be read produced `NaNpx`, which made the
  translated heading fall back to an inherited size.

### Added

- The per-page translation cap is now editable in the popup, between 1 and 5000.
  It had been a constant that could not be seen or changed.
- The status bar and the popup now say how much a page's translation left out
  when that cap binds. A long page stopping halfway used to read exactly like a
  short page finishing.
- Cancellations now name their origin — a navigation, a closed tab, the popup,
  the page itself — instead of sharing one sentence between six code paths, and
  each abort is recorded in the service worker console.
- Added `PRIVACY.md`, stating what leaves the browser, what is kept in extension
  storage, and why each permission is requested. Required for a Chrome Web Store
  listing, and the port probing added in v0.1.5 is the kind of behavior a policy
  has to name.
- Added tests that pin the policy to the code: the probed ports, the cache cap,
  the default endpoint and every declared permission must match, and a new
  external host anywhere in the shipped code fails the suite.

### Changed

- The element font-size variable moved onto the translation node, where it is
  the only thing that reads it, so translating no longer writes to the page's
  own elements.


## v0.1.5 - 2026-08-19

### Added

- Added local backend detection to the popup. A Chrome extension cannot look for
  where LM Studio is installed the way a desktop app can, so this asks a short
  fixed list of known ports (LM Studio, Ollama, llama.cpp, vLLM, Jan) whether an
  OpenAI-compatible service answers there, and fills in the API URL from the
  first one that does.
- The model field now offers the detected models as a dropdown. Typing the model
  name by hand was the most error-prone step in setup, and a name that does not
  match a loaded model fails the whole page. Embedding and reranker models are
  kept out of the list, since picking one makes every translation fail for
  reasons that are hard to trace.
- Detection tells a service that is running with no model loaded apart from a
  service that is not running, because the fix differs.
- Added a downloadable extension package to each release, so installing no
  longer means cloning the repository and loading its root as an unpacked
  extension.
- Added persistent translation caching keyed by page and target language, so a
  reload no longer retranslates. The cache holds about 3000 entries and evicts
  the oldest ones past that.
- Added a "clear cache and retranslate" action scoped to the current page, for
  switching models or rejecting a translation without touching other pages.
- Added target-language detection by CJK character ratio, so text already in the
  target language is skipped instead of sent to the model.
- Added a backend probe before each translation: an unreachable local service, a
  service that needs an API token, and a model name that is not loaded now fail
  in the first second with the reason, instead of after every batch fails.
- Added background translation jobs that survive service-worker restarts, with
  per-job cancellation, tab binding, and disposal on tab close, reload, and
  replacement.
- Added incremental rescans through a mutation observer, so lazily revealed
  content on dynamic pages such as X.com is picked up.
- Added toolbar icons to the Chrome manifest. Without them the toolbar fell back
  to the generic puzzle piece and a store listing would have been rejected.

### Changed

- Raised local batch concurrency from 2 to 4, measured at 1.20x on a real local
  model, and removed quadratic behavior from candidate collection.
- Kept the small warmup batch on every scan rather than only the first. Skipping
  it pushed the first translated line from 2.9s to 6.8s with no gain in total
  time.
- Failure notices now carry the first real error instead of only a count, so a
  stopped local service reads differently from a malformed model response.
- The keyboard-shortcut path now reports errors in the page status bar. It
  previously wrote them only to the service-worker console, so a failure looked
  like nothing happening.

### Fixed

- Fixed permanently dropped text in single-segment batches. The model often
  answers a one-item batch with a bare object or an id-to-text map, neither of
  which parsed, and a one-segment batch cannot be split and retried.
- Fixed translations lost to service-worker recycling. Manifest V3 recycles the
  worker after 30s idle while the request timeout is 45s; in-flight requests now
  keep it alive.
- Fixed duplicate translation blocks appearing under the same paragraph when a
  translation already existed deeper in the subtree.
- Fixed the top of long documents going untranslated once the segment budget
  bound. Candidates are now ordered by document position before truncation, and
  the collection cap no longer breaks out before headings are gathered.

### Internal

- Split the content script into modules under `src/content/`, built into a
  single injectable file by `npm run build-content`.
- Added `npm run package`, which builds a store-ready zip and refuses to write
  one when the two version numbers disagree, the generated content script is
  stale, or a listed file is missing.
- Added a release workflow: a `v*` tag runs the checks and creates a draft
  GitHub release with the package attached.

## v0.1.3 - 2026-06-17

Initial open source release.

- Added Chrome / Edge Manifest V3 bilingual webpage translation.
- Added Safari Web Extension project with native local-API proxy.
- Added local OpenAI-compatible API and DeepSeek API backends.
- Added bilingual, translated-only, and restore-original display modes.
- Added X.com dynamic-page rescans and structured post layout preservation.
- Added compact local-model prompts, dynamic token budgeting, batching, and retry behavior.
- Added tests and basic release documentation.

