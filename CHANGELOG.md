# Changelog

## [0.4.0](https://github.com/mihaellenic/opencode-tokscope/compare/v0.3.0...v0.4.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* require patched seroval runtime chain (OpenTUI 0.8.x, Solid 1.9.17)

### Features

* show today's metrics in the sidebar ([a760ad0](https://github.com/mihaellenic/opencode-tokscope/commit/a760ad0a3ba49e93cf1e63685e4a1f41d3ef7e05))
* show today's metrics in the sidebar ([3c20800](https://github.com/mihaellenic/opencode-tokscope/commit/3c20800adc35e7f553d244de2b27eb915f9e768b))


### Bug Fixes

* require patched seroval runtime chain (OpenTUI 0.8.x, Solid 1.9.17) ([164d1a7](https://github.com/mihaellenic/opencode-tokscope/commit/164d1a70b02c502b823e9e5a36cc8169c6874ad7))

## [0.3.0](https://github.com/mihaellenic/opencode-tokscope/compare/v0.2.0...v0.3.0) (2026-10-26)


### Features

* **history:** add refresh diagnostics, bounded retries, and 30-minute inventory ([df1568d](https://github.com/mihaellenic/opencode-tokscope/commit/df1568da32491122f5bbfee27befd3c47b908d68))
* log history refresh durations to a private log file ([75d30b7](https://github.com/mihaellenic/opencode-tokscope/commit/75d30b7b8c7515f6bc180ea6085e9d75135603cc))
* quiet history refreshes with diagnostics and 30-minute inventory ([3a6d75e](https://github.com/mihaellenic/opencode-tokscope/commit/3a6d75e0a5d6495dfc8186039d52a97c742756cd))
* quiet page and sidebar refresh presentation ([fe90b6e](https://github.com/mihaellenic/opencode-tokscope/commit/fe90b6eb4f844565b4826dc5fcf374f29a1833b8))


### Bug Fixes

* allow five minutes for npm propagation in release verification ([e0f22de](https://github.com/mihaellenic/opencode-tokscope/commit/e0f22ded8d1849591248a4cd6d0017aba09574c6))
* allow five minutes for npm propagation in release verification ([9223411](https://github.com/mihaellenic/opencode-tokscope/commit/9223411a4871e13fb84c5087b9e07ed9572762b4))
* drop unbound trend hint and cover ready sidebar rows ([aa49c75](https://github.com/mihaellenic/opencode-tokscope/commit/aa49c75146f1bb90aac9995a8806ec8664cff600))
* **history:** cancel abandoned passes and settle retries before overlap ([19c465c](https://github.com/mihaellenic/opencode-tokscope/commit/19c465c27ef04df0276da657a496ebd2b7abc09f))

## [0.2.0](https://github.com/mihaellenic/opencode-tokscope/compare/v0.1.0...v0.2.0) (2026-10-26)


### Features

* bounded session listing primitive ([7457394](https://github.com/mihaellenic/opencode-tokscope/commit/7457394c6a414889d49d2e06e56ffca0e4379645))
* collector reuses per-session scan ([14f3e0e](https://github.com/mihaellenic/opencode-tokscope/commit/14f3e0e5f5ba09bb3ac4c8744e5a3b983dde6bae))
* full page served from shared history service ([9d628bc](https://github.com/mihaellenic/opencode-tokscope/commit/9d628bc46eeddee9b8ccd68fb582e6f3ab3e7c77))
* history service scheduling and reconciliation ([88107a1](https://github.com/mihaellenic/opencode-tokscope/commit/88107a1bde28958e8bcf4f2e954eba8fd4940d17))
* sharded durable history repository ([43abd42](https://github.com/mihaellenic/opencode-tokscope/commit/43abd4203d66e95c06120603284f6fd61d7d1ab9))
* shared incremental history service ([b7db06a](https://github.com/mihaellenic/opencode-tokscope/commit/b7db06aeb4eee9ce6de2536eb4ced9242a3d7499))
* shared persistent history cache for fast repeat opens ([2c6375c](https://github.com/mihaellenic/opencode-tokscope/commit/2c6375cc8c7bb56a757ba48524b9dde760f2a03c))
* sidebar widget served from shared history service ([75fba4d](https://github.com/mihaellenic/opencode-tokscope/commit/75fba4d4c55514b9427c74358e956c948b9055d0))
* versioned tokscope cache records ([cd4223c](https://github.com/mihaellenic/opencode-tokscope/commit/cd4223cc03813f713e9c5119bba57da54b28e046))


### Bug Fixes

* **ci:** isolate release PR validation ([529a759](https://github.com/mihaellenic/opencode-tokscope/commit/529a7598d7c589e264a3ef782f4030d3ddbb430e))
* **ci:** isolate release validation in pull request scope ([f84d8e9](https://github.com/mihaellenic/opencode-tokscope/commit/f84d8e9cb3270ebeba3c4764a7f7e9ec995126b2))
* **ci:** keep unverified head snapshot on malformed responses ([a327799](https://github.com/mihaellenic/opencode-tokscope/commit/a3277998ad89cf8e7153c5d4e8a80e273105a1d6))
* **ci:** use native Node 24 artifact uploads ([56b2c27](https://github.com/mihaellenic/opencode-tokscope/commit/56b2c279281aab6ed43b7eeb35ec557cdd2d697a))
* **ci:** use native Node 24 artifact uploads ([488bf9b](https://github.com/mihaellenic/opencode-tokscope/commit/488bf9be04d7981d5bbf126f25d83ca25b07007b)), closes [#11](https://github.com/mihaellenic/opencode-tokscope/issues/11)
* coverage and snapshot index updates inside store mutation ([963dff8](https://github.com/mihaellenic/opencode-tokscope/commit/963dff8090da8e21a4aab313b737d2b7cfee4f11))
* help line advertises palette-only reset ([7f87d01](https://github.com/mihaellenic/opencode-tokscope/commit/7f87d01d0230d98444d816ac122ab534efd0dc16))
* hydrate measurement shards lazily on first view, not at construction ([b285aaa](https://github.com/mihaellenic/opencode-tokscope/commit/b285aaa5575dca95cc1a82e0d755ef5b4f0e0ea4))
* pagination aborts on a repeated cursor ([0ca5132](https://github.com/mihaellenic/opencode-tokscope/commit/0ca5132a8435bb78fb3739940c8bfe136a18bcba))
* preserve selected day across background publications ([e82b3c5](https://github.com/mihaellenic/opencode-tokscope/commit/e82b3c5eabbc4e267c8ad2cf627e88ebe752cc51))
* **release:** bind audit exception to current package version ([bf024a9](https://github.com/mihaellenic/opencode-tokscope/commit/bf024a95f2efaf776e6d94890d8a4ae85eec38fc))
* **release:** correlate dispatched validation run ([ad14da0](https://github.com/mihaellenic/opencode-tokscope/commit/ad14da0332d95f87b5d02a4ad1fd3510943619fb))
* **release:** link audit exception to tracking issue ([ac37868](https://github.com/mihaellenic/opencode-tokscope/commit/ac37868d35f44169ea28ae06276e267cef5cf2fc))
* **release:** preserve accepted artifact and block on audit findings ([98945e4](https://github.com/mihaellenic/opencode-tokscope/commit/98945e4f6515d2d94af36a5f94831e60752aad12))
* **release:** reject mismatched registry version responses ([b93a4a1](https://github.com/mihaellenic/opencode-tokscope/commit/b93a4a115a9a8548f5092a629eb9754736108918))
* **release:** scope temporary seroval audit exception ([a64361d](https://github.com/mihaellenic/opencode-tokscope/commit/a64361d2fa6ef02b88edb279870bf50c34da290d))
* sidebar drives all-project acquisition before any view opens ([3d5d40e](https://github.com/mihaellenic/opencode-tokscope/commit/3d5d40e5075dafcdfc941e236679b3567636eb3e))
