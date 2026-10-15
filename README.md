# real-vibe-coding

[中文](README.zh-CN.md)

A Pi extension that makes everything appearing in the conversation emerge to the beat of music — one token at a time, or one whole line at a time.
RealVibeCoding uses a MIDI file as its rhythmic reference, plays the audio file of the same name, and reveals what Pi prints on a stage panel above the editor — the assistant's prose, its reasoning, every line of every tool call.

## In action

[Demonstration video](docs/demonstration.mp4)

```
♪ He's a Pirate · 200 BPM · 0:42/1:17 · sequential
▁▃▅▇█▇▅▃▁▂▄▆█▇▅▃▁▂▄▆█▇▅▃▁▂▄▆█▇▅▃▁▂▄▆█▇▅▃▁
 1 │ Weighed the two parsers, then ran the suite.Running it.
 2 │ $ npm test
 3 │ ℹ tests 85
 4 │ ℹ pass 85
 5 │ ℹ fail 0
 6 │ Imports look fine.import { readFileSync } from "node:fs";
 7 │
 8 │ export function main(path: string): string {
```

Prose, reasoning, logs and code all share one stage, so nothing is colored by content type — the only skeleton is the line numbers, and the drumbeat. Overlong lines wrap instead of being truncated and dropped.

The intensity bar is a row of equalizer bars pulsing in place. Its shape is decided by the music — the velocity of the most recent onset sets the wave height, pitch sets the density of the ripples (low notes wide, high notes fine), and duration sets how long the surge lasts after a hit (long notes linger, short notes flash and recede); the ripples travel forward with the tempo, so the whole row is always moving. It fills the panel from the very first drumbeat instead of growing out from one end: no scrolling, no accumulation, only the height of the bars changes.

When the queue runs dry but the performance is not over, an activity line appears at the end of the stage — the earliest-started still-running tool, with how many seconds it has been waiting; if no tool is running, it is waiting for the model:

```
⏳ $ npm test · 12s
⏳ waiting for the model…
```

A gap shorter than about 0.7 seconds does not produce this line: that is a breath between segments, not a wait. When the panel is only tall enough for the title, the intensity bar and one line of prose, this line also gives way to the prose.

The stage shows **verbatim** output. When the model itself does not break the line at the end of a paragraph, two paragraphs stick together on the same line — such as lines 1 and 6 above — that is the model's own formatting, not something the panel added. The one exception is the tool-call line: it is not the model's text but the extension's own text, so it starts its own line and closes its own line, just as in the transcript.

The transcript no longer shows assistant prose or reasoning that has not yet been performed — both are replaced with a one-line placeholder, and the content appears on the stage to the beat instead; tool calls and their results are the same, the block first collapses into a one-line placeholder, and the stage hands it back to its original renderer when the performance reaches that segment:

```
▶ performing · 18 lines · 412 chars
▶ performing · read src/engine.ts
```

There are two kinds of placeholder: `printing` while the text is still streaming and has not yet entered the queue, and `performing` once it is queued and being performed.
A placeholder only stands in for the original text while the performance is running, and the moment each segment finishes performing it is swapped back on the spot — segment by segment, not waiting for the task to end. The stage is the same: it appears only when it has something to perform, and as soon as the task ends — the agent has wrapped up and the queue has drained — it is taken down and its lines are returned to the transcript: the full output ends up in the transcript, and the stage's fixed height was only ever enough for its tail.

**Tool blocks are held back first, then restored after performing**

When a tool-call line is enqueued, its block first collapses into a one-line placeholder (`▶ performing · read src/engine.ts`); once the call line has been performed the call is restored, and then the tool result takes over the placeholder (`▶ performing · 3 lines · 24 chars`), and when the result has also been performed it goes back to the tool's own renderer — still collapsed when it should be, `ctrl+o` still works as usual. The call blocks of write and edit are the exception: a preview of the work is drawn on the block (for write, the first few lines of the text; for edit, the diff), and the preview is also "the work", so it is held back one step further — it only appears once the work has been printed, not spoiling things alongside the call line.

## Requirements

- Pi 0.81 or later

## Installation

```bash
pi install npm:real-vibe-coding
```

Or try it for the current session only:

```bash
pi -e npm:real-vibe-coding
```

## Music library
RealVibeCoding ships with its own music library.

To use a custom library, put pairs of files into `<agent directory>/real-vibe-coding/music/`, for example
`~/.pi/agent/real-vibe-coding/music/He's a Pirate.mid` and `He's a Pirate.wav` in the same directory, and RealVibeCoding will find them automatically.

