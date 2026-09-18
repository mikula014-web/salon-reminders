// send_reminders.js
//
// Pokreće se periodično (svakih 15 minuta) preko GitHub Actions.
// Koristi Firebase Admin SDK da:
//   1) pošalje push podsetnik korisnicima čiji termin počinje uskoro
//      (podešeno u settings/salon -> notificationHoursBefore),
//   2) pošalje push obaveštenje korisniku ako je ADMIN otkazao termin,
//   3) pošalje push obaveštenje ADMINU kad neko zakaže NOV termin,
//   4) pošalje push obaveštenje ADMINU kad KORISNIK otkaže termin.
//
// NAPOMENA O JEZIKU: poruke 1) i 2) idu KORISNIKU, pa se šalju na jeziku
// koji korisnik ima podešen u svom profilu (users/{uid}.language, "SR" ili
// "EN" - podešava se u aplikaciji, Profil -> prekidač za jezik). Poruke 3) i
// 4) idu ADMINU i uvek ostaju na srpskom (admin panel je samo na srpskom).
//
// Ne šalje ništa dvaput (proverava notificationSent / adminCancelNotified /
// adminNotified / userCancelAdminNotified polja pre slanja i postavlja ih
// na true posle uspešnog slanja).

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

function reminderText(language, startTime, serviceName) {
  if (language === "EN") {
    return {
      title: "Appointment reminder",
      body: `You have an appointment today at ${startTime}. Service: ${serviceName}.`,
    };
  }
  return {
    title: "Podsetnik za termin",
    body: `Imate zakazan termin danas u ${startTime}. Usluga: ${serviceName}.`,
  };
}

function adminCancellationText(language, startTime, serviceName) {
  if (language === "EN") {
    return {
      title: "Appointment cancelled",
      body: `Your appointment at ${startTime} (${serviceName}) has been cancelled by the salon.`,
    };
  }
  return {
    title: "Termin otkazan",
    body: `Vas termin za ${startTime} (${serviceName}) je otkazan od strane salona.`,
  };
}

async function sendReminders() {
  const settingsDoc = await db.collection("settings").doc("salon").get();
  const hoursBefore =
    (settingsDoc.exists && settingsDoc.data().notificationHoursBefore) || 2;

  const now = Date.now();
  const reminderThreshold = now + hoursBefore * 60 * 60 * 1000;

  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "ZAKAZAN")
    .where("timestamp", ">", now)
    .where("timestamp", "<=", reminderThreshold)
    .get();

  console.log(`[podsetnici] Pronadjeno ${snapshot.size} termina za podsetnik (kandidati).`);

  for (const doc of snapshot.docs) {
    const appointment = doc.data();
    if (appointment.notificationSent === true) continue;

    const userDoc = await db.collection("users").doc(appointment.userId).get();
    const fcmToken = userDoc.exists ? userDoc.data().fcmToken : null;
    const language = userDoc.exists ? (userDoc.data().language || "SR") : "SR";

    if (!fcmToken) {
      console.log(`[podsetnici] Korisnik ${appointment.userId} nema fcmToken, preskacem.`);
      continue;
    }

    const notification = reminderText(language, appointment.startTime, appointment.serviceName);

    try {
      await admin.messaging().send({ token: fcmToken, notification });
      await doc.ref.update({ notificationSent: true });
      console.log(`[podsetnici] Poslat podsetnik (${language}) za termin ${doc.id}`);
    } catch (err) {
      console.error(`[podsetnici] Greska slanja za termin ${doc.id}:`, err.message);
    }
  }
}

async function sendAdminCancellationNotifications() {
  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "OTKAZAN")
    .where("cancelledBy", "==", "ADMIN")
    .get();

  console.log(`[otkazivanja] Pronadjeno ${snapshot.size} termina otkazanih od admina.`);

  for (const doc of snapshot.docs) {
    const appointment = doc.data();
    if (appointment.adminCancelNotified === true) continue;

    const userDoc = await db.collection("users").doc(appointment.userId).get();
    const fcmToken = userDoc.exists ? userDoc.data().fcmToken : null;
    const language = userDoc.exists ? (userDoc.data().language || "SR") : "SR";

    if (!fcmToken) {
      await doc.ref.update({ adminCancelNotified: true });
      continue;
    }

    const notification = adminCancellationText(language, appointment.startTime, appointment.serviceName);

    try {
      await admin.messaging().send({ token: fcmToken, notification });
      await doc.ref.update({ adminCancelNotified: true });
      console.log(`[otkazivanja] Poslato obavestenje (${language}) za termin ${doc.id}`);
    } catch (err) {
      console.error(`[otkazivanja] Greska slanja za termin ${doc.id}:`, err.message);
    }
  }
}

async function getAdminTokens() {
  const whitelistSnap = await db.collection("admin_whitelist").get();
  const adminPhones = whitelistSnap.docs.map((d) => d.id);

  const adminTokens = [];
  for (const phone of adminPhones) {
    const usersSnap = await db.collection("users").where("telefon", "==", phone).get();
    usersSnap.forEach((doc) => {
      const token = doc.data().fcmToken;
      if (token) adminTokens.push(token);
    });
  }
  return adminTokens;
}

