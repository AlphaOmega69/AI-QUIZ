# Setting up "Continue with Google" / "Continue with Facebook"

Both buttons work out of the box in the sense that they're wired up and ready —
they just need an ID from each provider before they'll actually authenticate
anyone. Until you add these, clicking them shows a friendly "not set up yet"
message and points people to Email/Guest instead — nothing breaks.

Both of these are **free** and take about 5 minutes each.

---

## Google Sign-In

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (or pick an existing one).
2. **APIs & Services → OAuth consent screen** → set it up as "External", fill in an app name and your email. You can leave it in "Testing" mode while you try this out.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Under **Authorized JavaScript origins**, add the exact URL(s) you'll host the app on, e.g. `https://yourname.github.io` or `http://localhost:8000` for local testing. (No path, no trailing slash.)
4. Copy the **Client ID** it gives you (ends in `.apps.googleusercontent.com`).
5. Open `js/config.js` in this project and paste it in:
   ```js
   googleClientId: "123456789-abcxyz.apps.googleusercontent.com",
   ```
6. Reload the app — "Continue with Google" now works.

**Important:** this only works when the app is served over `http://localhost` or a real `https://` domain that matches what you entered as an authorized origin — it will not work opened directly from a `file://` path on your computer.

---

## Facebook Login

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → choose "Consumer" or "None" as the type.
2. In your new app's dashboard, add the **Facebook Login** product.
3. **Facebook Login → Settings** → under **Valid OAuth Redirect URIs** / **Allowed Domains for the JavaScript SDK**, add the domain you're hosting on (same rule as Google — `https://` or `localhost`).
4. Go to **Settings → Basic** and copy your **App ID**.
5. Open `js/config.js` and paste it in:
   ```js
   facebookAppId: "1234567890123456",
   ```
6. Reload the app. Note: while your Facebook app is in **Development mode**, only accounts you've added as testers/developers on the Facebook app can log in with it. To let the public use it, submit the app for **App Review** (Facebook's process, can take a few days) or switch it to **Live** mode if your use case doesn't require review.

---

## Remember

Nothing about this touches a server you run — both flows return the user's
name/email/photo directly to the browser, which the app then stores locally
the same way Email/Guest login does. There's no password, no session cookie,
and no cross-device sync. It's identity for personalization, not security.
