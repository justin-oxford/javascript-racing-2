# /tools

Offline scripts (track extraction, headless test runs). Empty until a card needs one.

## Rebuilding a track after new art / mask (Oxford redesign card)

1. Commit the new art and mask on their own, after tagging the old layout (e.g. `oxford-v1`).
2. `npm run rebuild-track -- <id> --bump` runs these, in order:
   - `validate-track`, then `art-mask-check` (writes `reports/img/<id>-artmask.png`)
   - `track-fit`
   - `optimize-racing-line --write`, then `optimize-exit-line --write`
   - `setup-search --laps 10 --write`
   - the version bump
   - `track-fit` again, then `track-stats`
3. The layout version (`track.json` `version`) keys lap records and ghosts. Records and ghosts from the old layout stay under the old key, and old ghost files are refused with a message.
4. To compare before and after, run `npm run race-realism` in a worktree at the old tag and in this tree.