// Admin obavestenja OSTAJU na srpskom (admin panel je samo na srpskom).
async function notifyAdminsOfNewBookings() {
  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "ZAKAZAN")
    .where("adminNotified", "==", false)
    .get();

  console.log(`[admin-nov-termin] Pronadjeno ${snapshot.size} novih termina za prijavu adminu.`);
  if (snapshot.empty) return;

  const adminTokens = await getAdminTokens();
  if (adminTokens.length === 0) {
    console.log("[admin-nov-termin] Nijedan admin nema fcmToken ili whitelist je prazna.");
  }

  for (const doc of snapshot.docs) {
    const appointment = doc.data();

    for (const token of adminTokens) {
      try {
        await admin.messaging().send({
          token,
          notification: {
            title: "Novi termin zakazan",
            body: `${appointment.userName} je zakazao/la: ${appointment.serviceName}, ${appointment.date} u ${appointment.startTime}.`,
          },
        });
      } catch (err) {
        console.error(`[admin-nov-termin] Greska slanja adminu za termin ${doc.id}:`, err.message);
      }
    }

    await doc.ref.update({ adminNotified: true });
    console.log(`[admin-nov-termin] Admin obavesten za termin ${doc.id}`);
  }
}

async function notifyAdminOfUserCancellations() {
  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "OTKAZAN")
    .where("cancelledBy", "==", "USER")
    .where("userCancelAdminNotified", "==", false)
    .get();

  console.log(`[admin-otkazivanje] Pronadjeno ${snapshot.size} termina koje je korisnik otkazao.`);
  if (snapshot.empty) return;

  const adminTokens = await getAdminTokens();
  if (adminTokens.length === 0) {
    console.log("[admin-otkazivanje] Nijedan admin nema fcmToken ili whitelist je prazna.");
  }

  for (const doc of snapshot.docs) {
    const appointment = doc.data();

    for (const token of adminTokens) {
      try {
        await admin.messaging().send({
          token,
          notification: {
            title: "Korisnik je otkazao termin",
            body: `${appointment.userName} je otkazao/la: ${appointment.serviceName}, ${appointment.date} u ${appointment.startTime}. Termin je sada slobodan.`,
          },
        });
      } catch (err) {
        console.error(`[admin-otkazivanje] Greska slanja adminu za termin ${doc.id}:`, err.message);
      }
    }

    await doc.ref.update({ userCancelAdminNotified: true });
    console.log(`[admin-otkazivanje] Admin obavesten za termin ${doc.id}`);
  }
}

/**
 * Termini koji su ZAKAZANI ali čije je vreme već prošlo automatski se
 * prebacuju u status ZAVRSEN (umesto da zauvek ostanu ZAKAZAN u bazi).
 */
async function finalizePastAppointments() {
  const now = Date.now();
  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "ZAKAZAN")
    .where("timestamp", "<", now)
    .get();

  console.log(`[zavrsavanje] Pronadjeno ${snapshot.size} proslih termina za oznacavanje kao ZAVRSEN.`);

  for (const doc of snapshot.docs) {
    try {
      await doc.ref.update({ status: "ZAVRSEN" });
      console.log(`[zavrsavanje] Termin ${doc.id} oznacen kao ZAVRSEN.`);
    } catch (err) {
      console.error(`[zavrsavanje] Greska za termin ${doc.id}:`, err.message);
    }
  }
}

/**
 * SAMO OTKAZANI termini stariji od 24h se trajno brišu (zajedno sa
 * eventualnim appointment_slots dokumentima). Završeni (ZAVRSEN) termini se
 * NE brišu — ostaju kao poslovna evidencija salona (istorija posećenosti/
 * prihoda). Ako želiš i njih da čistiš posle nekog vremena, javi mi period.
 */
async function cleanupOldCancelledAppointments() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "OTKAZAN")
    .where("timestamp", "<", cutoff)
    .get();

  console.log(`[ciscenje] Pronadjeno ${snapshot.size} OTKAZANIH termina starijih od 24h za trajno brisanje.`);

  for (const doc of snapshot.docs) {
    try {
      const slotsSnap = await db
        .collection("appointment_slots")
        .where("appointmentId", "==", doc.id)
        .get();

      const batch = db.batch();
      slotsSnap.docs.forEach((slotDoc) => batch.delete(slotDoc.ref));
      batch.delete(doc.ref);
      await batch.commit();

      console.log(`[ciscenje] Obrisan otkazan termin ${doc.id} i ${slotsSnap.size} pratecih slot dokumenata.`);
    } catch (err) {
      console.error(`[ciscenje] Greska brisanja termina ${doc.id}:`, err.message);
    }
  }
}

(async () => {
  try {
    await sendReminders();
    await sendAdminCancellationNotifications();
    await notifyAdminsOfNewBookings();
    await notifyAdminOfUserCancellations();
    await finalizePastAppointments();
    await cleanupOldCancelledAppointments();
    console.log("Gotovo.");
    process.exit(0);
  } catch (err) {
    console.error("Neocekivana greska:", err);
    process.exit(1);
  }
})();
