# Recorded from the repo root: pnpm build && node scripts/demo/setup.mjs && vhs scripts/demo/demo.tape
# The fake `claude` in this directory plays scripted sessions — no real API calls.

Output assets/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 12
Set TypingSpeed 70ms

Hide
Type `REPO="$PWD"; export PATH="$REPO/scripts/demo:$PATH"; kikimora() { HOME="$REPO/scripts/demo" node --no-warnings "$REPO/dist/index.js"; }; node scripts/demo/setup.mjs; cd scripts/demo/acme-shop; clear`
Enter
Sleep 1s
Show

Type "kikimora"
Sleep 500ms
Enter
Sleep 2.5s

Type@35ms "Watch CI on main and new bug issues in acme/shop."
Sleep 300ms
Enter
Type@35ms "Report each one as an actionable task."
Sleep 1s
Ctrl+D
Sleep 1.5s

Type@35ms "Senior engineer on acme-shop."
Sleep 300ms
Enter
Type@35ms "Work on a branch, run pnpm check before committing, open a PR."
Sleep 1s
Ctrl+D
Sleep 3s

Type "/start"
Sleep 1s
Enter

Sleep 7s
Sleep 12s
Sleep 3s
