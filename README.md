# pi-stacked-tools

A [Pi](https://github.com/earendil-works/pi) extension that draws a run of consecutive tool calls as one line.

Pi gives every tool call its own card. A model that works step by step sends one call per message, so ten calls are ten cards and the text around them scrolls away. With this extension the transcript looks like this:

```
 Check the build and fix the failing test.

 Running 3 bash commands, read 2 files · $ npm test (ctrl+o to expand)     ← while a call runs

 Ran 4 bash commands, read 2 files, 1 failed (ctrl+o to expand)            ← when the run is done

 The test fails because the fixture path is relative. Fixing it.

 edit src/fixtures.ts … (ctrl+o to expand)
```

Only drawing changes. The tools, their results and what the model receives are untouched.

## Install

```bash
pi install git:github.com/Mai961/pi-stacked-tools
```

To try it for one run without installing: `pi -e git:github.com/Mai961/pi-stacked-tools`.

Tested with Pi 1.6.0.

## What it does

- **One line per run.** A stack is a run of tool calls with nothing else drawn between them. It starts after a user message or assistant text and ends at the next one, and it can span many assistant messages.
- **Running call.** While a call runs, the line is in the present tense and names the call. Failed calls are counted at the end.
- **Single calls.** A call alone in its stack shows its own first line, such as `$ npm test`.
- **Expand.** The expand key (Ctrl+O by default) shows every call and its output in full, and collapses back to the stack. The hint follows your keybinding and is left out in narrow terminals.
- **History.** Resumed sessions, `/reload`, compaction and `/tree` moves are stacked the same way as live runs.

## What else changes

- **Hidden thinking draws nothing.** With `hideThinkingBlock` on, Pi draws a "Thinking..." label before each call, which would split every stack, so the extension blanks that label. With thinking shown, a thinking block ends the stack like assistant text does.
- **Some cards are left alone.** Tools whose name starts with `subagent` keep their full card, and so do tools that do not define both a call and a result renderer. A call to one of them ends the stack.
- **HTML export is not stacked.** In `/export` and `/share` output every call keeps its own line.

## How it works

Pi's `registerToolRenderer` lets an extension draw a tool row, but a renderer only sees its own row. The extension works out the stacks itself and lets rows share them:

1. It reads the message events, which fire before Pi adds a message's rows, and the session entries on resume, and assigns every tool call to a stack (`stacks.ts`).
2. Each row draws itself without Pi's frame. The first collapsed row of a stack draws the line for all of them, and the other rows draw nothing, which in Pi takes no space.
3. What a row draws is worked out on every render, so the line follows calls as they arrive, finish or expand.

## Develop

```bash
npm test    # node --test test.ts, needs Node 22.18 or later for TypeScript stripping
```

The tests cover the stacking rules and the summary wording. The drawing in `index.ts` is checked by running Pi.

## License

MIT
