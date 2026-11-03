// ============================================
// MECHIGO — Customer App Logic
// ============================================

let confirmationResult = null;
let selectedProblem = null;
let userLocation = null;
let currentRequestId = null;
let searchInterval = null;
let trackingMap = null;
let trackingMarkers = {};
let fareSettings = null;
let selfInitiatedCancel = false; // true when the customer themself cancels, so we don't double-alert
let matchUnsub = null; // holds the unsubscribe function for the active listenForMatch listener
let currentFareMultiplier = 1;
let currentSurgeMultiplier = 1;
let currentDistanceEstimateKm = 0;

const screens = {
  phone: document.getElementById('screen-phone'),
  otp: document.getElementById('screen-otp'),
  home: document.getElementById('screen-home'),
  searching: document.getElementById('screen-searching'),
  matched: document.getElementById('screen-matched'),
  rating: document.getElementById('screen-rating'),
  reviews: document.getElementById('screen-reviews'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- reCAPTCHA + Phone OTP ----------
window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
  size: 'invisible'
});

document.getElementById('sendOtpBtn').addEventListener('click', async () => {
  const raw = document.getElementById('phoneInput').value.trim();
  if (raw.length < 9) { alert('Enter a valid mobile number'); return; }
  const phoneNumber = '+92' + raw.replace(/^0/, '');

  const btn = document.getElementById('sendOtpBtn');
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    confirmationResult = await auth.signInWithPhoneNumber(phoneNumber, window.recaptchaVerifier);
    document.getElementById('otpPhoneDisplay').textContent = phoneNumber;
    showScreen('otp');
  } catch (err) {
    console.error(err);
    alert('Could not send code: ' + err.message);
    window.recaptchaVerifier.render().then(id => grecaptcha.reset(id));
  } finally {
    btn.disabled = false; btn.textContent = 'Send Code';
  }
});

// OTP digit auto-advance
const otpDigits = document.querySelectorAll('.otp-digit');
otpDigits.forEach((input, idx) => {
  input.addEventListener('input', () => {
    if (input.value && idx < otpDigits.length - 1) otpDigits[idx + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && idx > 0) otpDigits[idx - 1].focus();
  });
});

document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
  const code = Array.from(otpDigits).map(i => i.value).join('');
  if (code.length !== 6) { alert('Enter the full 6-digit code'); return; }

  try {
    const result = await confirmationResult.confirm(code);
    const user = result.user;

    // Create/update the customer profile in Firestore
    await db.collection('customers').doc(user.uid).set({
      phone: user.phoneNumber,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastLogin: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    showScreen('home');
    detectLocation();
    fareSettings = await loadFareSettings();
  } catch (err) {
    console.error(err);
    alert('Invalid code, try again.');
  }
});

document.getElementById('resendOtpBtn').addEventListener('click', () => {
  document.getElementById('sendOtpBtn').click();
});

// ---------- GPS Location ----------
const NEARBY_RADIUS_KM = 15;