The `.mid` provides the rhythm, the `.wav` provides the sound. The two should be the same performance — printing follows the MIDI onsets and the audio plays in sync, so if the two do not match, you will see the code gradually drift off the beat.

## Configuration

Run `/real-vibe-coding` to open the settings list,
or edit `~/.pi/agent/real-vibe-coding.json` directly:

```json
{
  "enabled": true,
  "playlistMode": "sequential",
  "loopTrack": "",
  "stageHeight": 12,
  "showPlaceholder": true,
  "audioBackend": "wav-soundplayer",
  "audioCommand": "ffplay -nodisp -autoexit \"{file}\""
}
```

| Setting | Meaning |
|---|---|
| `enabled` | Turn the whole performance off; code returns to normal rendering. |
| `playlistMode` | `sequential`, `shuffle`, or `loop-one`. |
| `loopTrack` | The track repeated in loop-one mode, by title (the `.mid` filename without its extension); empty means the first track in the library. |
| `stageHeight` | The number of lines the stage panel occupies, two of which are the title and the intensity bar; the idle activity line takes another line when there is room. |
| `showPlaceholder` | Whether to replace not-yet-performed prose, reasoning and built-in tool blocks with a one-line placeholder in the transcript. |
| `audioBackend` | `wav-soundplayer` or `command`. |
| `audioCommand` | The argv template for the `command` backend. |

When the performance is on, the footer shows a `♪ performance mode` badge; when it is off, nothing is shown.

## Playback backends

| Backend | Behavior |
|---|---|
| `wav-soundplayer` | The default on Windows. Plays `.wav` through PowerShell's `System.Media.SoundPlayer`. Nothing to install, no window, and the sound stops immediately when the process is killed. |
| `command` | Runs `audioCommand`: an argv template split on whitespace, where `{file}` is replaced with the media path. The process exiting is treated as the end of the track. Use this on non-Windows systems or when you want a better player. |

`command` examples:

```jsonc
"audioCommand": "ffplay -nodisp -autoexit \"{file}\""
"audioCommand": "afplay \"{file}\""
"audioCommand": "\"C:/Program Files/mpv/mpv.exe\" --no-video \"{file}\""
```

The command does not go through a shell, and the template is split **before** `{file}` is substituted, so a path with spaces is always a single argument. If the player's own path contains spaces, wrap it in quotes.

## Keyboard shortcuts

| Key | Effect |
|---|---|
| `ctrl+alt+p` | Pause / resume the music; printing continues as usual while paused. |
| `ctrl+alt+n` | Skip to the next track; if pressed while paused, it starts from the next track when resumed. |
| `ctrl+alt+d` | Immediately flush the rest of the queued code and stop the music. |

`ctrl+alt+p` pins the performance in place: the music stops, beats no longer reveal anything, the clock reading freezes, the stage header marks `⏸ paused`, and the line under the intensity bar spells out what to press to continue. **Printing does not freeze with it** — with no beats, the queue has nothing to wait for: the backlog is printed in one go on press, and text arriving while held is printed on arrival, that is, at pi's default speed; the model's backpressure gate therefore has nothing to do. Press again to continue: the current track replays from the beginning (the player cannot resume from the middle), the music returns, and printing is once again conducted by the beat from then on. Pressing the key when a performance is not running does nothing; if the task has already wrapped up and the backlog happens to be flushed by the press, the performance ends as usual and the stage is taken down.

`ctrl+alt+n` skips to the next track: the current track's player is cut, the playlist advances one track, and queued printing is not interrupted — it is revealed by the new track's beats instead. Pressing it while paused does not switch immediately — the performance is still pinned in place, and the press is remembered so that `ctrl+alt+p` resumes straight to the next track rather than replaying the one that was stopped. Pressing the key when a performance is not running does nothing.

`ctrl+alt+d` is useful when the backlog is large: Esc can abort the agent, but it cannot stop printing that has already been queued. It is also the fastest way to release the request that is waiting for printing to catch up.

## How it works

Pi has no API for replacing the assistant message renderer, nor any way to delay the token stream, so RealVibeCoding uses the only three levers it has:

