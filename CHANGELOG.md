# Changelog

## Unreleased

- Added `PRIVACY.md`, stating what leaves the browser, what is kept in extension
  storage, and why each permission is requested. Required for a Chrome Web Store
  listing, and the port probing added in v0.1.5 is the kind of behavior a policy
  has to name.
- Added tests that pin the policy to the code: the probed ports, the cache cap,
  the default endpoint and every declared permission must match, and a new
  external host anywhere in the shipped code fails the suite.

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

