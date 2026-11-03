// ============================================
// MECHIGO — Shared Firebase Config
// This ONE file is used by customer/, mechanic/, and admin/
// Do not duplicate this — all three apps load it via <script src="../firebase-config.js">
// ============================================

const firebaseConfig = {
  apiKey: "AIzaSyCbiTuNMVFnC1-f9I4LgfiiQFXVyzoG21A",
  authDomain: "mechigo-de38d.firebaseapp.com",
  projectId: "mechigo-de38d",
  storageBucket: "mechigo-de38d.firebasestorage.app",
  messagingSenderId: "158769880205",
  appId: "1:158769880205:web:494209fec717ec165656c4",
  measurementId: "G-4T7B5P8RY0"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// ============================================
// CLOUDINARY CONFIG — fill these in with your cloud name + unsigned upload preset
// Get these from cloudinary.com dashboard → Settings → Upload → Add upload preset (unsigned)
// ============================================
const CLOUDINARY_CLOUD_NAME = "oeyjqrlk";
const CLOUDINARY_UPLOAD_PRESET = "MECHIGO";

/**
 * Uploads a file (image) to Cloudinary and returns the hosted URL.
 * Used for: mechanic profile photo, CNIC photo, customer vehicle photo (optional).
 * @param {File} file
 * @returns {Promise<string>} secure_url of the uploaded image
 */
async function uploadToCloudinary(file) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) throw new Error("Cloudinary upload failed");
  const data = await res.json();
  return data.secure_url;
}

/**
 * Checks a file is under the max size limit (default 500KB).
 * Used for all Mechigo image uploads — CNIC, profile photo, driving licence.
 */
function isFileUnderLimit(file, maxKB = 500) {
  return file && file.size <= maxKB * 1024;
}

// ============================================
// Distance calculation (Haversine formula)
// Used by both mechanic (filter nearby jobs) and customer (nearby mechanic count)
// Returns distance in kilometers between two {lat, lng} points
// ============================================
function getDistanceKm(loc1, loc2) {
  const toRad = (val) => (val * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(loc2.lat - loc1.lat);
  const dLng = toRad(loc2.lng - loc1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// Fare engine — shared by customer, mechanic, and admin
// All rates are admin-editable in settings/global; these are fallback defaults
// ============================================
const DEFAULT_FARE_SETTINGS = {
  baseArrivalFee: 150,
  perKmRate: 25,
  punctureExtra: 150,
  batteryExtra: 150,
  petrolServiceFee: 100,
  towingBaseFee: 400,
  towingPerKmRate: 60,
  premiumTowMultiplier: 1.4,
  commissionPercent: 15,
  rideBonusAmount: 1000,
  rideBonusMilestone: 50,
  reviewBonusAmount: 1000,
  reviewBonusMilestone: 50,
  requestExpiryMinutes: 2
};

async function loadFareSettings() {
  const doc = await db.collection('settings').doc('global').get();
  return Object.assign({}, DEFAULT_FARE_SETTINGS, doc.data() || {});
}

/**
 * problem: 'Engine' | 'Tire' | 'Battery' | 'Other' | 'Petrol' | 'Tow'
 * extras: { premium: bool (tow only), fuelAmount: number (petrol only) }
 */
function calculateFare(settings, distanceKm, problem, extras = {}, surgeMultiplier = 1, fareMultiplier = 1) {
  let fare;
  if (problem === 'Tow') {
    fare = settings.towingBaseFee + (distanceKm * settings.towingPerKmRate);
    if (extras.premium) fare *= settings.premiumTowMultiplier;
  } else {
    fare = settings.baseArrivalFee + (distanceKm * settings.perKmRate);
    if (problem === 'Tire') fare += settings.punctureExtra;
    if (problem === 'Battery') fare += settings.batteryExtra;
    if (problem === 'Petrol') fare += settings.petrolServiceFee + (extras.fuelAmount || 0);
  }
  fare *= surgeMultiplier;
  fare *= fareMultiplier;
  return Math.round(fare);
}

// Ratio of online mechanics to open requests nearby → surge tier
function getSurgeMultiplier(onlineMechanicsNearby, openRequestsNearby) {
  if (openRequestsNearby === 0) return 1;
  const ratio = onlineMechanicsNearby / openRequestsNearby;
  if (ratio >= 3) return 1.0;
  if (ratio >= 1) return 1.2;
  return 1.5;
}
