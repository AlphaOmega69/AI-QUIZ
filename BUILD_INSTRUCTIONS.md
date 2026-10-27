# Turning AI Quiz Pro into a real .apk / .exe

I can't compile binaries myself in this sandbox (no network access — can't download
Electron's runtime or the Android SDK/Gradle toolchain). But this project is now set up
so **GitHub can build both for you automatically, for free, with nothing installed on
your computer.** That's the easiest path below. Two other options follow it.

---

## Option A (recommended) — Let GitHub build the .apk and .exe for you

You just need a free GitHub account. No Android Studio, no Visual Studio, no local Node.

1. Create a new repository on github.com and push this whole `quiz/` folder to it
   (drag-and-drop upload on github.com works fine, or `git init && git add . && git commit -m init && git push`).
2. Go to the repo's **Actions** tab. You'll see two workflows already waiting:
   **"Build Windows EXE"** and **"Build Android APK"** (they live in `.github/workflows/`).
3. Click each one → **Run workflow** → **Run workflow** (green button). Takes 3–6 minutes.
4. When it finishes (green check), open the run → scroll to **Artifacts** → download
   `AI-Quiz-Pro-Windows` (contains the `.exe` installer) or `AI-Quiz-Pro-Android`
   (contains `app-debug.apk`).
5. Windows: run the `.exe` installer. Android: copy `app-debug.apk` to your phone and
   tap it (you'll need to allow "install from unknown sources" — expected for a debug
   build not signed by the Play Store).

That debug APK is fine to install and use yourself, but it's **unsigned** — if you later
want to publish it on the Play Store, you'll need to generate a signing key and switch
the workflow to `assembleRelease` (Android Studio's docs walk through this in a few
clicks, or ask me and I'll write that workflow too).

---

## Option B — Build locally on your own PC

**Windows .exe:**
```bash
cd quiz/electron
npm install
npm run dist      # → quiz/electron/dist/*.exe
```

**Android .apk** (needs Android Studio installed):
```bash
cd quiz
npm install
npx cap add android
npx cap sync android
npx cap open android      # opens Android Studio
```
Then in Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**.

---

## Option C — Skip building entirely (PWA, works right now)

The app already has a manifest + service worker. Host `quiz/` anywhere over HTTPS
(GitHub Pages, Netlify, Vercel — all free) and:
- **Android (Chrome):** menu → "Install app" — installs like a real app, own icon, no browser bar.
- **PC (Chrome/Edge):** install icon in the address bar, or Settings → "Install as App" in-app.

No build step, no waiting on a CI run — but it's a PWA, not a literal `.apk`/`.exe` file.

---

## Before distributing any of these

Each user still needs to paste their **own** free Gemini/Groq/RapidAPI key into
Settings on first launch — the app deliberately ships with no keys baked in, so it's
safe to hand the `.apk`/`.exe` to anyone.