function detectLocation() {
  const label = document.getElementById('locationLabel');
  if (!navigator.geolocation) {
    label.textContent = 'Location unavailable — enable GPS';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      label.textContent = 'Location detected';
      await showNearbyMechanicCount();
    },
    () => { label.textContent = 'Location permission denied'; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function showNearbyMechanicCount() {
  const label = document.getElementById('locationLabel');
  if (!userLocation) return;

  const snapshot = await db.collection('mechanics').where('isOnline', '==', true).get();
  let nearbyCount = 0;

  snapshot.forEach(doc => {
    const mech = doc.data();
    if (mech.location) {
      const distanceKm = getDistanceKm(userLocation, mech.location);
      if (distanceKm <= NEARBY_RADIUS_KM) nearbyCount++;
    }
  });

  label.textContent = nearbyCount > 0
    ? `${nearbyCount} mechanic${nearbyCount > 1 ? 's' : ''} nearby`
    : 'No mechanics online nearby right now';
}

// ---------- Pin-drop location picker ----------
let pinDropMap = null;
let pinMarkerStore = {};
let pinnedLocation = null;

document.getElementById('chooseOnMapBtn').addEventListener('click', () => {
  document.getElementById('pinDropOverlay').classList.remove('hidden');
  if (!pinDropMap) {
    const start = userLocation || { lat: 33.6844, lng: 73.0479 }; // Islamabad fallback
    pinDropMap = initMap('pinDropMap', start, 14);
    addOrUpdateMarker(pinDropMap, pinMarkerStore, 'pin', start);
    pinnedLocation = start;

    pinDropMap.on('moveend', () => {
      const c = pinDropMap.getCenter();
      pinnedLocation = { lat: c.lat, lng: c.lng };
      addOrUpdateMarker(pinDropMap, pinMarkerStore, 'pin', pinnedLocation);
    });
  } else {
    setTimeout(() => pinDropMap.invalidateSize(), 100);
  }
});

let searchDebounce = null;
document.getElementById('pinSearchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const query = e.target.value;
  searchDebounce = setTimeout(async () => {
    const results = await searchAddress(query, pinnedLocation || userLocation);
    const resultsEl = document.getElementById('pinSearchResults');
    resultsEl.innerHTML = '';
    results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result';
      item.textContent = r.label;
      item.addEventListener('click', () => {
        pinnedLocation = { lat: r.lat, lng: r.lng };
        pinDropMap.setView([r.lat, r.lng], 16);
        addOrUpdateMarker(pinDropMap, pinMarkerStore, 'pin', pinnedLocation);
        resultsEl.innerHTML = '';
        document.getElementById('pinSearchInput').value = r.label;
      });
      resultsEl.appendChild(item);
    });
  }, 400);
});

document.getElementById('openGoogleMapsBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const query = document.getElementById('pinSearchInput').value || 'Pakistan';
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, '_blank');
});

document.getElementById('googleMapsLinkInput').addEventListener('input', (e) => {
  const url = e.target.value;
  const match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
                url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/) ||
                url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!match) return;
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lng)) return;

  pinnedLocation = { lat, lng };
  pinDropMap.setView([lat, lng], 17);
  addOrUpdateMarker(pinDropMap, pinMarkerStore, 'pin', pinnedLocation);
});

document.getElementById('confirmPinBtn').addEventListener('click', () => {
  if (!pinnedLocation) return;
  userLocation = pinnedLocation;
  document.getElementById('locationLabel').textContent = 'Pinned location set';
  document.getElementById('pinDropOverlay').classList.add('hidden');
  showNearbyMechanicCount();
});

document.getElementById('cancelPinBtn').addEventListener('click', () => {
  document.getElementById('pinDropOverlay').classList.add('hidden');
});

// ---------- Problem selector ----------
document.querySelectorAll('.problem-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.problem-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedProblem = card.dataset.problem;
    document.getElementById('requestMechanicBtn').disabled = false;

    document.getElementById('petrolFields').classList.toggle('hidden', selectedProblem !== 'Petrol');
    document.getElementById('towFields').classList.toggle('hidden', selectedProblem !== 'Tow');

    updateFareEstimate();
  });
});

document.getElementById('fuelAmountInput').addEventListener('input', updateFareEstimate);
document.getElementById('premiumTowInput').addEventListener('change', updateFareEstimate);

