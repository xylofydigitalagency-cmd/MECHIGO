// ============================================
// MECHIGO — Mechanic App Logic
// ============================================

let confirmationResult = null;
let cnicPhotoFile = null;
let profilePhotoFile = null;
let licensePhotoFile = null;
let currentMechanicId = null;
let jobsListenerUnsub = null;
let mechanicLocation = null;
let currentActiveJobId = null;
let watchId = null;
let lastFirestoreWrite = 0;
let activeJobMap = null;
let activeJobMarkers = {};
let currentJobLocation = null;
let fareSettings = null;
const MAX_DISTANCE_KM = 15; // jobs within this radius are shown on screen
const NOTIFY_RADIUS_KM = 5; // only jobs within this radius trigger sound + vibration
const ARRIVAL_RADIUS_M = 80;
const NO_MOVE_LIMIT_M = 150; // if mechanic hasn't moved this far within 2 min of accepting, auto-cancel
const notifiedJobIds = new Set(); // tracks jobs we've already alerted for, so we don't repeat the alert
let activeJobUnsub = null;
let noMoveTimeoutId = null;
let acceptLocationSnapshot = null;
let selfCompletedJob = false;

// Plays a short beep (Web Audio API, no external sound file needed) and vibrates the phone
function playNewJobAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 250, 500].forEach((delay) => {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }, delay);
    });
  } catch (err) {
    console.warn('Audio alert failed:', err.message);
  }
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
}

function checkArrival() {
  if (!mechanicLocation || !currentJobLocation) return;
  const distanceM = getDistanceKm(mechanicLocation, currentJobLocation) * 1000;
  const statusEl = document.getElementById('arrivalStatus');
  const btn = document.getElementById('completeJobBtn');
  if (!statusEl || !btn) return;

  if (distanceM <= ARRIVAL_RADIUS_M) {
    statusEl.textContent = 'You have arrived — ready to complete';
    btn.disabled = false;
  } else {
    statusEl.textContent = `${Math.round(distanceM)}m away — get closer to complete`;
    btn.disabled = true;
  }
}

const screens = {
  phone: document.getElementById('screen-phone'),
  otp: document.getElementById('screen-otp'),
  profile: document.getElementById('screen-profile'),
  pending: document.getElementById('screen-pending'),
  dashboard: document.getElementById('screen-dashboard'),
  suspended: document.getElementById('screen-suspended'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- reCAPTCHA + Phone OTP ----------
window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'invisible' });

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
  } finally {
    btn.disabled = false; btn.textContent = 'Send Code';
  }
});

const otpDigits = document.querySelectorAll('.otp-digit');
otpDigits.forEach((input, idx) => {
  input.addEventListener('input', () => { if (input.value && idx < otpDigits.length - 1) otpDigits[idx + 1].focus(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !input.value && idx > 0) otpDigits[idx - 1].focus(); });
});

document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
  const code = Array.from(otpDigits).map(i => i.value).join('');
  if (code.length !== 6) { alert('Enter the full 6-digit code'); return; }

  try {
    const result = await confirmationResult.confirm(code);
    const user = result.user;
    currentMechanicId = user.uid;

    // Check if profile already exists
    const doc = await db.collection('mechanics').doc(user.uid).get();
    if (!doc.exists) {
      showScreen('profile');
    } else {
      routeByStatus(doc.data());
    }
  } catch (err) {
    console.error(err);
    alert('Invalid code, try again.');
  }
});

function routeByStatus(data) {
  if (data.suspended) {
    showScreen('suspended');
  } else if (data.verificationStatus === 'approved') {
    showScreen('dashboard');
    initDashboard(data);
  } else {
    showScreen('pending');
  }
}

