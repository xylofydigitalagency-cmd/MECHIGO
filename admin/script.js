// ============================================
// MECHIGO — Admin Panel Logic
// NOTE: Admin accounts are NOT self-signup. Create them manually in
// Firebase Console → Authentication → Users → Add User (email + password).
// ============================================

const DESKTOP_MIN_WIDTH = 1024;

function checkScreenSize() {
  const isDesktop = window.innerWidth >= DESKTOP_MIN_WIDTH;
  document.getElementById('mobileBlock').style.display = isDesktop ? 'none' : 'flex';
  document.getElementById('loginScreen').style.display = isDesktop
    ? (auth.currentUser ? 'none' : 'flex') : 'none';
}
window.addEventListener('resize', checkScreenSize);
checkScreenSize();

// ---------- Login ----------
document.getElementById('adminLoginBtn').addEventListener('click', async () => {
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => auth.signOut());

auth.onAuthStateChanged((user) => {
  if (user) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminApp').style.display = 'block';
    checkScreenSize();
    initAdminData();
  } else {
    document.getElementById('adminApp').style.display = 'none';
    checkScreenSize();
  }
});

// ---------- Sidebar nav ----------
document.querySelectorAll('.nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-panel]').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('panel-' + item.dataset.panel).classList.add('active');
  });
});

// ---------- Stamp animation on decisions ----------
function showStamp(text, rejected = false) {
  const overlay = document.getElementById('stampOverlay');
  const stampEl = document.getElementById('stampEl');
  stampEl.textContent = text;
  stampEl.classList.toggle('rejected', rejected);
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 900);
}

// ---------- Data listeners ----------
function initAdminData() {
  listenMechanics();
  listenRequests();
  listenSos();
  listenDisputes();
  listenCommissionSubmissions();
  listenBonusClaims();
  loadCommissionSetting();
}

const FARE_SETTING_FIELDS = [
  ['baseArrivalFeeInput', 'baseArrivalFee', 150],
  ['perKmRateInput', 'perKmRate', 25],
  ['punctureExtraInput', 'punctureExtra', 150],
  ['batteryExtraInput', 'batteryExtra', 150],
  ['petrolServiceFeeInput', 'petrolServiceFee', 100],
  ['towingBaseFeeInput', 'towingBaseFee', 400],
  ['towingPerKmRateInput', 'towingPerKmRate', 60],
  ['premiumTowMultiplierInput', 'premiumTowMultiplier', 1.4],
  ['rideBonusAmountInput', 'rideBonusAmount', 1000],
  ['rideBonusMilestoneInput', 'rideBonusMilestone', 50],
  ['reviewBonusAmountInput', 'reviewBonusAmount', 1000],
  ['reviewBonusMilestoneInput', 'reviewBonusMilestone', 50],
  ['requestExpiryMinutesInput', 'requestExpiryMinutes', 2]
];

async function loadCommissionSetting() {
  const doc = await db.collection('settings').doc('global').get();
  const data = doc.data() || {};
  document.getElementById('commissionInput').value = data.commissionPercent ?? 15;
  FARE_SETTING_FIELDS.forEach(([inputId, field, fallback]) => {
    document.getElementById(inputId).value = data[field] ?? fallback;
  });
}

document.getElementById('saveCommissionBtn').addEventListener('click', async () => {
  const value = parseInt(document.getElementById('commissionInput').value, 10);
  if (isNaN(value) || value < 0 || value > 100) { alert('Enter a commission between 0 and 100'); return; }

  const update = { commissionPercent: value };
  for (const [inputId, field] of FARE_SETTING_FIELDS) {
    const num = parseFloat(document.getElementById(inputId).value);
    if (isNaN(num) || num < 0) { alert('All fare fields must be valid positive numbers'); return; }
    update[field] = num;
  }

  await db.collection('settings').doc('global').set(update, { merge: true });
  showStamp('SAVED');
});

