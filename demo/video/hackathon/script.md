# Weft for Hermes — hackathon cut (< 90 s)

Narration for `demo/video/hackathon` (Hermes Plugin Hackathon entry). Same format as `../script.md`
(`## NN · Title` + a narration block), rendered with `rig/narrate.mjs --script` and cut by
`hackathon/assemble.mjs` against `hackathon/edl.json`. Pictures: `install.tape` (catalog install),
`live.tape` + `live.py` (two live Hermes sessions with model inference), `cards.json`.

Accuracy: Python declaration analysis is built into the plugin; its `analyzer` setting (a built
`analyze.mjs`, `@weft/analyzer`) adds the other 11 of Weft's 12 languages (docs/languages.md;
`analyze.mjs --languages` lists 12). Without it, other languages are whole-file. The blocking
demonstration is the cross-file stale signature (a same-file overlap is only a `claim_wait` warning).
Local gateway by default; hosted is opt-in. No Desktop pane in this cut (not filmed in a live Desktop).

## 00 · Title

```narration
Git tells you two agents collided after they commit. Weft tells Hermes while it's still editing.
```

## 01 · Install from the catalog

```narration
Weft is in the Hermes plugin catalog, so one command installs it. Its gateway runs on your machine by default. Hosted mode is opt-in.
```

## 02 · Two sessions, one repo

```narration
Now a live run, with real model calls. Two Hermes sessions, each in its own Git worktree of the same repo. Both read the code. Weft status: enforce mode, connected, same repo.
```

## 03 · Agent A changes the signature

```narration
Agent A changes calc_total to take a required options argument. Weft records which declaration changed, not just the file.
```

## 04 · Agent B is stopped before the write

```narration
Agent B still has the old signature in its worktree, and writes code that calls it the old way. Before that edit reaches disk, Hermes gets a stale assumption error, naming the symbol, the other agent, and the event.
```

## 05 · Status

```narration
B's status shows one rejected edit and one open conflict. Coordination happens in the tool loop, not in the prompt.
```

## 06 · End

```narration
Python analysis is built in. Point the plugin at Weft's full analyzer for TypeScript, Go, Rust, Java and eight more languages. Weft is open source, under MIT.
```
