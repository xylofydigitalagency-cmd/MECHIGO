const LOCATIONIQ_TOKEN = "pk.2231a7e4483ae6e7ee25e1afbc6faeda";

function initMap(elementId, center = { lat: 33.6844, lng: 73.0479 }, zoom = 14) {
  const map = L.map(elementId).setView([center.lat, center.lng], zoom);
  L.tileLayer(`https://tiles.locationiq.com/v3/streets/r/{z}/{x}/{y}.png?key=${LOCATIONIQ_TOKEN}`, {
    attribution: '&copy; <a href="https://locationiq.com">LocationIQ</a> &copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);
  return map;
}

function addOrUpdateMarker(map, markerStore, id, location, options = {}) {
  const latlng = [location.lat, location.lng];
  if (markerStore[id]) {
    markerStore[id].setLatLng(latlng);
  } else {
    markerStore[id] = L.marker(latlng, options).addTo(map);
  }
  return markerStore[id];
}

async function searchAddress(query, biasLocation = null) {
  if (!query || query.trim().length < 3) return [];
  let url = `https://api.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_TOKEN}&q=${encodeURIComponent(query)}&countrycodes=pk&limit=8&format=json`;
  if (biasLocation) {
    // Bias results to within roughly a 30km box around the user's current area,
    // instead of searching all of Pakistan with equal weight — this is what
    // was causing "Naseerabad Street 24" to match unrelated places elsewhere.
    const box = 0.27; // ~30km in degrees at Pakistan's latitude
    const west = biasLocation.lng - box;
    const north = biasLocation.lat + box;
    const east = biasLocation.lng + box;
    const south = biasLocation.lat - box;
    url += `&viewbox=${west},${north},${east},${south}&bounded=0`;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(item => ({
      label: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon)
    }));
  } catch (err) {
    console.error('LocationIQ search failed:', err);
    return [];
  }
}