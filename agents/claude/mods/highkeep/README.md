# highkeep

A dark look for Claude Code in the desktop and mobile apps: a castle on a mountain crag at dusk, drawn as an animated SVG behind the conversation. It follows the calendar, and it shows plan usage in the scene instead of as text.

## The scene

| Season | Dates | What changes |
| --- | --- | --- |
| Spring | Mar to May | Green and violet trees, drifting petals |
| Summer | Jun to Aug | Deep green, slow fireflies |
| Autumn | Sep 1 to Nov 14 | Rust and gold trees, falling leaves |
| First snow | Nov 15 to Dec 20 | Autumn trees, light snowfall, snow settling on the ground over 15 minutes |
| Winter | Dec 21 to Feb | Bare trees, heavier snow, deep cover |

All motion is slow (6 to 180 second cycles) with no flashing. With reduced motion on, every part rests in place.

## Plan usage

The mod reads the `seven_day` and `five_hour` rate-limit windows from `$.session.usage()` at session start and from `session.measure` events. It keeps the last reading in `$.store`, so the scene draws right away in the next session.

- **Seven-day window:** the moon wanes as you spend it. Full at 0%, dark at 100%.
- **Five-hour window:** a candle in the keep's great window burns down. The window stays dark when your plan has no five-hour limit.
- **Tint:** amber when you've used more of a window than its time has passed (with a one-point grace), red past 90%.

The backdrop redraws only when a window moves a whole point or changes tint.

## Review row

With the review-monitor (Harper's cross-model review pane) plugin loaded, a row above the prompt shows a running cross-model review: one word for the phase, a lantern mark, a bar per reviewer, and the time left. review-monitor is optional. Without it, or with no review running, there is no row.

## Where it draws

The palette and scene draw in the desktop and mobile apps. The terminal and editors keep their own look. The review row draws on every surface (text bars in the terminal).

## Develop

```bash
claude plugin validate .
claude plugin test .
```

To run it from this folder:

```bash
claude --plugin-dir agents/claude/mods/highkeep
```
