let currentRunId = null;
let pollTimer = null;

// Canvas simulation state
let canvas, ctx;
let canvasWidth = 520;
let canvasHeight = 320;
let lastTimestamp = 0;
let vehiclesOnCanvas = [];
let currentPhaseLabel = "";
let lastLaneTotals = [0, 0, 0, 0];
let throughputHistory = [];
let startBtnEl = null;
let stopBtnEl = null;
let logViewEl = null;
const insightElems = {
  busiest: null,
  dominant: null,
  throughput: null,
  tip: null,
};

const VEHICLE_LABELS = {
  car: "Car",
  bus: "Bus",
  truck: "Truck",
  rickshaw: "Rickshaw",
  bike: "Bike",
};

const DEFAULT_TIP = "Monitor lane flow to keep the intersection balanced.";

function resetVisualState() {
  vehiclesOnCanvas = [];
  currentPhaseLabel = "";
  lastLaneTotals = [0, 0, 0, 0];
  throughputHistory = [];
  applyDefaultInsights();
}

function initCanvas() {
  canvas = document.getElementById("simCanvas");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  canvasWidth = canvas.width;
  canvasHeight = canvas.height;
  resetVisualState();
  requestAnimationFrame(drawFrame);
}

function applyDefaultInsights() {
  if (!insightElems.busiest) return;
  insightElems.busiest.textContent = "—";
  insightElems.dominant.textContent = "—";
  insightElems.throughput.textContent = "—";
  insightElems.tip.textContent = DEFAULT_TIP;
}

function updateInsights(lanes = {}, laneDetails = {}, stats = {}) {
  if (!insightElems.busiest) return;

  const entries = Object.entries(lanes || {}).map(([lane, count]) => ({
    lane: Number(lane),
    count: Number(count),
  }));
  const activeEntries = entries.filter((entry) => Number.isFinite(entry.lane) && entry.count > 0);

  let busiestLane = null;
  if (activeEntries.length) {
    const busiest = activeEntries.reduce((max, item) => (item.count > max.count ? item : max), activeEntries[0]);
    busiestLane = busiest.lane;
    insightElems.busiest.textContent = `Lane ${busiest.lane} (${busiest.count})`;
  } else {
    insightElems.busiest.textContent = "—";
  }

  const totals = { car: 0, bus: 0, truck: 0, rickshaw: 0, bike: 0 };
  Object.values(laneDetails || {}).forEach((detail = {}) => {
    Object.keys(totals).forEach((type) => {
      totals[type] += Number(detail[type] || 0);
    });
  });

  const sortedTypes = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const [topType, topCount] = sortedTypes[0] || [];
  if (topType && topCount > 0) {
    insightElems.dominant.textContent = `${VEHICLE_LABELS[topType]} (${topCount})`;
  } else {
    insightElems.dominant.textContent = "—";
  }

  const throughput = Number(stats.throughput || 0);
  if (!Number.isNaN(throughput)) {
    throughputHistory.push(throughput);
    if (throughputHistory.length > 30) throughputHistory.shift();
  }

  let throughputLabel = "—";
  if (throughputHistory.length === 1) {
    throughputLabel = `${throughputHistory[0].toFixed(2)} veh/unit`;
  } else if (throughputHistory.length >= 2) {
    const current = throughputHistory[throughputHistory.length - 1];
    const previous = throughputHistory[throughputHistory.length - 2];
    const delta = current - previous;
    if (Math.abs(delta) < 0.05) {
      throughputLabel = `Stable (${current.toFixed(2)})`;
    } else if (delta > 0) {
      throughputLabel = `Rising ↑ (${current.toFixed(2)})`;
    } else {
      throughputLabel = `Falling ↓ (${current.toFixed(2)})`;
    }
  }
  insightElems.throughput.textContent = throughputLabel;

  const density = Number(stats.traffic_density || 0);
  const avgWait = Number(stats.average_wait || 0);
  let tip = DEFAULT_TIP;

  if (density >= 80) {
    tip = "Trigger congestion management: extend relief phases and publish detours.";
  } else if (avgWait >= 20) {
    tip = "Average wait is high—tighten cycle length and bias towards the busiest lane.";
  } else if (topType === "bus" && topCount > 0) {
    tip = "Transit-heavy demand detected—enable bus priority for smoother headways.";
  } else if (topType === "truck" && topCount > 0) {
    tip = "Freight surge in progress—schedule freight-friendly greens to clear queues.";
  } else if (busiestLane) {
    tip = `Balance flow: Lane ${busiestLane} is leading counts right now.`;
  }

  insightElems.tip.textContent = tip;
}

