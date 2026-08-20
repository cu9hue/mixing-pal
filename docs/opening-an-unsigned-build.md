# Opening Mixing Pal before it's signed

If you downloaded this, macOS will refuse to open it the first time. It shows
one of two messages, and they are different problems with different fixes.

- **"Mixing Pal is damaged and can't be opened."** This means the app has no
  code signature at all, or an invalid one. It is not actually damaged.
- **"Apple could not verify Mixing Pal is free of malicious software."** This
  means the app is signed but not notarized by Apple.

Mixing Pal is not signed, so you will see the first message. The steps below
are for each.

## "Apple could not verify..."

1. Drag Mixing Pal into your Applications folder.
2. Double-click it. macOS refuses. Dismiss the dialog.
3. Open System Settings → Privacy & Security, and scroll down. There is a
   line saying Mixing Pal was blocked, with an **Open Anyway** button next
   to it. Click it.
4. Confirm with your password or Touch ID.
5. Mixing Pal opens, and every launch after this one is normal.

Step 3 has to come after step 2. The button only appears once macOS has
something to tell you about, and it disappears again after a while — if you
cannot find it, double-click the app again and go straight back.

## "Mixing Pal is damaged and can't be opened"

**Open Anyway** may not appear for this one at all — this message doesn't
reliably offer it. Don't hunt for a button that might not exist.

The block comes from how the file arrived, not from the app. macOS marks
anything downloaded through a browser, or received over AirDrop, and refuses
to open an unsigned app carrying that mark. Ask whoever sent it to hand it
over a different way instead:

- On a USB stick, or
- Copied into `/Users/Shared` if you're on the same Mac or the same network
  share.

Neither of those marks the file as downloaded, so the block never triggers.
If you were sent Mixing Pal this way already and it just opened, that's why —
nothing else is different about the app.

**Nobody should ever ask you to run a Terminal command to get around this,
including us.** There is one, and it works, and being willing to type it is
exactly what someone distributing real malware is counting on. The button in
System Settings does the same job and tells you what you are agreeing to.