function listenDisputes() {
  db.collection('disputes').onSnapshot((snapshot) => {
    const tbody = document.getElementById('disputesTableBody');
    tbody.innerHTML = '';

    snapshot.forEach(doc => {
      const d = doc.data();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">DSP-${doc.id.slice(0, 6).toUpperCase()}</td>
        <td class="mono">${d.requestId ? d.requestId.slice(0, 6).toUpperCase() : '—'}</td>
        <td>${d.filedByRole || '—'}</td>
        <td>${d.reason || '—'}</td>
        <td><span class="badge ${d.status === 'resolved' ? 'badge-approved' : 'badge-pending'}">${d.status}</span></td>
        <td class="row-actions">
          <button class="btn-sm btn-view" data-id="${doc.id}">Mark Resolved</button>
        </td>`;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.collection('disputes').doc(btn.dataset.id).update({ status: 'resolved' });
      });
    });
  });
}

function listenMechanics() {
  db.collection('mechanics').onSnapshot((snapshot) => {
    const tbody = document.getElementById('mechanicsTableBody');
    tbody.innerHTML = '';
    let pendingCount = 0;
    let flaggedCount = 0;

    snapshot.forEach(doc => {
      const m = doc.data();
      if (m.verificationStatus === 'pending') pendingCount++;
      if (m.flagged) flaggedCount++;

      const badgeClass = m.suspended ? 'badge-rejected'
        : m.verificationStatus === 'approved' ? 'badge-approved'
        : m.verificationStatus === 'rejected' ? 'badge-rejected' : 'badge-pending';
      const statusLabel = m.suspended ? 'suspended' : m.verificationStatus;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${m.name || '—'} ${m.flagged ? '⚠️' : ''}</td>
        <td class="mono">${m.phone || '—'}</td>
        <td>${m.specialty || '—'}</td>
        <td>${m.vehicleType || '—'} ${m.vehicleReg ? `· ${m.vehicleReg}` : ''}</td>
        <td>${m.email || '—'} ${m.emailVerified ? '✅' : ''}</td>
        <td class="mono">⭐ ${(m.rating || 5).toFixed(1)}</td>
        <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
        <td>
          ${m.cnicPhotoUrl ? `<a href="${m.cnicPhotoUrl}" target="_blank" style="color:var(--blue);">CNIC</a>` : '—'}
          ${m.profilePhotoUrl ? ` · <a href="${m.profilePhotoUrl}" target="_blank" style="color:var(--blue);">Photo</a>` : ''}
          ${m.licensePhotoUrl ? ` · <a href="${m.licensePhotoUrl}" target="_blank" style="color:var(--blue);">Licence</a>` : ''}
        </td>
        <td class="row-actions">
          ${m.verificationStatus === 'pending' ? `
            <button class="btn-sm btn-approve" data-id="${doc.id}" data-action="approved">Approve</button>
            <button class="btn-sm btn-reject" data-id="${doc.id}" data-action="rejected">Reject</button>
          ` : `
            <button class="btn-sm ${m.suspended ? 'btn-approve' : 'btn-reject'}" data-id="${doc.id}" data-suspend="${!m.suspended}">
              ${m.suspended ? 'Reactivate' : 'Suspend'}
            </button>
          `}
        </td>`;
      tbody.appendChild(tr);
    });

    document.getElementById('statTotalMechanics').textContent = snapshot.size;
    document.getElementById('statPendingVerification').textContent = pendingCount;
    document.getElementById('statFlagged').textContent = flaggedCount;

    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        await db.collection('mechanics').doc(id).update({ verificationStatus: action });
        showStamp(action.toUpperCase(), action === 'rejected');
      });
    });

    tbody.querySelectorAll('button[data-suspend]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const suspend = btn.dataset.suspend === 'true';
        await db.collection('mechanics').doc(id).update({
          suspended: suspend,
          ...(suspend ? { isOnline: false } : {})
        });
        showStamp(suspend ? 'SUSPENDED' : 'REACTIVATED', suspend);
      });
    });
  });
}