function drawIntersectionBackground() {
  if (!ctx) return;
  const w = canvasWidth;
  const h = canvasHeight;
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#111827";
  const roadWidth = 70;
  ctx.fillRect(w / 2 - roadWidth / 2, 0, roadWidth, h);
  ctx.fillRect(0, h / 2 - roadWidth / 2, w, roadWidth);

  ctx.strokeStyle = "#4b5563";
  ctx.lineWidth = 2;
  ctx.strokeRect(w / 2 - 45, h / 2 - 45, 90, 90);
}

function drawSignals() {
  if (!ctx) return;
  const w = canvasWidth;
  const h = canvasHeight;
  const colors = ["#4b5563", "#4b5563", "#4b5563", "#4b5563"];

  if (currentPhaseLabel.includes("GREEN TS")) {
    const idx = parseInt(currentPhaseLabel.split("GREEN TS")[1], 10) || 1;
    colors[idx - 1] = "#22c55e";
  } else if (currentPhaseLabel.includes("YELLOW TS")) {
    const idx = parseInt(currentPhaseLabel.split("YELLOW TS")[1], 10) || 1;
    colors[idx - 1] = "#eab308";
  }

  const positions = [
    { x: w / 2 - 20, y: h / 2 - 70 },
    { x: w / 2 + 70, y: h / 2 - 20 },
    { x: w / 2 + 20, y: h / 2 + 70 },
    { x: w / 2 - 70, y: h / 2 + 20 },
  ];

  positions.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = colors[i];
    ctx.fill();
  });
}

function drawLaneLabels() {
  if (!ctx) return;
  ctx.fillStyle = "#a5f3fc";
  ctx.font = "12px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";

  ctx.fillText("Lane 3", canvasWidth / 2, 22);
  ctx.fillText("Lane 1", canvasWidth / 2, canvasHeight - 10);

  ctx.textAlign = "left";
  ctx.fillText("Lane 2", canvasWidth - 135, canvasHeight / 2 - 12);

  ctx.textAlign = "right";
  ctx.fillText("Lane 4", 135, canvasHeight / 2 + 24);

  ctx.textAlign = "center";
}

function drawLaneNumbers() {
  if (!ctx) return;
  const markers = [
    { lane: 1, x: canvasWidth / 2 - 15, y: canvasHeight - 70 },
    { lane: 2, x: canvasWidth - 70, y: canvasHeight / 2 - 15 },
    { lane: 3, x: canvasWidth / 2 - 15, y: 40 },
    { lane: 4, x: 40, y: canvasHeight / 2 - 15 },
  ];

  markers.forEach(({ lane, x, y }) => {
    ctx.fillStyle = "rgba(14, 165, 233, 0.18)";
    ctx.fillRect(x, y, 30, 30);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.45)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, 30, 30);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "12px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(lane), x + 15, y + 19);
  });
}

const VEHICLE_COLORS = {
  car: "#38bdf8",
  bus: "#a855f7",
  truck: "#f97316",
  rickshaw: "#22c55e",
  bike: "#facc15",
};

function spawnVehicle(lane, types = {}) {
  const kindOrder = ["car", "bus", "truck", "rickshaw", "bike"];
  const vehicleType =
    kindOrder.find((type) => (types[type] || 0) > 0) || kindOrder[Math.floor(Math.random() * kindOrder.length)];
  const size = vehicleType === "bus" || vehicleType === "truck" ? 14 : 10;
  const speedBase = 1.3 + Math.random() * 0.7;
  const speed = speedBase * 1.1; // +10%
  if (lane === 1)
    vehiclesOnCanvas.push({ lane, type: vehicleType, x: canvasWidth / 2 - 15, y: canvasHeight, dx: 0, dy: -speed, size });
  if (lane === 2)
    vehiclesOnCanvas.push({ lane, type: vehicleType, x: canvasWidth, y: canvasHeight / 2 - 15, dx: -speed, dy: 0, size });
  if (lane === 3)
    vehiclesOnCanvas.push({ lane, type: vehicleType, x: canvasWidth / 2 + 15, y: 0, dx: 0, dy: speed, size });
  if (lane === 4)
    vehiclesOnCanvas.push({ lane, type: vehicleType, x: 0, y: canvasHeight / 2 + 15, dx: speed, dy: 0, size });
}