1. **A markdown transformer replaces what it can intercept with a placeholder.** That is, assistant prose and reasoning — every text fragment, and every contiguous reasoning block (the latter being exactly the unit Pi hands to the transformer). A fragment still streaming shows `printing`; once the message is finalized, only fragments that actually entered the queue are replaced. This record lives only in this process and is never written to disk — so when an old session is restored, the old content is displayed as usual and no "content disappeared" history is left behind. It also only covers the task in progress: as soon as the task ends it is cleared and the transcript is invalidated and redrawn, so the real prose is rendered in the transcript.

2. **Built-in tools are re-registered with a wrapped renderer** (`toolhold.ts`). Pi draws a tool's block from the moment its call streams into the message — well before the tool begins executing — and there is no "don't draw yet" interface. But the block is drawn by the tool's own renderer, and a definition can be re-registered under the same name: so every built-in tool is re-registered with one wrapper layer around its renderer, which answers with the same one-line placeholder while the call line or result text is still on its way, and hands drawing back to the real renderer once printing has gone past that text. The queue coordinates reuse the same set as the markdown side: where the call line ends, where the result text ends, how far printing has got — `crossed` triggers a redraw as soon as it finds that a blocked block has been fully passed.

3. **A widget above the editor performs.** The deltas of prose and reasoning are enqueued as they stream, so the queue **runs ahead of the music** rather than trailing the model. The tool-call line is enqueued by `tool_execution_start`, reconstructed from the tool name and arguments — the transformer cannot see the call. Tool results are enqueued by the `tool_result` event, whose handler only observes — returning any value there would replace the tool result itself, including the copy fed to the model. What goes on stage is not always the result's own text: the `read` result is the exception, the file content read in is not output and is not enqueued; `write` and `edit` are performance work rather than receipts — write hands up the full text it wrote, edit hands up the diff it computed, replacing a one-line receipt like "Successfully …". Only when there is no work to perform in the receipt (an error, or a result carrying no payload) is the original text enqueued. These two tools' call blocks carry a preview of the work, and it too is held back behind the work: it does not appear while the tool is running, but only once the work has been printed (on error, once the error message has been printed); when the result performed nothing — no print step to cross — `close` reveals it on the spot and asks for a redraw.

   How much each MIDI onset reveals is priced by the note itself: velocity sets the per-second base, dynamics are the accent — the strongest beat prints sixteen times as many tokens as the weakest; duration is the time you buy — a long note prints more at once and a short note less, notes with no length given by the file count as one beat, and notes longer than that are capped at one bar; pitch tilts in reverse — for the same length and velocity, low notes cost double and high notes half; chord thickness adds one more weight — a single note at base price, and the thicker the chord the heavier it gets, approaching double, with each added note counting less than the last. The budget is spent in whole tokens: one delta is one token, surfacing as a whole block, never a half-token slowly growing; tool-call lines and tool results have no tokens to speak of, and are cut character by character after being converted at four characters per token. When a beat cannot fit the token at its start, that token is still printed whole, so every beat makes something move.

   When the accumulated budget reaches the price of a whole line (24 tokens, roughly one line of text in the panel), that beat stops counting tokens and simply buys the **whole line**. With the cursor at the line start, a whole line is printed; with the cursor mid-line, the interrupted line is first completed and then the next line is printed along with it — when the strongest beat lands, the reader sees a complete line. For a line not yet arrived from the model, whatever is currently in the queue is printed.

   The model is pulled along in sync too: once what is cached is enough that the music would take about a minute to print it, the next request to the LLM is held first, and released once printing has digested enough of the backlog. Without this gate, a long task would accumulate output far faster than the performance — the queue would keep growing throughout the task. A waiting request resumes on its own; `ctrl+alt+d` can release it immediately.

The clock is the tempo map the MIDI file itself carries, so tempo changes are followed precisely. The onset scheduling recomputes the wait until the next onset from the **absolute target time** after every hit, so dropped frames do not shift all later beats. A separate 30fps timer handles only the visual pulse, the clock reading and the activity line.

The music starts when a task **first produces output**, not when the task begins — and the stage appears at the same moment. Music keeps playing during reasoning; a track that ends automatically continues to the next; it stops only once the task has wrapped up **and** the queue has drained. That stopping is also the moment the printed text is returned to the transcript and the stage is taken down: the panel exists only during a performance and occupies not a single line when idle. When the queue is dry but the performance is not over, the activity line reports what it is waiting for: a still-running tool (the earliest-started one) or the model; a gap shorter than about 0.7 seconds, or a panel with no room for that line, means it is not shown.

