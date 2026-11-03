const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const ARRIVAL_RADIUS_M = 80;

function getDistanceKm(loc1, loc2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(loc2.lat - loc1.lat);
  const dLng = toRad(loc2.lng - loc1.lng);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

exports.completeJob = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const { requestId, fare } = data;
  if (!requestId || !fare || fare <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing requestId or fare.');
  }

  const reqRef = db.collection('requests').doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
  const job = reqDoc.data();

  if (job.mechanicId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your job.');
  }
  if (job.status !== 'accepted') {
    throw new functions.https.HttpsError('failed-precondition', 'Job not in progress.');
  }

  const mechDoc = await db.collection('mechanics').doc(context.auth.uid).get();
  const mechLocation = mechDoc.data()?.location;
  if (!mechLocation || !job.location) {
    throw new functions.https.HttpsError('failed-precondition', 'Location data missing.');
  }

  const distanceM = getDistanceKm(mechLocation, job.location) * 1000;
  if (distanceM > ARRIVAL_RADIUS_M) {
    throw new functions.https.HttpsError('failed-precondition', `Too far from customer (${Math.round(distanceM)}m). Must be within ${ARRIVAL_RADIUS_M}m.`);
  }

  await reqRef.update({ status: 'completed', fare, completedAt: admin.firestore.FieldValue.serverTimestamp() });

  const mechRef = db.collection('mechanics').doc(context.auth.uid);
  const mech = (await mechRef.get()).data() || {};
  await mechRef.update({
    jobsToday: (mech.jobsToday || 0) + 1,
    earningsToday: (mech.earningsToday || 0) + fare,
    jobsCompleted: (mech.jobsCompleted || 0) + 1
  });

  return { success: true };
});