function updateCars(deltaMs) {
  const dt = deltaMs * 0.06;

  vehiclesOnCanvas.forEach((vehicle) => {
    vehicle.x += vehicle.dx * dt;
    vehicle.y += vehicle.dy * dt;
  });

  vehiclesOnCanvas = vehiclesOnCanvas.filter(
    (v) => v.x > -40 && v.x < canvasWidth + 40 && v.y > -40 && v.y < canvasHeight + 40
  );
}

function drawCars() {
  if (!ctx) return;
  vehiclesOnCanvas.forEach((vehicle) => {
    ctx.fillStyle = VEHICLE_COLORS[vehicle.type] || "#38bdf8";
    ctx.fillRect(vehicle.x, vehicle.y, vehicle.size, vehicle.size);
  });
}

function drawFrame(timestamp) {
  if (!ctx) return;
  const delta = lastTimestamp ? timestamp - lastTimestamp : 16;
  lastTimestamp = timestamp;

  drawIntersectionBackground();
  updateCars(delta);
  drawCars();
  drawSignals();
  drawLaneLabels();
  drawLaneNumbers();
  requestAnimationFrame(drawFrame);
}

async function startSimulation(event) {
  event.preventDefault();
  if (currentRunId) return;

  const simTime = Number(document.getElementById("simTime").value || 120);
  const minGreen = Number(document.getElementById("minGreen").value || 10);
  const maxGreen = Number(document.getElementById("maxGreen").value || 60);
  startBtnEl = startBtnEl || document.getElementById("startBtn");
  stopBtnEl = stopBtnEl || document.getElementById("stopBtn");
  logViewEl = logViewEl || document.getElementById("logView");

  if (startBtnEl) startBtnEl.disabled = true;
  if (stopBtnEl) stopBtnEl.disabled = true;
  if (logViewEl) logViewEl.textContent = "Starting simulation...\n";

  try {
    const resp = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sim_time: simTime, min_green: minGreen, max_green: maxGreen }),
    });

    if (!resp.ok) {
      if (logViewEl) logViewEl.textContent += `Failed to start simulation: ${resp.statusText}\n`;
      if (startBtnEl) startBtnEl.disabled = false;
      return;
    }

    const data = await resp.json();
    currentRunId = data.run_id;
    resetVisualState();
    if (logViewEl) logViewEl.textContent += `Simulation started (run id: ${currentRunId})\n`;
    if (stopBtnEl) stopBtnEl.disabled = false;

    pollTimer = setInterval(pollStatus, 1000);
  } catch (err) {
    if (logViewEl) logViewEl.textContent += `Error: ${err}\n`;
    if (startBtnEl) startBtnEl.disabled = false;
    if (stopBtnEl) stopBtnEl.disabled = true;
  }
}

function formatLaneTypes(detail = {}) {
  const sequence = ["car", "bus", "truck", "rickshaw", "bike"];
  const chips = sequence
    .filter((type) => Number(detail[type] || 0) > 0)
    .map((type) => {
      const count = detail[type] || 0;
      const color = VEHICLE_COLORS[type];
      return `<span class="lane-chip"><span class="chip-dot" style="background:${color}"></span>${VEHICLE_LABELS[type]} ${count}</span>`;
    });

  if (!chips.length) {
    return '<span class="lane-chip lane-chip--empty">No vehicles yet</span>';
  }

  return chips.join("");
}