// ---------- Profile photo uploads ----------
document.getElementById('cnicUpload').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f && !isFileUnderLimit(f)) { alert('CNIC photo must be under 500KB.'); e.target.value = ''; return; }
  cnicPhotoFile = f;
  if (cnicPhotoFile) document.getElementById('cnicUploadBox').classList.add('filled');
});
document.getElementById('profileUpload').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f && !isFileUnderLimit(f)) { alert('Profile photo must be under 500KB.'); e.target.value = ''; return; }
  profilePhotoFile = f;
  if (profilePhotoFile) document.getElementById('profileUploadBox').classList.add('filled');
});
document.getElementById('licenseUpload').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f && !isFileUnderLimit(f)) { alert('Driving licence photo must be under 500KB.'); e.target.value = ''; return; }
  licensePhotoFile = f;
  if (licensePhotoFile) document.getElementById('licenseUploadBox').classList.add('filled');
});

// ---------- Submit profile for verification ----------
document.getElementById('submitProfileBtn').addEventListener('click', async () => {
  const name = document.getElementById('nameInput').value.trim();
  const email = document.getElementById('emailInput').value.trim();
  const cnic = document.getElementById('cnicInput').value.trim();
  const specialty = document.getElementById('specialtyInput').value;
  const vehicleType = document.getElementById('mechVehicleTypeInput').value;
  const vehicleName = document.getElementById('mechVehicleNameInput').value.trim();
  const vehicleModel = document.getElementById('mechVehicleModelInput').value.trim();
  const vehicleColour = document.getElementById('mechVehicleColourInput').value.trim();
  const vehicleReg = document.getElementById('mechVehicleRegInput').value.trim();

  if (!name || !email || !cnic) { alert('Please fill in all fields'); return; }
  if (!vehicleType || !vehicleName || !vehicleModel || !vehicleColour || !vehicleReg) { alert('Please fill in all vehicle details'); return; }
  if (!cnicPhotoFile || !profilePhotoFile || !licensePhotoFile) { alert('Please upload CNIC, profile photo, and driving licence'); return; }

  const btn = document.getElementById('submitProfileBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';

  try {
    // Upload all three images to Cloudinary
    const [cnicUrl, profileUrl, licenseUrl] = await Promise.all([
      uploadToCloudinary(cnicPhotoFile),
      uploadToCloudinary(profilePhotoFile),
      uploadToCloudinary(licensePhotoFile)
    ]);

    // Attach email to the Firebase Auth account and send verification email
    const user = auth.currentUser;
    try {
      await user.updateEmail(email);
      await user.sendEmailVerification();
    } catch (emailErr) {
      // Non-fatal — profile still saves, admin can see unverified email
      console.warn('Email step failed, continuing:', emailErr.message);
    }

    await db.collection('mechanics').doc(user.uid).set({
      name, email, cnic, specialty,
      phone: user.phoneNumber,
      cnicPhotoUrl: cnicUrl,
      profilePhotoUrl: profileUrl,
      licensePhotoUrl: licenseUrl,
      vehicleType, vehicleName, vehicleModel, vehicleColour, vehicleReg,
      emailVerified: false,
      verificationStatus: 'pending', // pending -> approved / rejected
      isOnline: false,
      rating: 5.0,
      jobsCompleted: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    showScreen('pending');
  } catch (err) {
    console.error(err);
    alert('Something went wrong: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit for Verification';
  }
});

// ---------- Dashboard ----------
async function initDashboard(mechData) {
  fareSettings = await loadFareSettings();
  updateWalletDisplay(mechData);
  if (mechData.commissionLocked) {
    showCommissionLock(mechData.pendingCommission || 0);
  }
  const toggle = document.getElementById('availabilityToggle');
  const knob = document.getElementById('rockerKnob');
  const sub = document.getElementById('availabilitySub');

  toggle.checked = !!mechData.isOnline;
  knob.textContent = toggle.checked ? 'ON' : 'OFF';
  sub.textContent = toggle.checked ? 'Currently online — receiving jobs' : 'Currently offline';

  toggle.addEventListener('change', async () => {
    const currentMechData = (await db.collection('mechanics').doc(currentMechanicId).get()).data() || {};
    if (toggle.checked && currentMechData.commissionLocked) {
      toggle.checked = false;
      showCommissionLock(currentMechData.pendingCommission || 0);
      return;
    }
    knob.textContent = toggle.checked ? 'ON' : 'OFF';
    sub.textContent = toggle.checked ? 'Currently online — receiving jobs' : 'Currently offline';

    if (toggle.checked) {
      await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => { mechanicLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; resolve(); },
          () => resolve(),
          { timeout: 8000 }
        );
      });
      startWatchingLocation();
    } else {
      stopWatchingLocation();
    }

    await db.collection('mechanics').doc(currentMechanicId).update({
      isOnline: toggle.checked,
      ...(mechanicLocation ? { location: mechanicLocation } : {})
    });

    if (toggle.checked) listenForJobs(); else stopListeningForJobs();
  });

  // ---------- Continuous live location tracking ----------
  function startWatchingLocation() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        mechanicLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };

        if (currentActiveJobId && currentJobLocation) checkArrival();

        const now = Date.now();
        if (now - lastFirestoreWrite < 6000) return; // throttle writes to every 6s
        lastFirestoreWrite = now;

        db.collection('mechanics').doc(currentMechanicId).update({ location: mechanicLocation });

        if (currentActiveJobId) {
          db.collection('requests').doc(currentActiveJobId).update({ mechanicLocation });
          if (activeJobMap) addOrUpdateMarker(activeJobMap, activeJobMarkers, 'mechanic', mechanicLocation);
        }
      },
      (err) => console.warn('watchPosition error:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }

  function stopWatchingLocation() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  loadTodayStats();
}

