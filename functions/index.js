const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const RESEND_API_KEY   = defineSecret("RESEND_API_KEY");
const MANAGER_SETUP_CODE = defineSecret("MANAGER_SETUP_CODE");

/* The address emails come from. Must be on a domain you've verified
   in Resend. onboarding@resend.dev works for testing only. */
const FROM = "Time off <timeoff@globaltekmed.com>";
const APP_URL = "https://YOUR-PROJECT.web.app";

/* ---------- email ---------- */
async function sendMail(key, to, subject, html) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: list, subject, html })
  });
  if (!res.ok) console.error("Resend failed", res.status, await res.text());
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const fmtDate = s => new Date(s + "T00:00:00").toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric" });
function fmtTime(t) {
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2,"0")} ${ap}` : `${h} ${ap}`;
}
function blockLine(b) {
  const when = b.kind === "full"
    ? (b.start === b.end ? fmtDate(b.start) : `${fmtDate(b.start)} to ${fmtDate(b.end)}`)
    : `${fmtDate(b.start)}, ${fmtTime(b.from)} to ${fmtTime(b.to)}`;
  return `${esc(when)} <span style="color:#767f8a">· ${b.hours} hours</span>`;
}
function wrap(heading, intro, rows, footer) {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#3d444d;line-height:1.5">
    <div style="font-size:12px;letter-spacing:.04em;color:#0d8cc7;font-weight:700">GLOBAL TEKMED</div>
    <h1 style="font-size:21px;color:#0a0a0a;margin:6px 0 10px;letter-spacing:-.02em">${heading}</h1>
    <p style="margin:0 0 18px;font-size:15px">${intro}</p>
    <div style="border:1px solid #e4e8ec;border-radius:12px;overflow:hidden;margin-bottom:20px">
      ${rows.map(r => `<div style="padding:12px 14px;border-bottom:1px solid #eef1f4;font-size:14px">${r}</div>`).join("")}
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:#0d8cc7;color:#fff;text-decoration:none;
      font-weight:600;font-size:14px;padding:11px 20px;border-radius:9px">Open the time off app</a>
    <p style="margin:22px 0 0;font-size:12.5px;color:#767f8a">${footer}</p>
  </div>`;
}

/* ---------- someone submitted ---------- */
exports.onRequestCreated = onDocumentCreated(
  { document: "requests/{id}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const r = event.data?.data();
    if (!r) return;
    const cfg = (await admin.firestore().doc("config/app").get()).data() || {};
    const to = (cfg.notifyEmails || []).slice(0, 10);
    if (!to.length) return console.warn("No notification emails configured");

    const rows = r.blocks.map(blockLine);
    if (r.note) rows.push(`<span style="color:#767f8a">Note:</span> ${esc(r.note)}`);

    await sendMail(
      RESEND_API_KEY.value(), to,
      `Time off request from ${r.name} · ${r.hours} hours`,
      wrap(
        `${esc(r.name)} asked for time off`,
        `${esc(r.blocks.length)} block${r.blocks.length === 1 ? "" : "s"}, ${r.hours} hours total. Approve or deny it in the queue.`,
        rows,
        `Sent to everyone on the notification list. Change who gets these in Settings.`
      )
    );
  }
);

/* ---------- a manager decided ---------- */
exports.onRequestUpdated = onDocumentUpdated(
  { document: "requests/{id}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data?.before.data();
    const after  = event.data?.after.data();
    if (!before || !after) return;

    const changed = after.blocks
      .map((b, i) => ({ b, was: before.blocks[i]?.status }))
      .filter(({ b, was }) => b.status !== was && b.status !== "pending");
    if (!changed.length) return;

    const approved = changed.filter(c => c.b.status === "approved");
    const denied   = changed.filter(c => c.b.status === "denied");
    const heading = !denied.length ? "Your time off is approved"
                  : !approved.length ? "Your time off request was denied"
                  : "Part of your time off is approved";

    const rows = changed.map(({ b }) =>
      `${blockLine(b)} <span style="float:right;font-weight:600;color:${b.status === "approved" ? "#046fa5" : "#b3261e"}">
        ${b.status === "approved" ? "Approved" : "Denied"}</span>`
    );
    const notes = [...new Set(changed.map(c => c.b.decidedNote).filter(Boolean))];
    notes.forEach(n => rows.push(`<span style="color:#767f8a">From your manager:</span> ${esc(n)}`));

    await sendMail(
      RESEND_API_KEY.value(), after.email, heading,
      wrap(heading, `Here's where each block landed.`, rows,
        `Approved time shows on the team calendar so everyone can plan around it.`)
    );
  }
);

/* ---------- turn on manager access with a setup code ---------- */
exports.claimManager = onCall(
  { secrets: [MANAGER_SETUP_CODE] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (req.data?.code !== MANAGER_SETUP_CODE.value()) throw new HttpsError("permission-denied", "Bad code.");
    await admin.firestore().doc(`admins/${req.auth.uid}`).set({
      email: req.auth.token.email || "", addedAt: Date.now(), via: "setup-code"
    });
    return { ok: true };
  }
);

/* ---------- delete an employee account ---------- */
exports.removeEmployee = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const me = await admin.firestore().doc(`admins/${req.auth.uid}`).get();
  if (!me.exists) throw new HttpsError("permission-denied", "Managers only.");
  const uid = req.data?.uid;
  if (!uid) throw new HttpsError("invalid-argument", "No uid.");
  if (uid === req.auth.uid) throw new HttpsError("failed-precondition", "You can't delete your own account here.");

  await admin.auth().deleteUser(uid).catch(e => console.error("auth delete", e));
  await admin.firestore().doc(`users/${uid}`).delete().catch(() => {});
  await admin.firestore().doc(`admins/${uid}`).delete().catch(() => {});
  return { ok: true };
});