async function updateFareEstimate() {
  const box = document.getElementById('fareEstimateBox');
  const label = document.getElementById('fareEstimateLabel');
  if (!selectedProblem || !userLocation || !fareSettings) { box.classList.add('hidden'); return; }

  const mechSnap = await db.collection('mechanics').where('isOnline', '==', true).get();
  const reqSnap = await db.collection('requests').where('status', '==', 'searching').get();
  let nearestKm = null;
  let onlineNearby = 0;
  let openNearby = 0;

  mechSnap.forEach(doc => {
    const mech = doc.data();
    if (mech.location) {
      const d = getDistanceKm(userLocation, mech.location);
      if (d <= NEARBY_RADIUS_KM) onlineNearby++;
      if (nearestKm === null || d < nearestKm) nearestKm = d;
    }
  });
  reqSnap.forEach(doc => {
    const r = doc.data();
    if (r.location && getDistanceKm(userLocation, r.location) <= NEARBY_RADIUS_KM) openNearby++;
  });

  currentDistanceEstimateKm = nearestKm !== null ? nearestKm : 3;
  currentSurgeMultiplier = getSurgeMultiplier(onlineNearby, Math.max(openNearby, 1));

  const extras = {
    premium: document.getElementById('premiumTowInput').checked,
    fuelAmount: parseInt(document.getElementById('fuelAmountInput').value, 10) || 0
  };
  const fare = calculateFare(fareSettings, currentDistanceEstimateKm, selectedProblem, extras, currentSurgeMultiplier, currentFareMultiplier);

  box.classList.remove('hidden');
  label.textContent = `Estimated fare: Rs ${fare}${currentSurgeMultiplier > 1 ? ' (peak pricing active)' : ''}`;
}