const noJobsStateEl = document.getElementById('noJobsState');

function listenForJobs() {
  const listEl = document.getElementById('jobList');
  const emptyState = noJobsStateEl;

  jobsListenerUnsub = db.collection('requests')
    .where('status', '==', 'searching')
    .onSnapshot((snapshot) => {
      listEl.innerHTML = '';

      // Filter to jobs within MAX_DISTANCE_KM, calculate distance, sort nearest first
      const expiryMs = (fareSettings?.requestExpiryMinutes || 2) * 60 * 1000;
      let nearbyJobs = snapshot.docs
        .map(doc => {
          const job = doc.data();
          let distanceKm = null;
          if (mechanicLocation && job.location) {
            distanceKm = getDistanceKm(mechanicLocation, job.location);
          }
          return { id: doc.id, job, distanceKm };
        })
        .filter(item => item.distanceKm === null || item.distanceKm <= MAX_DISTANCE_KM)
        .filter(item => {
          const createdMs = item.job.createdAt?.toDate ? item.job.createdAt.toDate().getTime() : Date.now();
          return (Date.now() - createdMs) < expiryMs;
        })
        .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));

      // Sound + vibration alert only for NEW jobs within NOTIFY_RADIUS_KM (5km)
      nearbyJobs.forEach(item => {
        if (item.distanceKm !== null && item.distanceKm <= NOTIFY_RADIUS_KM && !notifiedJobIds.has(item.id)) {
          notifiedJobIds.add(item.id);
          playNewJobAlert();
        }
      });

      if (nearbyJobs.length === 0) {
        listEl.appendChild(emptyState);
        return;
      }

      nearbyJobs.forEach(({ id, job, distanceKm }) => {
        const distanceLabel = distanceKm !== null
          ? `${distanceKm.toFixed(1)} km away`
          : 'Distance unavailable';

        const calcFare = distanceKm !== null && fareSettings
          ? calculateFare(fareSettings, distanceKm, job.problem, job.extras || {}, job.surgeMultiplier || 1, job.fareMultiplier || 1)
          : (job.estimatedFare || 0);
        const proposedFare = Math.round(calcFare * 1.10);

        const ticket = document.createElement('div');
        ticket.className = 'ticket';
        ticket.innerHTML = `
          <div class="ticket-id mono">JOB-${id.slice(0, 6).toUpperCase()}</div>
          <div class="ticket-problem">${job.problem}</div>
          <div class="ticket-distance">${job.vehicleType || ''} ${job.vehicleModel || ''} · Plate: ${job.vehiclePlate || '—'}</div>
          <div class="ticket-distance">${distanceLabel} · Fare: Rs ${calcFare}</div>
          <div class="ticket-actions">
            <button class="btn btn-accept" data-id="${id}">Accept Rs ${calcFare}</button>
            <button class="btn btn-ghost" data-id="${id}" data-propose="${proposedFare}">Propose Rs ${proposedFare}</button>
            <button class="btn btn-reject" data-id="${id}">Reject</button>
          </div>`;
        listEl.appendChild(ticket);

        ticket.querySelector('.btn-accept').addEventListener('click', () => acceptJob(id, job, calcFare));
        ticket.querySelector('[data-propose]').addEventListener('click', async () => {
          await db.collection('requests').doc(id).update({
            counterOffer: { mechanicId: currentMechanicId, amount: proposedFare, createdAt: firebase.firestore.FieldValue.serverTimestamp() }
          });
          alert('Offer sent to customer — waiting for their approval.');
        });
        ticket.querySelector('.btn-reject').addEventListener('click', () => ticket.remove());
      });
    });
}

