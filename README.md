# token-graph

A Claude Code mod that graphs your token use across **every** Claude Code session on your computer — desktop, terminal and subagents, including sessions running at the same time — in a pane beside the chat.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install token-graph --marketplace 1celo12/token-graph
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```
claude plugin install token-graph --marketplace 1celo12/token-graph
```

Needs [Node.js](https://nodejs.org) 18 or newer on your PATH.

## Use

The **Tokens** pane opens by itself when a session starts; `/tokens` opens it again.

- **Periods:** Live (last 60 minutes, per minute, updated every 5 seconds), 24h, 7d, 30d, and All (running total).
- **Measures:** Total (stacked by type), In, Out, Cache read, Cache write, and Cache hit %.
- **Header:** today's total, tokens per minute now, and how many sessions are active.
- **Cache stats:** hit rate, tokens read, written and uncached, and how many times each written token was read back, for the period shown.
- **Pause updates** stops the live refresh.

The page and measure you pick are remembered across sessions.

## Accessibility

- Every chart colour is at least 4.5:1 against its background, in both light and dark themes.
- The parts of a stacked bar differ by stripes and gaps, not by colour alone.
- The busiest and latest values and each part's share are written out under the chart and in its screen-reader description, so nothing needs hovering.
- The selected period and measure are stated in words, and live updates can be paused.

## How it works

Claude Code writes each session's transcript to `~/.claude/projects/**/*.jsonl`, and every reply there carries its token usage. `scripts/scan.mjs` reads only the bytes added since its last run, counts each API response once (a response written to several rows or copied into a resumed session is not counted twice), and keeps per-minute, per-hour and per-day totals in `~/.claude/token-graph/state.json`. A lock file stops several sessions from scanning at once.

The first scan reads all your transcripts and may take a few seconds; later scans take well under a second. Nothing leaves your computer.

## License

MIT
