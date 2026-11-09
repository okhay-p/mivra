# Note excerpt relevance: calibration

Issue #66. Note excerpts were chosen by FTS5 match alone, so one topic word that happened to appear in an unrelated note pulled that note into the turn. The owner chose a combined rule: when a message has several topic words, an excerpt must match at least two distinct ones (option 2), plus a bm25 cut-off relative to the best match (option 1). This file records how the thresholds were chosen.

## Chosen rule

In `packages/server/src/runtime/note-context.ts` (`relevantExcerpts`), applied to the 40 best FTS5 candidates before the budget and per-note caps:

1. **Several topic words:** if the message has 3 or more topic words (`SEVERAL_TOPIC_WORDS`), drop any chunk that matches fewer than 2 of them.
2. **Relative cut-off:** of what's left, keep only chunks whose bm25 score is at least 0.4 of the best one (`MIN_RELATIVE_SCORE`).
3. **More chat words:** calibration showed that most stray matches came from words about the conversation, not the topic, so these joined the existing `CHATTER` list: example(s), step(s), confused/confusing, lesson(s), learn/learning, attached, difference(s)/different/differ/compare/versus/vs, much, many, way(s), thing(s), something, stuff, including/include, option(s).

A message with only one or two topic words is left to the relative cut-off, so "mvc architecture" or "bfs dfs" (after "difference" is dropped as chat) still finds the note about the one rare word.

## Method

- **Vault:** the owner's real Obsidian vault (54 Markdown notes, 126 chunks after import; 40 tagged, 10 with links), imported read-only into an in-memory database through the server's own `importVault` and note store. The vault was not modified and its text isn't reproduced here.
- **Messages:**
  - *Real:* the 37 user messages in a copy of the owner's `mivra.db`. Nine are Mivra's own lesson requests, which don't go through note search, and 20 are a bare "next". That leaves 8 distinct messages: requests to study a discrete-maths topic from slides, "next" with a follow-up question about the lesson, a note about attached slides, two "Explain …" prompts from a lesson outline, and a request for a data-structures course.
  - *Synthetic:* 35 messages written for this calibration, because 8 real messages are too few. 15 ask about topics the vault does cover (graph search, a sliding-window technique, GCD, probability, Go, MVC, sequence diagrams, Docker, Python), 10 ask about topics it doesn't, and 10 are typical replies during a lesson ("can you give me an example", "so the base case is when n equals zero").
- **Labels:** for each message, I marked the notes that are relevant and the ones that are borderline (related, but not what was asked). Any other note that comes in counts as **unrelated**. Borderline notes count neither way.
- **Measure:** for each setting, which notes reach the tutor after the existing budget (4,000 characters, at most 2 excerpts per note). For each setting I counted the unrelated notes, the messages with at least one unrelated note, and the relevant notes kept. For every candidate chunk, the script recorded its bm25 score and which query terms it matches (one FTS5 query per term), then replayed each rule offline. The final before and after figures come from running the shipped `noteContext` itself on the old and new code.
- The scripts were throwaway and aren't committed: they read private data, and the tests cover the rule.

## Results

Before and after, measured with the shipped code (`noteContext`):

| Messages | Unrelated notes sent | Messages with an unrelated note | Relevant notes kept | Excerpt characters, all turns |
|---|---|---|---|---|
| Real (8), before | 19 | 5 | 3 of 3 | 22,732 |
| Real (8), after | **0** | **0** | 3 of 3 | 4,168 |
| Synthetic (35), before | 72 | 24 | 20 of 20 | 117,418 |
| Synthetic (35), after | **23** | **10** | 20 of 20 | 66,790 |

On the real messages, only the data-structures request still brings in notes, and they're the three on algorithms it asked about. The discrete-maths requests had matched Python, Go and project notes on "math" or "counting". "next and how much of the lesson…" had matched every sync-conflict copy of a blog post on "much".

### Which part does what

All 43 messages, replayed offline (the budget is estimated, so the totals differ slightly from the table above):

| Setting | Unrelated | Messages with unrelated | Relevant kept |
|---|---|---|---|
| Before | 92 | 30 | 23 / 23 |
| Relative cut-off 0.4 only | 77 | 24 | 23 / 23 |
| Relative cut-off 0.5 only | 71 | 21 | 22 / 23 |
| Two terms from 2 topic words | 25 | 11 | **18 / 23** |
| Two terms from 3 topic words | 40 | 18 | 21 / 23 |
| Two terms from 3 words + cut-off 0.4 | 35 | 15 | 21 / 23 |
| Chat words only | 67 | 24 | 23 / 23 |
| Chat words + two terms from 2 words + 0.4 | 8 | 4 | **18 / 23** |
| **Chat words + two terms from 3 words + 0.4 (chosen)** | **23** | **10** | **23 / 23** |
| Chat words + two terms from 3 words + 0.5 | 21 | 9 | 22 / 23 |
| Chat words + two terms from 4 words + 0.4 | 36 | 14 | 23 / 23 |

- **Two terms from 2 topic words** removes the most noise but loses relevant notes. In two-word questions the topic is often one rare word, such as "mvc architecture", where two of the three MVC notes don't say "architecture". In comparisons ("difference between BFS and DFS") no single note mentions both. Requiring two terms only from 3 topic words keeps those.
- **The relative cut-off** removes weak single-word matches once a strong match exists. 0.4 kept every relevant note. At 0.5 a plainly relevant note scoring 0.49 of the best dropped out, so 0.4 leaves some margin.
- **Chat words** fixed what neither rule can: with no strong match to compare against, a message such as "can you give me an example" matched every note containing "example".

## What still gets through, and caveats

- **Two-word messages where one word isn't in the vault** and the other is common, e.g. "binomial distribution" (the vault's note says "binom", which the porter stemmer doesn't join with "binomial") or "linked list". The one matching word is all there is to compare against, so the relative cut-off can't help. A document-frequency floor (drop a single-term match on a word found in a large share of chunks) or an absolute bm25 floor would catch these. Neither was chosen, because bm25 scores and frequencies shift with vault size and one vault can't calibrate an absolute value.
- **Two common words that happen to share a chunk** (e.g. "many" and "choose" in a blog post, before "many" became a chat word) pass the two-term rule.
- **Inflections count separately:** terms are counted as written, so "recursion" and "recursive" in one message count as two even though FTS5 stems them alike. That's rarely a problem, because it only makes the two-term rule easier to pass.
- **Small sample:** 8 real messages, one vault of 54 notes, 35 synthetic messages and one person's labels. The real messages come from discrete-maths and data-structures sessions, so they say little about other subjects. The thresholds are a reasonable start, not a measured optimum. Re-run this calibration when there are more real turns with imported notes.
- Rank boosts for title and heading matches (option 3 in the issue) weren't tried.
