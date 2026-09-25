# Brand Assets (Trademarks)

This directory contains Wealthfolio brand assets (names, logos, wordmarks,
icons).

These assets are **not** licensed under the project's software license
(AGPL-3.0). No trademark rights are granted to use these assets except as
permitted by [TRADEMARKS.md](../../TRADEMARKS.md).

## For Forks and Modified Distributions

Forks and modified distributions must:

- Remove or replace these brand assets
- Use a different name (not "Wealthfolio" or confusingly similar)
- Not use "Wealthfolio" branding in a way that implies the fork is the official
  project

You may say: "Forked from Wealthfolio (https://wealthfolio.app/)" or "Based on
Wealthfolio", prominently, with a disclaimer.

## Android launcher icons

The current Android sources are:

- `android-foreground.png`: transparent 1380 × 1380 gold logo, exported at 2×
  from Figma with upper-right lighting. PNG preserves the Glass effect.
- `android-background.png`: opaque 2048 × 2048 gradient, without corner masks or
  edge shadows.
- `android-monochrome-source.svg`: original vector artwork used for the themed
  icon silhouette; use only its logo paths, excluding background and effects.

The app uses resources in `apps/tauri/gen/android/app/src/main/res/`.
`apps/tauri/icons/android/` is an older generated copy, not a Gradle resource
directory; do not copy it over the app resources.

Adaptive foreground/background layers are 108, 162, 216, 324, and 432 pixels for
mdpi through xxxhdpi. Center the foreground at `690 / 1024 × 0.82 × 0.85` of the
canvas width, matching the monochrome layer and keeping the logo inside the 66dp
circular safe area. This leaves the logo at about 70% of the visible 72dp
launcher viewport width. Legacy icons are 48, 72, 96, 144, and 192 pixels, using
the logo at `690 / 1024` of the canvas width.

Generate Android assets in a temporary directory and copy only the Android
resources. Running the general Tauri icon generator in place can overwrite the
custom iOS and desktop icons.

## Contact

For trademark permission requests: hello@wealthfolio.app

See: [TRADEMARKS.md](../../TRADEMARKS.md)