`ctrl+alt+p`'s pause is the engine's own state, not printing's: the player is cut, the beat timer is cancelled, the clock frame is frozen, and the track loop waits at a resume point. Printing is not its concern — with no beats, the queue has nothing to wait for: the backlog is flushed in one go at the moment of pausing, and while held, every enqueue is revealed immediately, printing on arrival at pi's default rhythm; the backpressure gate naturally has nothing to do either. On resume, the same loop continues running, reopening the current track from the beginning, and the music once again conducts the revealing of new text. If the task has already wrapped up and the pause flushes the last stretch, the performance ends as usual by "wrapped up and queue empty".

`ctrl+alt+n`'s track skip only moves the track loop: the player is cut, the playlist advances, and the queue stays put, to be revealed by the next track's beats; when pressed while held, it is recorded as a marker, and the loop, reading it at the resume point, switches straight to the next track rather than reopening the current one from the beginning.

The playlist remembers its position per session: in sequential and shuffle modes, the next task in the same session continues from where the last one stopped, rather than starting over from the top of the library; the track repeated in loop-one is chosen in the settings panel.

## Troubleshooting

**Pi exits midway, and the terminal then spews garbage nonstop.** The cause is usually a command the model ran itself: pi runs on `node.exe`, and a command that kills by image name — `taskkill /F /IM node.exe`, `Stop-Process -Name node` — will terminate pi along with the process it meant to clear. `/F` is a hard kill: there is no cleanup to collapse the terminal, and raw mode, the hidden cursor and mouse tracking are left behind; from then on the shell echoes the escape sequence of every keypress verbatim, which looks like the terminal printing garbage continuously.

RealVibeCoding blocks this kind of command via pi's `tool_call` event (regardless of whether the performance is on): a matching call does not execute, and the model receives an explanation requiring it to use a PID-based kill instead — first `netstat -ano | findstr :<port>` to find the PID, then `taskkill //F //PID <PID>`. The block surface is narrow: only name-based node kills in the shell tool are blocked; kills by PID, or of other image names, are unaffected.

If the terminal is already wrecked, run `reset` in the shell (or open a new terminal) to recover; the garbage is only echoed escape sequences and has broken nothing. If music is still playing, that is a player process that had no time to exit when hard-killed, and it will stop when the track ends.

## Known limitations

- **No audio/MIDI synthesis.** The built-in backend plays pre-rendered `.wav`. Synthesizing `.mid` would require a SoundFont library, which users may not have.
- **No beat detection.** A MIDI file already carries a precise tempo map; analyzing audio would only introduce error.
- **No real playback position is obtained.** The default player does not report where it has played to, and the progress reading is extrapolated by RealVibeCoding's own clock. The player's startup latency is a constant offset, absorbed by `musicSyncOffsetMs`.
- **A track's rhythm ends with its MIDI.** If the `.wav` is longer than the `.mid` (usually only a few seconds of tail), printing pauses until the next track starts.
- **Resuming a performance replays the current track from the beginning.** The backend's contract is only "play a file, stop, end": it does not report position and does not accept starting from the middle. Pausing cuts the player process, so resuming can only replay the whole track. Printing is unaffected: on pause the backlog is flushed in one go, while held it prints on arrival, and only once the music returns does it go back to the beat. To avoid replaying this track, press `ctrl+alt+n` while held, and it will start from the next track on resume.
- **Very long output makes the agent pause for a bit.** Once the backlog is enough that the music would take about a minute to print it, the next request waits for printing to catch up — otherwise the queue would keep growing throughout the task. `ctrl+alt+d` skips this wait.
- **Only built-in tools' blocks are held back first.** A block is drawn by the tool's own renderer, and an extension can only re-register built-in tool definitions; custom tools' and MCP tools' renderers have no interface to read, so their blocks display as usual during a performance. Enqueueing for the performance is unaffected: call lines and result text still go on stage.
- **Images do not take part in the performance.** A tool call whose result is an image prints nothing on stage — there is no text to reveal. Pi still draws it in the transcript.
- **File content read in does not take part in the performance.** The read result does not go on stage — input read in is not the agent's output, and the tool block is drawn on arrival (as with images), with the file content remaining in the transcript as usual. As a side benefit: reading a large file no longer inflates the queue and makes the agent wait for printing at the backpressure gate.
- **What you type yourself does not take part in the performance.** What is performed is the agent's output; what you enter is not among it.
- **When Pi hides reasoning, the stage still performs it.** `hideThinkingBlock` only hides reasoning blocks in the transcript. If you want neither, turn the whole performance off.

## License

MIT