// ---------- Request Mechanic ----------
document.getElementById('requestMechanicBtn').addEventListener('click', async () => {
  if (!selectedProblem) return;
  if (!userLocation) { alert('Waiting for GPS location — try again in a moment.'); return; }
  if (!fareSettings) fareSettings = await loadFareSettings();

  const vehicleType = document.getElementById('vehicleTypeInput').value;
  const vehicleModel = document.getElementById('vehicleModelInput').value.trim();
  const vehiclePlate = document.getElementById('vehiclePlateInput').value.trim();
  if (!vehicleModel || !vehiclePlate) { alert('Please enter your vehicle model and plate number'); return; }

  const user = auth.currentUser;

  const custDoc = await db.collection('customers').doc(user.uid).get();
  if (custDoc.data()?.activeRequestId) {
    alert('You already have an active request. Finish or cancel it before placing a new one.');
    return;
  }

  const extras = {
    premium: document.getElementById('premiumTowInput').checked,
    fuelAmount: parseInt(document.getElementById('fuelAmountInput').value, 10) || 0
  };
  currentFareMultiplier = 1;
  const estimatedFare = calculateFare(fareSettings, currentDistanceEstimateKm, selectedProblem, extras, currentSurgeMultiplier, currentFareMultiplier);

  const reqRef = db.collection('requests').doc();
  const batch = db.batch();
  batch.set(reqRef, {
    customerId: user.uid,
    customerPhone: user.phoneNumber,
    problem: selectedProblem,
    extras,
    vehicleType, vehicleModel, vehiclePlate,
    location: userLocation,
    status: 'searching',
    mechanicId: null,
    surgeMultiplier: currentSurgeMultiplier,
    fareMultiplier: currentFareMultiplier,
    estimatedFare,
    counterOffer: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.update(db.collection('customers').doc(user.uid), { activeRequestId: reqRef.id });
  await batch.commit();

  currentRequestId = reqRef.id;
  document.getElementById('currentFareDisplay').textContent = estimatedFare;

  showScreen('searching');
  startSearchTimer(reqRef.id);
  listenForMatch(reqRef.id);
});

// ---------- Fare bump ----------
document.getElementById('bumpFareBtn').addEventListener('click', async () => {
  if (!currentRequestId) return;
  currentFareMultiplier = Math.round((currentFareMultiplier + 0.05) * 100) / 100;
  const extras = (await db.collection('requests').doc(currentRequestId).get()).data()?.extras || {};
  const newFare = calculateFare(fareSettings, currentDistanceEstimateKm, selectedProblem, extras, currentSurgeMultiplier, currentFareMultiplier);
  await db.collection('requests').doc(currentRequestId).update({ fareMultiplier: currentFareMultiplier, estimatedFare: newFare });
  document.getElementById('currentFareDisplay').textContent = newFare;
});

// ---------- Mechanic counter-offer approval ----------
document.getElementById('approveCounterBtn').addEventListener('click', async () => {
  const doc = await db.collection('requests').doc(currentRequestId).get();
  const data = doc.data();
  if (!data || !data.counterOffer) return;
  await db.collection('requests').doc(currentRequestId).update({
    status: 'accepted',
    mechanicId: data.counterOffer.mechanicId,
    agreedFare: data.counterOffer.amount,
    counterOffer: null
  });
  document.getElementById('counterOfferBox').classList.add('hidden');
});

document.getElementById('rejectCounterBtn').addEventListener('click', async () => {
  await db.collection('requests').doc(currentRequestId).update({ counterOffer: null });
  document.getElementById('counterOfferBox').classList.add('hidden');
});

function startSearchTimer(requestId, elapsedSeconds = 0) {
  let seconds = elapsedSeconds;
  const el = document.getElementById('searchTimer');
  const expirySeconds = (fareSettings?.requestExpiryMinutes || 2) * 60;
  clearInterval(searchInterval);
  searchInterval = setInterval(async () => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    el.textContent = `${m}:${s}`;

    if (seconds >= expirySeconds) {
      clearInterval(searchInterval);
      selfInitiatedCancel = true;
      await db.collection('requests').doc(requestId).update({ status: 'cancelled', cancelReason: 'no_mechanic_responded' });
      await db.collection('customers').doc(auth.currentUser.uid).update({ activeRequestId: null });
      currentRequestId = null;
      alert('No mechanic responded within the time limit. Please try requesting again — you can place a new ride anytime.');
      showScreen('home');
    }
  }, 1000);
}

function listenForMatch(requestId) {
  if (matchUnsub) { matchUnsub(); matchUnsub = null; } // stop any leftover listener from a previous ride
  matchUnsub = db.collection('requests').doc(requestId).onSnapshot(async (doc) => {
    const data = doc.data();
    if (!data) return;

    if (data.status === 'searching') {
      document.getElementById('currentFareDisplay').textContent = data.estimatedFare || 0;
      const counterBox = document.getElementById('counterOfferBox');
      if (data.counterOffer) {
        document.getElementById('counterOfferAmount').textContent = data.counterOffer.amount;
        counterBox.classList.remove('hidden');
      } else {
        counterBox.classList.add('hidden');
      }
    }

    if (data.status === 'accepted' && data.mechanicId) {
      clearInterval(searchInterval);
      document.getElementById('counterOfferBox').classList.add('hidden');
      const mechDoc = await db.collection('mechanics').doc(data.mechanicId).get();
      const mech = mechDoc.data() || {};
      document.getElementById('matchedMechName').textContent = mech.name || 'Mechanic';
      document.getElementById('matchedMechRating').textContent = (mech.rating || 5).toFixed(1);
      document.getElementById('matchedMechEta').textContent = `On the way · Fare: Rs ${data.agreedFare || data.estimatedFare || 0}`;
      showScreen('matched');

      if (!trackingMap) {
        trackingMap = initMap('trackingMap', data.location, 15);
        addOrUpdateMarker(trackingMap, trackingMarkers, 'customer', data.location);
      }
    }

    if (data.status === 'accepted' && data.mechanicLocation && trackingMap) {
      addOrUpdateMarker(trackingMap, trackingMarkers, 'mechanic', data.mechanicLocation);
    }

    if (data.status === 'completed') {
      trackingMap = null;
      trackingMarkers = {};
      await db.collection('customers').doc(auth.currentUser.uid).update({ activeRequestId: null });
      if (matchUnsub) { matchUnsub(); matchUnsub = null; }
      showScreen('rating');
    }

    if (data.status === 'cancelled') {
      clearInterval(searchInterval);
      trackingMap = null;
      trackingMarkers = {};
      currentRequestId = null;
      if (matchUnsub) { matchUnsub(); matchUnsub = null; }

      if (!selfInitiatedCancel) {
        // Cancelled by someone/something else — mechanic no-movement timeout or admin
        await db.collection('customers').doc(auth.currentUser.uid).update({ activeRequestId: null });
        if (data.cancelReason === 'mechanic_no_movement') {
          alert("The mechanic didn't move toward you within 2 minutes, so this ride was auto-cancelled. Please place a new request — you can do this anytime.");
        } else if (data.cancelReason === 'admin_cancelled') {
          alert('This ride was cancelled by Mechigo admin. Please place a new request if you still need help.');
        }
        showScreen('home');
      }
      selfInitiatedCancel = false;
    }
  });
}

// ---------- Star rating ----------
let selectedRating = 0;
document.querySelectorAll('.star').forEach(star => {
  star.addEventListener('click', () => {
    selectedRating = parseInt(star.dataset.value, 10);
    document.querySelectorAll('.star').forEach(s => {
      s.textContent = parseInt(s.dataset.value, 10) <= selectedRating ? '★' : '☆';
    });
  });
});

document.getElementById('submitRatingBtn').addEventListener('click', async () => {
  if (!selectedRating) { alert('Tap a star to rate'); return; }
  await submitMechanicRating(selectedRating);
  resetToHome();
});

document.getElementById('skipRatingBtn').addEventListener('click', () => {
  resetToHome();
});

async function submitMechanicRating(stars) {
  if (!currentRequestId) return;
  const reqDoc = await db.collection('requests').doc(currentRequestId).get();
  const reqData = reqDoc.data();
  if (!reqData || !reqData.mechanicId) return;

  const mechRef = db.collection('mechanics').doc(reqData.mechanicId);
  const mechDoc = await mechRef.get();
  const mech = mechDoc.data() || {};
  const prevRating = mech.rating || 5;
  const jobsCompleted = mech.jobsCompleted || 0;
  const newRating = ((prevRating * jobsCompleted) + stars) / (jobsCompleted + 1);

  const updatedJobsCompleted = jobsCompleted + 1;
  const shouldFlag = updatedJobsCompleted >= 5 && newRating < 3.5;
  const isPositive = stars >= 4;

  await mechRef.update({
    rating: newRating,
    flagged: shouldFlag,
    ...(isPositive ? { positiveReviewCount: (mech.positiveReviewCount || 0) + 1 } : {})
  });
  await db.collection('requests').doc(currentRequestId).update({ customerRating: stars });
}

document.getElementById('reportIssueBtn').addEventListener('click', async () => {
  const reason = prompt('Briefly describe the issue:');
  if (!reason) return;
  await db.collection('disputes').add({
    requestId: currentRequestId,
    filedByRole: 'customer',
    filedById: auth.currentUser.uid,
    reason,
    status: 'open',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  alert("Reported to Mechigo admin. We'll follow up.");
});

function resetToHome() {
  selectedRating = 0;
  document.querySelectorAll('.star').forEach(s => s.textContent = '☆');
  selectedProblem = null;
  currentRequestId = null;
  currentFareMultiplier = 1;
  document.querySelectorAll('.problem-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('requestMechanicBtn').disabled = true;
  document.getElementById('petrolFields').classList.add('hidden');
  document.getElementById('towFields').classList.add('hidden');
  document.getElementById('fareEstimateBox').classList.add('hidden');
  showScreen('home');
}

document.getElementById('cancelRequestBtn').addEventListener('click', async () => {
  if (currentRequestId) {
    selfInitiatedCancel = true;
    await db.collection('requests').doc(currentRequestId).update({ status: 'cancelled', cancelReason: 'customer_cancelled' });
    await db.collection('customers').doc(auth.currentUser.uid).update({ activeRequestId: null });
  }
  clearInterval(searchInterval);
  currentRequestId = null;
  showScreen('home');
});

document.getElementById('cancelMatchedBtn').addEventListener('click', async () => {
  if (!currentRequestId) return;
  if (!confirm('Cancel this ride? A mechanic has already been assigned.')) return;
  selfInitiatedCancel = true;
  await db.collection('requests').doc(currentRequestId).update({ status: 'cancelled', cancelReason: 'customer_cancelled' });
  await db.collection('customers').doc(auth.currentUser.uid).update({ activeRequestId: null });
  clearInterval(searchInterval);
  currentRequestId = null;
  trackingMap = null;
  trackingMarkers = {};
  showScreen('home');
});

// ---------- SOS ----------
document.getElementById('sosBtn').addEventListener('click', async () => {
  if (!confirm('Send SOS alert? This notifies Mechigo admin with your live location immediately.')) return;
  const user = auth.currentUser;
  await db.collection('sos_alerts').add({
    customerId: user ? user.uid : 'guest',
    location: userLocation,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    status: 'open'
  });
  alert('SOS sent. Stay where you are — help is being notified.');
});

// ---------- Review history ----------
document.getElementById('myReviewsBtn').addEventListener('click', async () => {
  showScreen('reviews');
  const listEl = document.getElementById('reviewsList');
  listEl.innerHTML = 'Loading…';

  const snap = await db.collection('requests')
    .where('customerId', '==', auth.currentUser.uid)
    .where('status', '==', 'completed')
    .get();

  const items = [];
  for (const doc of snap.docs) {
    const r = doc.data();
    if (!r.customerRating) continue;
    let mechName = 'Mechanic';
    if (r.mechanicId) {
      const mechDoc = await db.collection('mechanics').doc(r.mechanicId).get();
      mechName = mechDoc.data()?.name || 'Mechanic';
    }
    items.push({ mechName, problem: r.problem, rating: r.customerRating, fare: r.fare || r.agreedFare || 0 });
  }

  listEl.innerHTML = items.length === 0 ? '<p class="eta-note">No past reviews yet.</p>' : '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'ticket';
    card.innerHTML = `
      <div class="ticket-id mono">${item.problem}</div>
      <div class="ticket-problem">${item.mechName}</div>
      <div class="ticket-distance">${'★'.repeat(item.rating)}${'☆'.repeat(5 - item.rating)} · Rs ${item.fare}</div>`;
    listEl.appendChild(card);
  });
});

document.getElementById('backFromReviewsBtn').addEventListener('click', () => showScreen('home'));

// ---------- Auth state persistence ----------
auth.onAuthStateChanged(async (user) => {
  if (user && screens.phone.classList.contains('hidden') === false) {
    detectLocation();
    fareSettings = await loadFareSettings();

    // Check if this customer already has an active request (e.g. app was closed mid-request)
    const custDoc = await db.collection('customers').doc(user.uid).get();
    const activeId = custDoc.data()?.activeRequestId;

    if (activeId) {
      const reqDoc = await db.collection('requests').doc(activeId).get();
      const reqData = reqDoc.data();

      if (reqData && (reqData.status === 'searching' || reqData.status === 'accepted')) {
        // Resume the in-progress request so the customer can see it and cancel it if needed
        currentRequestId = activeId;
        document.getElementById('currentFareDisplay').textContent = reqData.estimatedFare || 0;
        showScreen('searching');

        const createdMs = reqData.createdAt?.toDate ? reqData.createdAt.toDate().getTime() : Date.now();
        const elapsedSeconds = Math.floor((Date.now() - createdMs) / 1000);
        startSearchTimer(activeId, elapsedSeconds);
        listenForMatch(activeId);
      } else {
        // Stale reference (already completed/cancelled) — clear it so customer isn't blocked
        await db.collection('customers').doc(user.uid).update({ activeRequestId: null });
        showScreen('home');
      }
    } else {
      showScreen('home');
    }
  }
});
