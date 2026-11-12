# Editing `seed/`

- **One contract, one owner.** A file format, config shape or interface is defined in exactly one doc. Every other doc links to that owner and says only what it relies on; it doesn't restate the shape. Copies drift, and review caught the flag manifest shape disagreeing across docs and the sample.
- **When you change a contract**, find every other mention before you commit: `grep -rn "<file or key name>" seed sample`. Update or replace each one with a link to the owner.
- **A doc's Inputs/Interface promises must hold in its own steps and edge cases.** Re-read both after editing either.
