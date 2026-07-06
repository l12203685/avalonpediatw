# Asset Credits

## Source artwork (NOT redistributed)

The Avalon game uses 27 visual assets representing roles, board layouts,
voting tokens, the Lake of the Lady token, and team indicators. The
original artwork is from:

> **The Resistance: Avalon**
> Designed by Don Eskridge
> Published by Indie Boards & Cards
> https://www.indieboardsandcards.com/index.php/games/avalon/

These 27 image files are **copyrighted by Indie Boards & Cards** and are
**NOT redistributed in this repository**. See `LICENSE` and
`LICENSE-ASSETS` for details on what *is* covered by this repo's
licenses.

## Filename map (placeholders shipped instead of artwork)

`packages/web/public/avalon-assets/` contains 27 placeholder files using
the exact filenames the frontend expects, so the app builds and runs out
of the box. Each placeholder is a labeled color block. Sibling `.svg`
versions provide a higher-quality vector fallback.

| Filename            | Original meaning                          |
|---------------------|-------------------------------------------|
| `board-5.jpg`       | 5-player mission board                    |
| `board-6.jpg`       | 6-player mission board                    |
| `board-7.jpg`       | 7-player mission board                    |
| `board-8.jpg`       | 8-player mission board                    |
| `board-9.jpg`       | 9-player mission board                    |
| `board-10.jpg`      | 10-player mission board                   |
| `cup-evil.jpg`      | Evil team cup token                       |
| `cup-good.jpg`      | Good team cup token                       |
| `lake.jpg`          | Lake of the Lady token                    |
| `quest-fail.png`    | Mission failed marker                     |
| `quest-success.png` | Mission succeeded marker                  |
| `role-assassin.jpg` | Assassin role card                        |
| `role-loyal-1.jpg`  | Loyal Servant of Arthur (variant 1)       |
| `role-loyal-2.jpg`  | Loyal Servant of Arthur (variant 2)       |
| `role-loyal-3.jpg`  | Loyal Servant of Arthur (variant 3)       |
| `role-loyal-4.jpg`  | Loyal Servant of Arthur (variant 4)       |
| `role-merlin.jpg`   | Merlin role card                          |
| `role-mordred.jpg`  | Mordred role card                         |
| `role-morgana.jpg`  | Morgana role card                         |
| `role-oberon.jpg`   | Oberon role card                          |
| `role-percival.jpg` | Percival role card                        |
| `team-evil.jpg`     | Minions of Mordred banner                 |
| `team-good.jpg`     | Loyal Servants banner                     |
| `unknown.jpg`       | Unknown / hidden role placeholder         |
| `vote-no.jpg`       | "Reject" vote token                       |
| `vote-token.png`    | Generic vote token back                   |
| `vote-yes.jpg`      | "Approve" vote token                      |

## Using the real artwork locally

If you legally own a physical copy of *The Resistance: Avalon* and want
to use scans of your own copy for **personal, non-commercial play**,
drop the files into `packages/web/public/avalon-assets/` using the same
filenames as the table above. The placeholders will be overwritten in
your local checkout.

Patterns that exclude common "real artwork" filenames are listed in
`.gitignore` to prevent accidental commits — please do not bypass that
guard.

## Future plan

The maintainers plan to commission **original AI-generated artwork**
licensed under CC BY-NC-SA 4.0 (per `LICENSE-ASSETS`) to replace the
placeholders. Help wanted! See `CONTRIBUTING.md`.

## Other assets in this repo

- `packages/web/public/logo.png`, `logo-bg.png`, `logo-75.jpg`,
  `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
  `icon-512-maskable.png` — Original project icons by AvalonPediaTW
  contributors, licensed under CC BY-NC-SA 4.0.
- All `.svg` placeholder files in `packages/web/public/avalon-assets/`
  — Original SVG art by AvalonPediaTW contributors, CC BY-NC-SA 4.0.
