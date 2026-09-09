# Time off · Global TekMed

Public web app. Anyone with the link can create an account, request time off, and see the team calendar. Managers approve or deny, and everything triggers email.

```
public/index.html      the whole app, one file
functions/index.js     email notifications, manager setup, account deletion
firestore.rules        who can read and write what
firebase.json          hosting + functions config
```

## What you need

- A Firebase project on the **Blaze** plan. Functions can't call an outside email API on Spark. Blaze is pay as you go and a team this size lands in the free tier, but a card has to be on file.
- A [Resend](https://resend.com) account for email. Free tier is 3,000 emails a month, which is plenty.
- Node 20 and the CLI: `npm i -g firebase-tools`

## Setup

**1. Create the project**

```bash
firebase login
firebase use --add          # pick your project, alias it "default"
```

**2. Turn on Auth and Firestore in the console**

- Authentication → Sign-in method → enable **Email/Password**
- Firestore Database → Create database → production mode

**3. Paste your web config**

Project settings → Your apps → Web app. Copy the config object into `FIREBASE_CONFIG` at the top of the script in `public/index.html`.

**4. Set up email**

In Resend, add and verify `globaltekmed.com` as a sending domain, then make an API key.

```bash
firebase functions:secrets:set RESEND_API_KEY
firebase functions:secrets:set MANAGER_SETUP_CODE   # invent one, share it with managers only
```

In `functions/index.js`, set `FROM` to an address on your verified domain and `APP_URL` to your hosting URL. For a quick test before the domain verifies, use `onboarding@resend.dev` as `FROM`; it only delivers to your own address.

**5. Deploy**

```bash
cd functions && npm install && cd ..
firebase deploy
```

**6. Make yourself a manager**

Create your account in the app first, then either:

- Console route: Firestore → create collection `admins` → document ID = your uid (Authentication tab shows it) → any field, e.g. `email: you@globaltekmed.com`
- Or in the app: sign in, go to the sign-in screen's manager tab, enter your `MANAGER_SETUP_CODE`

After that you can promote anyone else from Settings, no code needed.

**7. Add notification emails**

Settings → Notification emails. Up to 10. Every new request emails all of them.

## How email flows

| When | Who gets it | What's in it |
|---|---|---|
| Someone sends a request | everyone on the notification list | who asked, each block with hours, their note, link to the queue |
| A manager approves or denies | the person who asked | each block with its decision, the manager's note if there was one |

Deciding block by block sends one email covering that decision. Approve all sends one email covering the whole request. Undoing a decision doesn't email anyone.

## Data model

```
users/{uid}      name, email, createdAt
admins/{uid}     email, addedAt          ← existence = manager
config/app       fullDay, notifyEmails[]
requests/{id}    uid, name, email, note, hours, status, anyApproved, createdAt,
                 blocks: [{ kind, start, end, from, to, hours, status, decidedNote, decidedAt }]
```

One document per request, with the blocks inside it. That's what makes a multi-block request one email instead of three.

## Security notes

- Rules enforce that you can only create a request under your own uid with your own email, and only a manager can change a status. Nothing is trusted from the client.
- Requests are readable by their owner, by managers, and by everyone once approved. That last one is what the team calendar runs on, so approved dates and names are visible to all signed-in staff. Notes on a request are visible along with it once approved, so tell people not to put anything private in the note field, or strip notes from the calendar query if that matters.
- Anyone with the URL can create an account. If you want it restricted to `@globaltekmed.com`, add a check in the `signup` function and a matching rule on `users`, or use a Blocking Function on account creation.

## Local development

```bash
firebase emulators:start
```

Emulated functions won't send real email unless the secrets are available locally.