function listenRequests() {
  db.collection('requests').onSnapshot((snapshot) => {
    const tbody = document.getElementById('requestsTableBody');
    tbody.innerHTML = '';
    let activeCount = 0;

    snapshot.forEach(doc => {
      const r = doc.data();
      if (['searching', 'accepted', 'in_progress'].includes(r.status)) activeCount++;

      const isActive = ['searching', 'accepted', 'in_progress'].includes(r.status);
      const canComplete = (r.status === 'accepted' || r.status === 'in_progress') && r.mechanicId;
      const knownFare = r.agreedFare || r.estimatedFare || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">JOB-${doc.id.slice(0, 6).toUpperCase()}</td>
        <td>${r.problem || '—'}</td>
        <td class="mono">${r.customerPhone || '—'}</td>
        <td class="mono">${r.mechanicId ? r.mechanicId.slice(0, 6) : '—'}</td>
        <td><span class="badge badge-pending">${r.status}</span></td>
        <td>
          ${canComplete ? `<button class="btn-sm btn-approve" data-complete-id="${doc.id}" data-mechanic-id="${r.mechanicId}" data-known-fare="${knownFare}">Complete</button>` : ''}
          ${isActive ? `<button class="btn-sm btn-reject" data-cancel-id="${doc.id}" data-customer-id="${r.customerId || ''}">Cancel Ride</button>` : ''}
          ${!isActive && !canComplete ? '—' : ''}
        </td>`;
      tbody.appendChild(tr);
    });

    document.getElementById('statActiveRequests').textContent = activeCount;

    tbody.querySelectorAll('button[data-cancel-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this ride? The customer and mechanic will both be notified.')) return;
        const requestId = btn.dataset.cancelId;
        await db.collection('requests').doc(requestId).update({ status: 'cancelled', cancelReason: 'admin_cancelled' });
        showStamp('CANCELLED', true);
      });
    });

    tbody.querySelectorAll('button[data-complete-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        adminCompleteRequest(btn.dataset.completeId, btn.dataset.mechanicId, btn.dataset.knownFare);
      });
    });
  });
}

async function adminCompleteRequest(requestId, mechanicId, knownFare) {
  const suggestedFare = parseInt(knownFare, 10) || 0;
  const fareInput = prompt(
    'Confirm the final fare amount (Rs) for this job — this is the amount the customer and mechanic agreed on:',
    suggestedFare > 0 ? String(suggestedFare) : ''
  );
  if (fareInput === null) return; // admin pressed Cancel
  const fare = parseInt(fareInput, 10);
  if (!fare || fare <= 0) { alert('Enter a valid fare amount'); return; }
  if (!confirm(`Mark this job as completed with fare Rs ${fare}?`)) return;

  await db.collection('requests').doc(requestId).update({
    status: 'completed',
    fare,
    completedAt: firebase.firestore.FieldValue.serverTimestamp(),
    completedBy: 'admin'
  });

  if (mechanicId) {
    const settingsDoc = await db.collection('settings').doc('global').get();
    const commissionPercent = settingsDoc.data()?.commissionPercent ?? 15;
    const mechDoc = await db.collection('mechanics').doc(mechanicId).get();
    const mechData = mechDoc.data() || {};
    const commissionOwed = Math.round(fare * (commissionPercent / 100));

    await db.collection('mechanics').doc(mechanicId).update({
      jobsToday: (mechData.jobsToday || 0) + 1,
      earningsToday: (mechData.earningsToday || 0) + fare,
      jobsCompleted: (mechData.jobsCompleted || 0) + 1,
      pendingCommission: (mechData.pendingCommission || 0) + commissionOwed,
      commissionLocked: true
    });
  }

  showStamp('COMPLETED');
}

function listenSos() {
  db.collection('sos_alerts').onSnapshot((snapshot) => {
    const tbody = document.getElementById('sosTableBody');
    tbody.innerHTML = '';
    let openCount = 0;

    snapshot.forEach(doc => {
      const s = doc.data();
      if (s.status === 'open') openCount++;
      const loc = s.location ? `${s.location.lat.toFixed(4)}, ${s.location.lng.toFixed(4)}` : '—';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">SOS-${doc.id.slice(0, 6).toUpperCase()}</td>
        <td class="mono">${s.customerId ? s.customerId.slice(0, 8) : '—'}</td>
        <td class="mono">${loc}</td>
        <td><span class="badge ${s.status === 'open' ? 'badge-pending' : 'badge-approved'}">${s.status}</span></td>
        <td class="row-actions">
          <button class="btn-sm btn-view" data-id="${doc.id}">Mark Resolved</button>
        </td>`;
      tbody.appendChild(tr);
    });

    document.getElementById('statOpenSos').textContent = openCount;

    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.collection('sos_alerts').doc(btn.dataset.id).update({ status: 'resolved' });
      });
    });
  });
}