async function pollStatus() {
  if (!currentRunId) return;

  logViewEl = logViewEl || document.getElementById("logView");
  const phaseLabel = document.getElementById("phaseLabel");
  const laneElems = [
    document.getElementById("lane1"),
    document.getElementById("lane2"),
    document.getElementById("lane3"),
    document.getElementById("lane4"),
  ];
  const laneTypeElems = [
    document.getElementById("lane1Types"),
    document.getElementById("lane2Types"),
    document.getElementById("lane3Types"),
    document.getElementById("lane4Types"),
  ];
  const totalVehicles = document.getElementById("totalVehicles");
  const totalTime = document.getElementById("totalTime");
  const throughput = document.getElementById("throughput");
  const avgWait = document.getElementById("avgWait");
  const densityLabel = document.getElementById("densityLabel");
  const densityBar = document.getElementById("densityBar");

  try {
    const resp = await fetch(`/api/status/${currentRunId}`);
    if (!resp.ok) throw new Error(resp.statusText);

    const data = await resp.json();
    if (logViewEl) {
      logViewEl.textContent = (data.log || []).join("\n");
      logViewEl.scrollTop = logViewEl.scrollHeight;
    }

    const stats = data.stats || {};
    const lanes = stats.lanes || {};
    const laneDetails = stats.lane_details || {};

    currentPhaseLabel = stats.phase || "";
    phaseLabel.textContent = currentPhaseLabel || "—";

    for (let i = 0; i < 4; i++) {
      const index = i + 1;
      const laneTotal = Number(lanes[index] || 0);
      if (laneElems[i]) laneElems[i].textContent = `${laneTotal} vehicles`;
      if (laneTypeElems[i]) laneTypeElems[i].innerHTML = formatLaneTypes(laneDetails[index]);

      const delta = Math.max(0, laneTotal - lastLaneTotals[i]);
      for (let n = 0; n < delta; n++) spawnVehicle(index, laneDetails[index]);
      lastLaneTotals[i] = laneTotal;
    }

    const totalVeh = Number(stats.total_vehicles || 0);
    const elapsed = Number(stats.total_time || 0);
    const throughputVal = Number(stats.throughput || 0);

    totalVehicles.textContent = totalVeh;
    totalTime.textContent = `${elapsed} s`;
    throughput.textContent = `${throughputVal.toFixed(3)} veh/unit`;
    avgWait.textContent = `${stats.average_wait || 0} sec`;
    densityLabel.textContent = `${stats.traffic_density || 0}%`;
    densityBar.style.width = `${stats.traffic_density || 0}%`;

    updateInsights(lanes, laneDetails, stats);

    if (data.status === "finished" || data.status === "error") {
      clearInterval(pollTimer);
      pollTimer = null;
      currentRunId = null;
      if (startBtnEl) startBtnEl.disabled = false;
      if (stopBtnEl) stopBtnEl.disabled = true;
    }
  } catch (err) {
    if (logViewEl) logViewEl.textContent += `\nPolling error: ${err}\n`;
    clearInterval(pollTimer);
    pollTimer = null;
    currentRunId = null;
    if (startBtnEl) startBtnEl.disabled = false;
    if (stopBtnEl) stopBtnEl.disabled = true;
  }
}

async function stopSimulation() {
  if (!currentRunId) return;
  stopBtnEl = stopBtnEl || document.getElementById("stopBtn");
  startBtnEl = startBtnEl || document.getElementById("startBtn");
  logViewEl = logViewEl || document.getElementById("logView");

  if (stopBtnEl) stopBtnEl.disabled = true;
  try {
    await fetch(`/api/stop/${currentRunId}`, { method: "POST" });
  } catch (err) {
    // Swallow error but log it to console for debugging
    console.error("Failed to stop simulation", err);
  }

  clearInterval(pollTimer);
  pollTimer = null;
  currentRunId = null;
  if (stopBtnEl) stopBtnEl.disabled = true;
  if (startBtnEl) startBtnEl.disabled = false;
  if (logViewEl) {
    logViewEl.textContent += "\nStop requested by user.\n";
    logViewEl.scrollTop = logViewEl.scrollHeight;
  }
}

function init() {
  const form = document.getElementById("run-form");
  startBtnEl = document.getElementById("startBtn");
  stopBtnEl = document.getElementById("stopBtn");
  logViewEl = document.getElementById("logView");
  insightElems.busiest = document.getElementById("insightBusiestLane");
  insightElems.dominant = document.getElementById("insightDominantType");
  insightElems.throughput = document.getElementById("insightThroughput");
  insightElems.tip = document.getElementById("insightTip");
  applyDefaultInsights();
  if (stopBtnEl) stopBtnEl.disabled = true;
  if (form) {
    form.addEventListener("submit", startSimulation);
  }
  if (stopBtnEl) {
    stopBtnEl.addEventListener("click", stopSimulation);
  }
  initCanvas();
}

document.addEventListener("DOMContentLoaded", init);


