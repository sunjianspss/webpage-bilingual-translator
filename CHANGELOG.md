# Changelog

## Unreleased

- Added a backend probe before each translation: an unreachable local service, a
  service that needs an API token, and a model name that is not loaded now fail
  in the first second with the reason, instead of after every batch fails.
- Failure notices now carry the first real error instead of only a count, so a
  stopped local service reads differently from a malformed model response.

## v0.1.3 - 2026-06-17

Initial open source release.

- Added Chrome / Edge Manifest V3 bilingual webpage translation.
- Added Safari Web Extension project with native local-API proxy.
- Added local OpenAI-compatible API and DeepSeek API backends.
- Added bilingual, translated-only, and restore-original display modes.
- Added X.com dynamic-page rescans and structured post layout preservation.
- Added compact local-model prompts, dynamic token budgeting, batching, and retry behavior.
- Added tests and basic release documentation.

