// send_reminders.js
//
// Pokreće se periodično (svakih 15 minuta) preko GitHub Actions.
// Koristi Firebase Admin SDK da:
//   1) pošalje push podsetnik korisnicima čiji termin počinje za
//      X sati (podešeno u settings/salon -> notificationHoursBefore),
//   2) pošalje push obaveštenje korisnicima čiji je termin otkazao ADMIN.
//
// Ne šalje ništa dvaput (proverava notificationSent / adminCancelNotified
// polja pre slanja i postavlja ih na true posle uspešnog slanja).

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
  const windowStart = now + hoursBefore * 60 * 60 * 1000;
  // Prozor malo širi od intervala pokretanja (15 min) da ne "promašimo"
  // termine zbog kašnjenja GitHub Actions rasporeda.
  const windowEnd = windowStart + 20 * 60 * 1000;

  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "ZAKAZAN")
    .where("timestamp", ">=", windowStart)
    .where("timestamp", "<", windowEnd)
    .get();

  console.log(`[podsetnici] Pronadjeno ${snapshot.size} termina u prozoru.`);

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

(async () => {
  try {
    await sendReminders();
    await sendAdminCancellationNotifications();
    console.log("Gotovo.");
    process.exit(0);
  } catch (err) {
    console.error("Neocekivana greska:", err);
    process.exit(1);
  }
})();