function stopListeningForJobs() {
  if (jobsListenerUnsub) jobsListenerUnsub();
  document.getElementById('jobList').innerHTML = '';
  document.getElementById('jobList').appendChild(noJobsStateEl);
}

async function acceptJob(requestId, jobData, agreedFare) {
  await db.collection('requests').doc(requestId).update({
    status: 'accepted',
    mechanicId: currentMechanicId,
    agreedFare: agreedFare || jobData.estimatedFare || 0,
    acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  currentActiveJobId = requestId;
  currentJobLocation = jobData.location;
  stopListeningForJobs();

  document.getElementById('activeJobProblem').textContent = jobData.problem;
  document.getElementById('activeJobPhone').textContent =
    `${jobData.customerPhone || '—'} · ${jobData.vehicleType || ''} ${jobData.vehicleModel || ''} (${jobData.vehiclePlate || '—'})`;
  document.getElementById('activeJobCard').classList.remove('hidden');
  document.getElementById('completeJobBtn').disabled = true;

  activeJobMarkers = {};
  activeJobMap = initMap('activeJobMap', jobData.location, 15);
  addOrUpdateMarker(activeJobMap, activeJobMarkers, 'customer', jobData.location);
  if (mechanicLocation) addOrUpdateMarker(activeJobMap, activeJobMarkers, 'mechanic', mechanicLocation);

  document.getElementById('navigateBtn').href =
    `https://www.google.com/maps/dir/?api=1&destination=${jobData.location.lat},${jobData.location.lng}&travelmode=driving`;

  db.collection('requests').doc(requestId).get().then(doc => {
    const fare = doc.data()?.agreedFare;
    if (fare) document.getElementById('fareInput').value = fare;
  });

  checkArrival();

  // ---------- No-movement watchdog: must move within 2 min of accepting ----------
  acceptLocationSnapshot = mechanicLocation ? { ...mechanicLocation } : null;
  clearTimeout(noMoveTimeoutId);
  noMoveTimeoutId = setTimeout(() => checkMechanicMovement(requestId), 120000);

  // ---------- Listen for this job being cancelled/completed by customer/admin/watchdog ----------
  selfCompletedJob = false;
  if (activeJobUnsub) activeJobUnsub();
  activeJobUnsub = db.collection('requests').doc(requestId).onSnapshot((snap) => {
    const d = snap.data();
    if (!d || currentActiveJobId !== requestId) return;
    if (d.status === 'cancelled') {
      handleJobCancelledExternally(d.cancelReason);
    } else if (d.status === 'completed' && !selfCompletedJob) {
      handleJobCompletedExternally();
    }
  });
}

function handleJobCompletedExternally() {
  if (activeJobUnsub) { activeJobUnsub(); activeJobUnsub = null; }
  clearTimeout(noMoveTimeoutId);

  currentActiveJobId = null;
  currentJobLocation = null;
  activeJobMap = null;
  activeJobMarkers = {};
  document.getElementById('activeJobCard').classList.add('hidden');
  document.getElementById('fareInput').value = '';

  alert('Mechigo admin has marked this job as completed.');
  loadTodayStats();

  const toggle = document.getElementById('availabilityToggle');
  if (toggle && toggle.checked) listenForJobs();
}

async function checkMechanicMovement(requestId) {
  if (currentActiveJobId !== requestId) return; // job already completed/cancelled

  const doc = await db.collection('requests').doc(requestId).get();
  const data = doc.data();
  if (!data || data.status !== 'accepted') return; // no longer in the "on the way" state

  const movedM = (acceptLocationSnapshot && mechanicLocation)
    ? getDistanceKm(acceptLocationSnapshot, mechanicLocation) * 1000
    : 0;

  if (movedM < NO_MOVE_LIMIT_M) {
    await db.collection('requests').doc(requestId).update({ status: 'cancelled', cancelReason: 'mechanic_no_movement' });

    const mechDoc = await db.collection('mechanics').doc(currentMechanicId).get();
    const mechData = mechDoc.data() || {};
    const newRating = Math.max(1, Math.round(((mechData.rating || 5) - 0.3) * 10) / 10);
    await db.collection('mechanics').doc(currentMechanicId).update({ rating: newRating });

    alert("This job was auto-cancelled because you didn't move toward the customer within 2 minutes. Your rating has been reduced.");
    handleJobCancelledExternally('mechanic_no_movement');
  }
}

function handleJobCancelledExternally(reason) {
  if (activeJobUnsub) { activeJobUnsub(); activeJobUnsub = null; }
  clearTimeout(noMoveTimeoutId);

  currentActiveJobId = null;
  currentJobLocation = null;
  activeJobMap = null;
  activeJobMarkers = {};
  document.getElementById('activeJobCard').classList.add('hidden');
  document.getElementById('fareInput').value = '';

  if (reason === 'customer_cancelled') {
    alert('This job was cancelled by the customer.');
  } else if (reason === 'admin_cancelled') {
    alert('This job was cancelled by Mechigo admin.');
  }

  const toggle = document.getElementById('availabilityToggle');
  if (toggle && toggle.checked) listenForJobs();
}

document.getElementById('completeJobBtn').addEventListener('click', async () => {
  if (mechanicLocation && currentJobLocation) {
    const distanceM = getDistanceKm(mechanicLocation, currentJobLocation) * 1000;
    if (distanceM > ARRIVAL_RADIUS_M) { alert("You must be at the customer's pinned location to complete this job."); return; }
  }
  const fare = parseInt(document.getElementById('fareInput').value, 10);
  if (!fare || fare <= 0) { alert('Enter the cash amount received'); return; }

  const btn = document.getElementById('completeJobBtn');
  btn.disabled = true; btn.textContent = 'Completing…';

  try {
    selfCompletedJob = true;
    await db.collection('requests').doc(currentActiveJobId).update({
      status: 'completed',
      fare,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    const mechDoc = await db.collection('mechanics').doc(currentMechanicId).get();
    const mechData = mechDoc.data() || {};
    const commissionPercent = fareSettings?.commissionPercent ?? 15;
    const commissionOwed = Math.round(fare * (commissionPercent / 100));
    const newJobsCompleted = (mechData.jobsCompleted || 0) + 1;

    await db.collection('mechanics').doc(currentMechanicId).update({
      jobsToday: (mechData.jobsToday || 0) + 1,
      earningsToday: (mechData.earningsToday || 0) + fare,
      jobsCompleted: newJobsCompleted,
      pendingCommission: (mechData.pendingCommission || 0) + commissionOwed,
      commissionLocked: true
    });

    const rideMilestone = fareSettings?.rideBonusMilestone || 50;
    if (newJobsCompleted >= rideMilestone && !mechData.rideBonusClaimed) {
      alert(`🎉 Congratulations — you've completed ${rideMilestone} rides! A Rs ${fareSettings?.rideBonusAmount || 1000} bonus is now available to claim in your Wallet.`);
    }
  } catch (err) {
    alert("Couldn't complete the job — make sure you're at the customer's location and try again.");
    btn.disabled = false; btn.textContent = 'Mark Job Complete';
    return;
  }

  if (activeJobUnsub) { activeJobUnsub(); activeJobUnsub = null; }
  clearTimeout(noMoveTimeoutId);

  btn.textContent = 'Mark Job Complete';
  document.getElementById('activeJobCard').classList.add('hidden');
  document.getElementById('fareInput').value = '';
  currentActiveJobId = null;
  currentJobLocation = null;
  activeJobMap = null;
  activeJobMarkers = {};
  loadTodayStats();

  const toggle = document.getElementById('availabilityToggle');
  toggle.checked = false;
  document.getElementById('rockerKnob').textContent = 'OFF';
  document.getElementById('availabilitySub').textContent = 'Currently offline';
  stopListeningForJobs();
  await db.collection('mechanics').doc(currentMechanicId).update({ isOnline: false });

  const freshDoc = await db.collection('mechanics').doc(currentMechanicId).get();
  const freshData = freshDoc.data() || {};
  updateWalletDisplay(freshData);
  showCommissionLock(freshData.pendingCommission || 0);
});

document.getElementById('reportIssueBtn').addEventListener('click', async () => {
  const reason = prompt('Briefly describe the issue:');
  if (!reason || !currentActiveJobId) return;
  await db.collection('disputes').add({
    requestId: currentActiveJobId,
    filedByRole: 'mechanic',
    filedById: currentMechanicId,
    reason,
    status: 'open',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  alert('Reported to Mechigo admin.');
});

async function loadTodayStats() {
  const doc = await db.collection('mechanics').doc(currentMechanicId).get();
  const data = doc.data() || {};
  document.getElementById('statJobsToday').textContent = data.jobsToday || 0;
  document.getElementById('statEarnings').textContent = 'Rs ' + (data.earningsToday || 0);
}

// ---------- Rank system ----------
function getMechanicRank(jobsCompleted) {
  if (jobsCompleted >= 150) return 'General';
  if (jobsCompleted >= 100) return 'Major';
  if (jobsCompleted >= 50) return 'Captain';
  return 'Mechanic';
}

// ---------- Wallet ----------
function updateWalletDisplay(mechData) {
  document.getElementById('walletRank').textContent = getMechanicRank(mechData.jobsCompleted || 0);
  document.getElementById('walletJobsCompleted').textContent = mechData.jobsCompleted || 0;

  const rideMilestone = fareSettings?.rideBonusMilestone || 50;
  const reviewMilestone = fareSettings?.reviewBonusMilestone || 50;

  document.getElementById('rideBonusBox').classList.toggle('hidden',
    !((mechData.jobsCompleted || 0) >= rideMilestone && !mechData.rideBonusClaimed));
  document.getElementById('reviewBonusBox').classList.toggle('hidden',
    !((mechData.positiveReviewCount || 0) >= reviewMilestone && !mechData.reviewBonusClaimed));
}

document.getElementById('walletBtn').addEventListener('click', async () => {
  const doc = await db.collection('mechanics').doc(currentMechanicId).get();
  updateWalletDisplay(doc.data() || {});
  document.getElementById('walletOverlay').classList.remove('hidden');
});

document.getElementById('closeWalletBtn').addEventListener('click', () => {
  document.getElementById('walletOverlay').classList.add('hidden');
  document.getElementById('bankDetailsForm').classList.add('hidden');
});

let pendingBonusType = null;
document.getElementById('claimRideBonusBtn').addEventListener('click', () => {
  pendingBonusType = 'ride';
  document.getElementById('bankDetailsForm').classList.remove('hidden');
});
document.getElementById('claimReviewBonusBtn').addEventListener('click', () => {
  pendingBonusType = 'review';
  document.getElementById('bankDetailsForm').classList.remove('hidden');
});
document.getElementById('cancelBonusClaimBtn').addEventListener('click', () => {
  pendingBonusType = null;
  document.getElementById('bankDetailsForm').classList.add('hidden');
});

document.getElementById('submitBonusClaimBtn').addEventListener('click', async () => {
  const bankName = document.getElementById('bonusBankNameInput').value.trim();
  const accountTitle = document.getElementById('bonusAccountTitleInput').value.trim();
  const accountNumber = document.getElementById('bonusAccountNumberInput').value.trim();
  if (!bankName || !accountTitle || !accountNumber) { alert('Fill in all bank details'); return; }

  const amount = pendingBonusType === 'ride' ? (fareSettings?.rideBonusAmount || 1000) : (fareSettings?.reviewBonusAmount || 1000);

  await db.collection('bonusClaims').add({
    mechanicId: currentMechanicId,
    type: pendingBonusType,
    amount,
    bankName, accountTitle, accountNumber,
    status: 'pending',
    submittedAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  await db.collection('mechanics').doc(currentMechanicId).update(
    pendingBonusType === 'ride' ? { rideBonusClaimed: true } : { reviewBonusClaimed: true }
  );

  alert('Bonus claim submitted — Mechigo will review and send payment within 24 hours.');
  document.getElementById('bankDetailsForm').classList.add('hidden');
  document.getElementById('walletOverlay').classList.add('hidden');
});

// ---------- Commission lock ----------
function showCommissionLock(amountOwed) {
  if (amountOwed <= 0) return;
  document.getElementById('commissionOwedAmount').textContent = amountOwed;
  document.getElementById('commissionLockOverlay').classList.remove('hidden');
}

document.getElementById('submitCommissionBtn').addEventListener('click', async () => {
  const txnId = document.getElementById('commissionTxnInput').value.trim();
  const file = document.getElementById('commissionScreenshotInput').files[0];
  if (!txnId || !file) { alert('Enter transaction ID and upload a screenshot'); return; }

  const btn = document.getElementById('submitCommissionBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';

  try {
    const screenshotUrl = await uploadToCloudinary(file);
    const mechDoc = await db.collection('mechanics').doc(currentMechanicId).get();
    const amount = mechDoc.data()?.pendingCommission || 0;

    await db.collection('commissionSubmissions').add({
      mechanicId: currentMechanicId,
      amount,
      transactionId: txnId,
      screenshotUrl,
      status: 'pending',
      submittedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Submitting unlocks immediately — admin review happens after and doesn't block new jobs,
    // but a rejection later suspends the account (handled in admin panel)
    await db.collection('mechanics').doc(currentMechanicId).update({ commissionLocked: false });

    document.getElementById('commissionLockOverlay').classList.add('hidden');
    document.getElementById('commissionTxnInput').value = '';
    document.getElementById('commissionScreenshotInput').value = '';
    alert('Submitted — you can now accept new jobs. Admin will verify the transaction.');
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit for Approval';
  }
});

// ---------- Auth session safety net ----------
// Keeps currentMechanicId correct even if the page reloads/refreshes after login
// (e.g. Live Server auto-reload while editing files), so writes never go out with a null mechanicId.
auth.onAuthStateChanged((user) => {
  if (user) {
    currentMechanicId = user.uid;
  }
});
