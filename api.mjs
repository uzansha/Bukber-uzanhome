import admin from "firebase-admin";
import crypto from "crypto";

if (!admin.apps.length)
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const E = db.doc("events/active");

const sign = (e) => e + "." + crypto.createHmac("sha256", process.env.TOKEN_SECRET).update(String(e)).digest("hex");
const authed = (t) => { const [e] = (t || "").split("."); return !!e && +e > Date.now() && t === sign(e); };
const bad = (m, c = 400) => Object.assign(new Error(m), { c });
const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
const str = (v, a, b) => typeof v === "string" && v.trim().length >= a && v.trim().length <= b;
const res = (c, b) => ({ statusCode: c, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const PAY = ["UNPAID", "WAITING_CONFIRMATION", "PAID"];

export const handler = async (ev) => {
  try {
    const { a, t, ...p } = JSON.parse(ev.body || "{}");

    if (a === "state") {
      const [e, m] = await Promise.all([E.get(), db.collection("menu").get()]);
      return res(200, { event: e.data() || null, menu: m.docs.map((d) => ({ id: d.id, ...d.data() })) });
    }

    if (a === "createOrder") {
      const ev0 = (await E.get()).data();
      if (!ev0 || ev0.status !== "OPEN") throw bad("Event sedang tidak menerima pesanan.");
      if (!str(p.name, 2, 50)) throw bad("Nama harus 2–50 karakter.");
      if (!int(p.pax, 1, 20)) throw bad("Pax harus 1–20.");
      if ((p.note || "").length > 200) throw bad("Catatan maksimal 200 karakter.");
      if (!Array.isArray(p.items) || !p.items.length) throw bad("Pilih minimal satu menu.");
      const items = [];
      for (const it of p.items) {
        if (!int(it.qty, 1, 50)) throw bad("Jumlah menu harus 1–50.");
        const d = await db.doc("menu/" + String(it.id)).get();
        if (!d.exists || !d.data().available) throw bad("Ada menu yang tidak tersedia.");
        items.push({ id: d.id, name: d.data().name, price: d.data().price, qty: it.qty });
      }
      const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
      const tax = Math.round((subtotal * (ev0.taxPct || 0)) / 100);
      const service = Math.round((subtotal * (ev0.servicePct || 0)) / 100);
      const ref = await db.collection("orders").add({
        eid: ev0.eid, name: p.name.trim(), pax: p.pax, note: (p.note || "").trim(), items,
        subtotal, tax, service, total: subtotal + tax + service,
        status: "FIXED", payment: "UNPAID", createdAt: Date.now(),
      });
      return res(200, { id: ref.id });
    }

    if (a === "myOrder" || a === "claimPaid") {
      const ref = db.doc("orders/" + String(p.id));
      const d = await ref.get();
      if (!d.exists || d.data().status === "DELETED") return res(200, { order: null });
      if (a === "claimPaid" && d.data().payment === "UNPAID") await ref.update({ payment: "WAITING_CONFIRMATION" });
      return res(200, { order: { id: d.id, ...(await ref.get()).data() } });
    }

    if (a === "login") {
      if (String(p.pin) !== process.env.ADMIN_PIN) throw bad("PIN salah.", 401);
      return res(200, { token: sign(Date.now() + 8 * 3600e3) });
    }

    // ---- admin only ----
    if (!authed(t)) throw bad("Sesi admin berakhir. Masuk lagi.", 401);

    if (a === "orders") {
      const eid = (await E.get()).data()?.eid;
      const s = await db.collection("orders").where("eid", "==", eid).get();
      return res(200, { orders: s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => x.createdAt - y.createdAt) });
    }
    if (a === "setPayment") {
      if (!PAY.includes(p.payment)) throw bad("Status tidak valid.");
      await db.doc("orders/" + p.id).update({ payment: p.payment });
    } else if (a === "deleteOrder") {
      await db.doc("orders/" + p.id).update({ status: "DELETED" });
    } else if (a === "saveEvent") {
      const s = ["OPEN", "CLOSED", "FINISHED"];
      if (!s.includes(p.status)) throw bad("Status event tidak valid.");
      await E.set({
        name: String(p.name).slice(0, 80), date: String(p.date || ""), place: String(p.place || "").slice(0, 120),
        status: p.status, taxPct: Math.max(0, +p.taxPct || 0), servicePct: Math.max(0, +p.servicePct || 0),
        payInfo: String(p.payInfo || "").slice(0, 300),
      }, { merge: true });
    } else if (a === "newEvent") {
      await E.set({ eid: crypto.randomUUID(), name: "Bukber baru", date: "", place: "", status: "OPEN", taxPct: 10, servicePct: 5, payInfo: "" });
    } else if (a === "saveMenu") {
      if (!str(p.name, 1, 80) || !int(p.price, 0, 100000000)) throw bad("Nama atau harga menu tidak valid.");
      const data = { name: p.name.trim(), price: p.price, available: !!p.available };
      p.id ? await db.doc("menu/" + p.id).set(data, { merge: true }) : await db.collection("menu").add(data);
    } else if (a === "deleteMenu") {
      await db.doc("menu/" + p.id).delete();
    } else throw bad("Aksi tidak dikenal.");
    return res(200, { ok: true });
  } catch (e) {
    return res(e.c || 500, { error: e.c ? e.message : "Terjadi kesalahan server." });
  }
};
