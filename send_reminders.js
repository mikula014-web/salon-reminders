// send_reminders.js
//
// Pokreće se periodično (svakih 15 minuta, prema rasporedu) preko
// GitHub Actions. VAŽNA NAPOMENA: GitHub Actions cron raspored NIJE
// garantovano tačan na minut — često kasni 10-40 minuta u periodima
// velike zauzetosti servera (ovo je poznato ograničenje besplatnih
// GitHub Actions runner-a, ne greška u ovom kodu). Zbog toga logika
// ispod NE koristi uzak "prozor" (npr. tačno između +2h00m i +2h20m),
// već umesto toga šalje podsetnik čim EFEKTIVNO vreme za podsetnik
// nastupi (>= sada), bez gornje granice — garantujući da se podsetnik
// NIKAD trajno ne izgubi, čak i ako GitHub Actions kasni. Cena ove
// pouzdanosti je što podsetnik može stići par minuta kasnije od
// idealnog trenutka (npr. 1:50h pre termina umesto tačno 2:00h), ali
// NIKAD pre vremena i NIKAD potpuno izostane.
//
// Koristi Firebase Admin SDK da:
//   1) pošalje push podsetnik korisnicima čiji termin počinje uskoro
//      (podešeno u settings/salon -> notificationHoursBefore),
//   2) pošalje push obaveštenje korisniku ako je ADMIN otkazao termin,
//   3) pošalje push obaveštenje ADMINU kad neko zakaže NOV termin,
//   4) pošalje push obaveštenje ADMINU kad KORISNIK otkaže termin.
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

async function sendReminders() {
  const settingsDoc = await db.collection("settings").doc("salon").get();
  const hoursBefore =
    (settingsDoc.exists && settingsDoc.data().notificationHoursBefore) || 2;

  const now = Date.now();
  // Termin treba da počne najkasnije za "hoursBefore" sati RAČUNAJUĆI OD SADA
  // (tj. vreme podsetnika je već nastupilo ili nastupa uskoro), ali termin
  // još uvek nije počeo (timestamp > now) - inače bismo podsećali na već
  // prošle termine.
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

    if (!fcmToken) {
      console.log(`[podsetnici] Korisnik ${appointment.userId} nema fcmToken, preskacem.`);
      continue;
    }

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: "Podsetnik za termin",
          body: `Imate zakazan termin danas u ${appointment.startTime}. Usluga: ${appointment.serviceName}.`,
        },
      });
      await doc.ref.update({ notificationSent: true });
      console.log(`[podsetnici] Poslat podsetnik za termin ${doc.id}`);
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

    if (!fcmToken) {
      await doc.ref.update({ adminCancelNotified: true });
      continue;
    }

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: "Termin otkazan",
          body: `Vas termin za ${appointment.startTime} (${appointment.serviceName}) je otkazan od strane salona.`,
        },
      });
      await doc.ref.update({ adminCancelNotified: true });
      console.log(`[otkazivanja] Poslato obavestenje za termin ${doc.id}`);
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

(async () => {
  try {
    await sendReminders();
    await sendAdminCancellationNotifications();
    await notifyAdminsOfNewBookings();
    await notifyAdminOfUserCancellations();
    console.log("Gotovo.");
    process.exit(0);
  } catch (err) {
    console.error("Neocekivana greska:", err);
    process.exit(1);
  }
})();