function listenCommissionSubmissions() {
  db.collection('commissionSubmissions').onSnapshot(async (snapshot) => {
    const tbody = document.getElementById('commissionsTableBody');
    tbody.innerHTML = '';

    for (const doc of snapshot.docs) {
      const c = doc.data();
      const mechDoc = await db.collection('mechanics').doc(c.mechanicId).get();
      const mechName = mechDoc.data()?.name || c.mechanicId.slice(0, 8);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${mechName}</td>
        <td class="mono">Rs ${c.amount}</td>
        <td class="mono">${c.transactionId || '—'}</td>
        <td>${c.screenshotUrl ? `<a href="${c.screenshotUrl}" target="_blank" style="color:var(--blue);">View</a>` : '—'}</td>
        <td><span class="badge ${c.status === 'approved' ? 'badge-approved' : c.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}">${c.status}</span></td>
        <td class="row-actions">
          ${c.status === 'pending' ? `
            <button class="btn-sm btn-approve" data-id="${doc.id}" data-action="approved">Approve</button>
            <button class="btn-sm btn-reject" data-id="${doc.id}" data-action="rejected" data-mechanic="${c.mechanicId}">Reject</button>
          ` : '—'}
        </td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        await db.collection('commissionSubmissions').doc(id).update({ status: action });

        if (action === 'rejected' && btn.dataset.mechanic) {
          await db.collection('mechanics').doc(btn.dataset.mechanic).update({ suspended: true, isOnline: false });
        }
        showStamp(action.toUpperCase(), action === 'rejected');
      });
    });
  });
}

function listenBonusClaims() {
  db.collection('bonusClaims').onSnapshot(async (snapshot) => {
    const tbody = document.getElementById('bonusesTableBody');
    tbody.innerHTML = '';

    for (const doc of snapshot.docs) {
      const b = doc.data();
      const mechDoc = await db.collection('mechanics').doc(b.mechanicId).get();
      const mechName = mechDoc.data()?.name || b.mechanicId.slice(0, 8);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${mechName}</td>
        <td>${b.type === 'ride' ? 'Ride Milestone' : 'Review Milestone'}</td>
        <td class="mono">Rs ${b.amount}</td>
        <td class="mono">${b.bankName || '—'} · ${b.accountTitle || '—'} · ${b.accountNumber || '—'}</td>
        <td><span class="badge ${b.status === 'paid' ? 'badge-approved' : 'badge-pending'}">${b.status}</span></td>
        <td class="row-actions">
          ${b.status === 'pending' ? `<button class="btn-sm btn-approve" data-id="${doc.id}">Mark Paid</button>` : '—'}
        </td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.collection('bonusClaims').doc(btn.dataset.id).update({ status: 'paid' });
        showStamp('PAID');
      });
    });
  });
}
